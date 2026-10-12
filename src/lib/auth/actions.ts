"use server";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import {
  MAILBOX_PROOF_METHODS,
  RECOVERY_WINDOW_SECONDS,
  authenticatedRecently,
  parseAmr,
} from "@/lib/auth/amr";
import {
  REMEMBER_COOKIE,
  rememberCookieOptions,
  secureCookies,
} from "@/lib/auth/cookie-policy";
import { authErrorCode, authErrorMessage, retryAfterMessage } from "@/lib/auth/errors";
import type { AuthFormState } from "@/lib/auth/form-state";
import { RATE_LIMITS, consumeAll, type RateLimitResult } from "@/lib/auth/rate-limit";
import { rateLimitKey, rateLimitStore } from "@/lib/auth/rate-limit-store";
import { DEFAULT_AFTER_LOGIN, safeNextPath } from "@/lib/auth/redirect";
import { getClientIp, getSiteOrigin } from "@/lib/auth/request-context";
import {
  isValidEmail,
  normalizeEmail,
  normalizeOtp,
  passwordProblemMessage,
  passwordProblems,
} from "@/lib/auth/validation";

// Every sign-in / sign-up step runs on the server so that rate limiting,
// validation and the HttpOnly session cookies are enforced in one place.

const INVALID_EMAIL = "Vui lòng nhập một địa chỉ email hợp lệ.";
const ACCOUNT_EXISTS =
  "Email này đã được đăng ký. Hãy đăng nhập, hoặc dùng “Quên mật khẩu” nếu bạn không nhớ mật khẩu.";

function text(formData: FormData, name: string): string {
  const value = formData.get(name);
  return typeof value === "string" ? value : "";
}

function throttled(result: RateLimitResult, message?: string): AuthFormState {
  return {
    status: "error",
    code: "rate_limited",
    message: message ?? retryAfterMessage(result.retryAfterSeconds),
  };
}

async function setRememberPreference(remember: boolean) {
  const cookieStore = await cookies();
  if (remember) {
    cookieStore.delete(REMEMBER_COOKIE);
  } else {
    cookieStore.set(REMEMBER_COOKIE, "0", rememberCookieOptions(secureCookies()));
  }
}

/** Where e-mail links and OAuth land; the callback exchanges the code for a session. */
async function callbackUrl(next: string): Promise<string> {
  return `${await getSiteOrigin()}/auth/callback?next=${encodeURIComponent(next)}`;
}

/**
 * Throttles e-mail sending per client IP and per recipient address, shared by
 * every kind of e-mail (magic link, reset, resend, e-mail change).
 */
async function throttleEmail(email: string): Promise<AuthFormState | null> {
  const ip = await getClientIp();
  const result = await consumeAll(rateLimitStore, [
    { key: rateLimitKey("mail-ip", ip), rule: RATE_LIMITS.emailIp },
    { key: rateLimitKey("mail-to", email), rule: RATE_LIMITS.emailAddress },
  ]);
  return result.allowed ? null : throttled(result);
}

// ---------------------------------------------------------------------------
// Sign in with e-mail + password
// ---------------------------------------------------------------------------

export async function signInAction(
  _previous: AuthFormState,
  formData: FormData
): Promise<AuthFormState> {
  const email = normalizeEmail(formData.get("email"));
  const password = text(formData, "password");
  const remember = formData.get("remember") === "on";
  const next = safeNextPath(formData.get("next"));

  const fieldErrors: AuthFormState["fieldErrors"] = {};
  if (!isValidEmail(email)) fieldErrors.email = INVALID_EMAIL;
  if (!password) fieldErrors.password = "Vui lòng nhập mật khẩu.";
  if (Object.keys(fieldErrors).length > 0) {
    return { status: "error", fieldErrors, email };
  }

  const ip = await getClientIp();
  const ipCheck = await rateLimitStore.hit(
    rateLimitKey("signin-ip", ip),
    RATE_LIMITS.signInIp,
    true
  );
  if (!ipCheck.allowed) return throttled(ipCheck);

  // Locks the account (not the person) after repeated wrong passwords.
  const failureKey = rateLimitKey("signin-fail", email);
  const lock = await rateLimitStore.hit(failureKey, RATE_LIMITS.signInFailures, false);
  if (!lock.allowed) {
    return {
      ...throttled(lock),
      message: `Đăng nhập tạm thời bị khóa do nhập sai mật khẩu nhiều lần. Hãy thử lại sau ${Math.ceil(
        lock.retryAfterSeconds / 60
      )} phút hoặc đặt lại mật khẩu.`,
      email,
    };
  }

  await setRememberPreference(remember);
  const supabase = await createClient({ persistent: remember });
  const { error } = await supabase.auth.signInWithPassword({ email, password });

  if (error) {
    const code = authErrorCode(error);
    if (code === "invalid_credentials") {
      await rateLimitStore.hit(failureKey, RATE_LIMITS.signInFailures, true);
    }
    return { status: "error", code, message: authErrorMessage(error), email };
  }

  await rateLimitStore.reset(failureKey);
  redirect(next);
}

// ---------------------------------------------------------------------------
// Sign up with any e-mail address
// ---------------------------------------------------------------------------

async function registerWithPassword(
  email: string,
  password: string,
  metadata?: Record<string, string>
): Promise<AuthFormState> {
  const ip = await getClientIp();
  const limit = await consumeAll(rateLimitStore, [
    { key: rateLimitKey("signup-ip", ip), rule: RATE_LIMITS.signUpIp },
    { key: rateLimitKey("signup-to", email), rule: RATE_LIMITS.emailAddress },
  ]);
  if (!limit.allowed) return throttled(limit);

  await setRememberPreference(true);
  const supabase = await createClient({ persistent: true });
  const { data, error } = await supabase.auth.signUp({
    email,
    password,
    options: {
      emailRedirectTo: await callbackUrl(DEFAULT_AFTER_LOGIN),
      ...(metadata ? { data: metadata } : null),
    },
  });

  if (error) {
    const code = authErrorCode(error);
    if (code === "user_already_exists" || code === "email_exists") {
      return { status: "error", code: "user_already_exists", fieldErrors: { email: ACCOUNT_EXISTS }, email };
    }
    if (code === "weak_password") {
      return { status: "error", code, fieldErrors: { password: authErrorMessage(error) }, email };
    }
    return { status: "error", code, message: authErrorMessage(error), email };
  }

  // With e-mail confirmation enabled, Supabase answers a sign-up for an
  // address that already has a confirmed account with an empty identity list
  // (and sends no e-mail) instead of an error.
  if (data.user && data.user.identities?.length === 0) {
    return { status: "error", code: "user_already_exists", fieldErrors: { email: ACCOUNT_EXISTS }, email };
  }

  if (data.session) {
    // E-mail confirmation is disabled on the Supabase project: signed in.
    redirect(DEFAULT_AFTER_LOGIN);
  }

  return {
    status: "success",
    code: "check_email",
    email,
    message: `Chúng tôi đã gửi email xác minh tới ${email}. Hãy mở liên kết trong email để kích hoạt tài khoản.`,
  };
}

export async function signUpAction(
  _previous: AuthFormState,
  formData: FormData
): Promise<AuthFormState> {
  const email = normalizeEmail(formData.get("email"));
  const password = text(formData, "password");
  const confirmPassword = text(formData, "confirmPassword");

  const fieldErrors: AuthFormState["fieldErrors"] = {};
  if (!isValidEmail(email)) fieldErrors.email = INVALID_EMAIL;
  const problem = passwordProblemMessage(passwordProblems(password, email));
  if (problem) fieldErrors.password = problem;
  if (!confirmPassword) {
    fieldErrors.confirmPassword = "Vui lòng nhập lại mật khẩu.";
  } else if (password !== confirmPassword) {
    fieldErrors.confirmPassword = "Mật khẩu nhập lại không khớp.";
  }
  if (Object.keys(fieldErrors).length > 0) {
    return { status: "error", fieldErrors, email };
  }

  return registerWithPassword(email, password);
}

/** /setup: creates the first account, tagged as admin in user metadata. */
export async function createAdminAction(
  _previous: AuthFormState,
  formData: FormData
): Promise<AuthFormState> {
  const email = normalizeEmail(formData.get("email"));
  const password = text(formData, "password");

  const fieldErrors: AuthFormState["fieldErrors"] = {};
  if (!isValidEmail(email)) fieldErrors.email = INVALID_EMAIL;
  const problem = passwordProblemMessage(passwordProblems(password, email));
  if (problem) fieldErrors.password = problem;
  if (Object.keys(fieldErrors).length > 0) {
    return { status: "error", fieldErrors, email };
  }

  return registerWithPassword(email, password, { role: "admin" });
}

export async function resendConfirmationAction(
  _previous: AuthFormState,
  formData: FormData
): Promise<AuthFormState> {
  const email = normalizeEmail(formData.get("email"));
  if (!isValidEmail(email)) {
    return { status: "error", fieldErrors: { email: INVALID_EMAIL } };
  }

  const blocked = await throttleEmail(email);
  if (blocked) return { ...blocked, email };

  const supabase = await createClient();
  const { error } = await supabase.auth.resend({
    type: "signup",
    email,
    options: { emailRedirectTo: await callbackUrl(DEFAULT_AFTER_LOGIN) },
  });
  const code = error ? authErrorCode(error) : null;
  if (code === "over_email_send_rate_limit" || code === "over_request_rate_limit") {
    return { status: "error", code, message: authErrorMessage(error), email };
  }

  // Same answer whether or not the address needs confirming.
  return {
    status: "success",
    code: "check_email",
    email,
    message: `Nếu ${email} đang chờ xác minh, chúng tôi đã gửi lại email xác minh.`,
  };
}

// ---------------------------------------------------------------------------
// Passwordless: magic link + one-time code
// ---------------------------------------------------------------------------

export async function requestMagicLinkAction(
  _previous: AuthFormState,
  formData: FormData
): Promise<AuthFormState> {
  const email = normalizeEmail(formData.get("email"));
  const next = safeNextPath(formData.get("next"));
  if (!isValidEmail(email)) {
    return { status: "error", fieldErrors: { email: INVALID_EMAIL }, email };
  }

  const blocked = await throttleEmail(email);
  if (blocked) return { ...blocked, email };

  const supabase = await createClient();
  const { error } = await supabase.auth.signInWithOtp({
    email,
    options: {
      // Only registered accounts: typing an address never creates or opens one.
      shouldCreateUser: false,
      emailRedirectTo: await callbackUrl(next),
    },
  });
  const code = error ? authErrorCode(error) : null;
  if (code === "over_email_send_rate_limit" || code === "over_request_rate_limit") {
    return { status: "error", code, message: authErrorMessage(error), email };
  }
  if (code === "network") {
    return { status: "error", code, message: authErrorMessage(error), email };
  }

  // Unknown addresses get the same answer, so the form cannot be used to
  // discover which e-mails have an account.
  return {
    status: "success",
    code: "check_email",
    email,
    message: `Nếu ${email} đã có tài khoản, liên kết đăng nhập sẽ được gửi tới hộp thư trong ít phút.`,
  };
}

export async function verifyEmailCodeAction(
  _previous: AuthFormState,
  formData: FormData
): Promise<AuthFormState> {
  const email = normalizeEmail(formData.get("email"));
  const token = normalizeOtp(formData.get("token"));
  const next = safeNextPath(formData.get("next"));
  if (!isValidEmail(email)) {
    return { status: "error", fieldErrors: { email: INVALID_EMAIL }, email };
  }
  if (!token) {
    return { status: "error", fieldErrors: { token: "Mã xác minh gồm 6 chữ số." }, email };
  }

  const failureKey = rateLimitKey("otp-fail", email);
  const lock = await rateLimitStore.hit(failureKey, RATE_LIMITS.otpFailures, false);
  if (!lock.allowed) return { ...throttled(lock), email };

  const supabase = await createClient();
  // "email" covers both sign-up confirmation codes and sign-in codes.
  const { error } = await supabase.auth.verifyOtp({ email, token, type: "email" });
  if (error) {
    await rateLimitStore.hit(failureKey, RATE_LIMITS.otpFailures, true);
    const code = authErrorCode(error);
    return {
      status: "error",
      code,
      fieldErrors: { token: authErrorMessage(code === "unknown" ? "otp_expired" : error) },
      email,
    };
  }

  await rateLimitStore.reset(failureKey);
  redirect(next);
}

// ---------------------------------------------------------------------------
// Password recovery
// ---------------------------------------------------------------------------

export async function requestPasswordResetAction(
  _previous: AuthFormState,
  formData: FormData
): Promise<AuthFormState> {
  const email = normalizeEmail(formData.get("email"));
  if (!isValidEmail(email)) {
    return { status: "error", fieldErrors: { email: INVALID_EMAIL }, email };
  }

  const blocked = await throttleEmail(email);
  if (blocked) return { ...blocked, email };

  const supabase = await createClient();
  const { error } = await supabase.auth.resetPasswordForEmail(email, {
    redirectTo: await callbackUrl("/reset-password"),
  });
  const code = error ? authErrorCode(error) : null;
  if (code === "over_email_send_rate_limit" || code === "over_request_rate_limit" || code === "network") {
    return { status: "error", code, message: authErrorMessage(error), email };
  }

  return {
    status: "success",
    code: "check_email",
    email,
    message: `Nếu ${email} đã có tài khoản, chúng tôi đã gửi liên kết đặt lại mật khẩu. Liên kết chỉ dùng được một lần.`,
  };
}

/** Sets a new password for the session opened by a recovery link. */
export async function updatePasswordAction(
  _previous: AuthFormState,
  formData: FormData
): Promise<AuthFormState> {
  const password = text(formData, "password");
  const confirmPassword = text(formData, "confirmPassword");

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return { status: "error", code: "not_authenticated", message: authErrorMessage("link_invalid") };
  }
  // Only a session opened from the mailbox (reset link / e-mail code) in the
  // last hour may skip the current password: an unattended signed-in
  // browser must not be enough.
  const { data: claims } = await supabase.auth.getClaims();
  const amr = parseAmr(claims?.claims?.amr);
  if (!authenticatedRecently(amr, RECOVERY_WINDOW_SECONDS, MAILBOX_PROOF_METHODS)) {
    return { status: "error", code: "recovery_required", message: authErrorMessage("recovery_required") };
  }

  const fieldErrors: AuthFormState["fieldErrors"] = {};
  const problem = passwordProblemMessage(passwordProblems(password, user.email));
  if (problem) fieldErrors.password = problem;
  if (password !== confirmPassword) fieldErrors.confirmPassword = "Mật khẩu nhập lại không khớp.";
  if (Object.keys(fieldErrors).length > 0) return { status: "error", fieldErrors };

  const limit = await rateLimitStore.hit(
    rateLimitKey("account", user.id),
    RATE_LIMITS.accountChanges,
    true
  );
  if (!limit.allowed) return throttled(limit);

  // Supabase Auth also signs out every other session of this user.
  const { error } = await supabase.auth.updateUser({ password });
  if (error) {
    const code = authErrorCode(error);
    const message = authErrorMessage(error);
    return code === "same_password" || code === "weak_password"
      ? { status: "error", code, fieldErrors: { password: message } }
      : { status: "error", code, message };
  }

  if (user.email) await rateLimitStore.reset(rateLimitKey("signin-fail", normalizeEmail(user.email)));
  return {
    status: "success",
    code: "password_updated",
    message: "Đã đặt mật khẩu mới. Các phiên đăng nhập khác đã được đăng xuất.",
  };
}

// ---------------------------------------------------------------------------
// Sign out
// ---------------------------------------------------------------------------

/**
 * Revokes this device's refresh token on Supabase Auth and clears the
 * session cookies. The caller then reloads the page to drop in-memory state.
 */
export async function signOutAction(): Promise<AuthFormState> {
  const supabase = await createClient();
  const { error } = await supabase.auth.signOut({ scope: "local" });

  const cookieStore = await cookies();
  cookieStore.delete(REMEMBER_COOKIE);
  if (error) {
    // Supabase could not be reached or the session was already invalid:
    // still drop the credentials from this browser.
    console.warn(`[auth] sign-out could not revoke the session (${authErrorCode(error)}).`);
    for (const { name } of cookieStore.getAll()) {
      if (name.startsWith("sb-") && name.includes("-auth-token")) cookieStore.delete(name);
    }
  }
  return { status: "success" };
}
