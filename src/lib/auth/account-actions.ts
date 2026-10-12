"use server";

import { cookies } from "next/headers";
import { createClient } from "@/lib/supabase/server";
import { RECENT_SIGN_IN_SECONDS, authenticatedRecently, parseAmr } from "@/lib/auth/amr";
import { REMEMBER_COOKIE } from "@/lib/auth/cookie-policy";
import { authErrorCode, authErrorMessage, retryAfterMessage } from "@/lib/auth/errors";
import type { AuthFormState } from "@/lib/auth/form-state";
import { RATE_LIMITS, consumeAll } from "@/lib/auth/rate-limit";
import { rateLimitKey, rateLimitStore } from "@/lib/auth/rate-limit-store";
import { getClientIp, getSiteOrigin } from "@/lib/auth/request-context";
import {
  isValidEmail,
  normalizeEmail,
  passwordProblemMessage,
  passwordProblems,
} from "@/lib/auth/validation";

// Account settings (/account). Each action re-reads the user from Supabase
// Auth: identity always comes from the session, never from the form.

function text(formData: FormData, name: string): string {
  const value = formData.get(name);
  return typeof value === "string" ? value : "";
}

async function signedInUser() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  return { supabase, user };
}

const NOT_SIGNED_IN: AuthFormState = {
  status: "error",
  code: "not_authenticated",
  message: authErrorMessage("session_expired"),
};

async function throttleAccount(userId: string): Promise<AuthFormState | null> {
  const result = await rateLimitStore.hit(
    rateLimitKey("account", userId),
    RATE_LIMITS.accountChanges,
    true
  );
  return result.allowed
    ? null
    : { status: "error", code: "rate_limited", message: retryAfterMessage(result.retryAfterSeconds) };
}

/** Change (or, for Google-only accounts, create) the account password. */
export async function changePasswordAction(
  _previous: AuthFormState,
  formData: FormData
): Promise<AuthFormState> {
  const { supabase, user } = await signedInUser();
  if (!user?.email) return NOT_SIGNED_IN;

  const currentPassword = text(formData, "currentPassword");
  const password = text(formData, "password");
  const confirmPassword = text(formData, "confirmPassword");
  const { data: passwordSet, error: passwordCheckError } = await supabase.rpc(
    "current_user_has_password"
  );
  // If the check fails, assume a password exists so the current one is
  // always required (fail closed).
  const hasPassword = passwordCheckError ? true : Boolean(passwordSet);

  const fieldErrors: AuthFormState["fieldErrors"] = {};
  if (hasPassword && !currentPassword) fieldErrors.currentPassword = "Vui lòng nhập mật khẩu hiện tại.";
  const problem = passwordProblemMessage(passwordProblems(password, user.email));
  if (problem) fieldErrors.password = problem;
  if (password !== confirmPassword) fieldErrors.confirmPassword = "Mật khẩu nhập lại không khớp.";
  if (Object.keys(fieldErrors).length > 0) return { status: "error", fieldErrors };

  const blocked = await throttleAccount(user.id);
  if (blocked) return blocked;

  if (hasPassword) {
    // Re-authenticate with the current password. This also starts a fresh
    // session, which Supabase requires for password changes when
    // "Secure password change" is enabled.
    const email = normalizeEmail(user.email);
    const failureKey = rateLimitKey("signin-fail", email);
    const lock = await rateLimitStore.hit(failureKey, RATE_LIMITS.signInFailures, false);
    if (!lock.allowed) {
      return { status: "error", code: "rate_limited", message: retryAfterMessage(lock.retryAfterSeconds) };
    }
    const { error } = await supabase.auth.signInWithPassword({ email, password: currentPassword });
    if (error) {
      const code = authErrorCode(error);
      if (code === "invalid_credentials") {
        await rateLimitStore.hit(failureKey, RATE_LIMITS.signInFailures, true);
        return { status: "error", code, fieldErrors: { currentPassword: "Mật khẩu hiện tại không đúng." } };
      }
      return { status: "error", code, message: authErrorMessage(error) };
    }
  } else {
    // First password for a Google-only account: require a recent sign-in.
    const { data: claims } = await supabase.auth.getClaims();
    if (!authenticatedRecently(parseAmr(claims?.claims?.amr), RECENT_SIGN_IN_SECONDS)) {
      return {
        status: "error",
        code: "reauthentication_needed",
        message: authErrorMessage("reauthentication_needed"),
      };
    }
  }

  const { error } = await supabase.auth.updateUser({ password });
  if (error) {
    const code = authErrorCode(error);
    const message = authErrorMessage(error);
    return code === "same_password" || code === "weak_password"
      ? { status: "error", code, fieldErrors: { password: message } }
      : { status: "error", code, message };
  }

  return {
    status: "success",
    code: "password_updated",
    message: hasPassword
      ? "Đã đổi mật khẩu. Các thiết bị khác đã được đăng xuất."
      : "Đã tạo mật khẩu. Từ giờ bạn có thể đăng nhập bằng email và mật khẩu.",
  };
}

/** Starts an e-mail change; Supabase Auth applies it once confirmed by e-mail. */
export async function changeEmailAction(
  _previous: AuthFormState,
  formData: FormData
): Promise<AuthFormState> {
  const { supabase, user } = await signedInUser();
  if (!user) return NOT_SIGNED_IN;

  const email = normalizeEmail(formData.get("email"));
  if (!isValidEmail(email)) {
    return { status: "error", fieldErrors: { email: "Vui lòng nhập một địa chỉ email hợp lệ." }, email };
  }
  if (email === normalizeEmail(user.email)) {
    return { status: "error", fieldErrors: { email: "Đây đã là email hiện tại của bạn." }, email };
  }

  const ip = await getClientIp();
  const limit = await consumeAll(rateLimitStore, [
    { key: rateLimitKey("account", user.id), rule: RATE_LIMITS.accountChanges },
    { key: rateLimitKey("mail-ip", ip), rule: RATE_LIMITS.emailIp },
    { key: rateLimitKey("mail-to", email), rule: RATE_LIMITS.emailAddress },
  ]);
  if (!limit.allowed) {
    return { status: "error", code: "rate_limited", message: retryAfterMessage(limit.retryAfterSeconds), email };
  }

  const origin = await getSiteOrigin();
  const { error } = await supabase.auth.updateUser(
    { email },
    { emailRedirectTo: `${origin}/auth/callback?next=${encodeURIComponent("/account?email=updated")}` }
  );
  if (error) {
    const code = authErrorCode(error);
    if (code === "email_exists" || code === "user_already_exists") {
      return {
        status: "error",
        code,
        fieldErrors: { email: "Email này đã thuộc về một tài khoản khác." },
        email,
      };
    }
    return { status: "error", code, message: authErrorMessage(error), email };
  }

  return {
    status: "success",
    code: "check_email",
    email,
    message: `Đã gửi email xác nhận tới ${email}. Email đăng nhập chỉ thay đổi sau khi bạn xác nhận (nếu máy chủ bật xác nhận hai chiều, hãy xác nhận cả ở email hiện tại).`,
  };
}

/** Removes the Google sign-in method, if the account keeps another one. */
export async function unlinkGoogleAction(): Promise<AuthFormState> {
  const { supabase, user } = await signedInUser();
  if (!user) return NOT_SIGNED_IN;

  const blocked = await throttleAccount(user.id);
  if (blocked) return blocked;

  const { data, error } = await supabase.auth.getUserIdentities();
  if (error) return { status: "error", code: authErrorCode(error), message: authErrorMessage(error) };

  const identities = data?.identities ?? [];
  const google = identities.find((identity) => identity.provider === "google");
  if (!google) return { status: "error", code: "identity_not_found", message: authErrorMessage("identity_not_found") };
  if (identities.length < 2) {
    return {
      status: "error",
      code: "single_identity_not_deletable",
      message: authErrorMessage("single_identity_not_deletable"),
    };
  }

  const { error: unlinkError } = await supabase.auth.unlinkIdentity(google);
  if (unlinkError) {
    return { status: "error", code: authErrorCode(unlinkError), message: authErrorMessage(unlinkError) };
  }
  // Refresh the session so its metadata no longer lists Google.
  await supabase.auth.refreshSession();
  return { status: "success", code: "google_unlinked", message: "Đã hủy liên kết tài khoản Google." };
}

/** Revokes every session of this user (all devices), including this one. */
export async function signOutEverywhereAction(): Promise<AuthFormState> {
  const { supabase, user } = await signedInUser();
  if (!user) return { status: "success" };

  const { error } = await supabase.auth.signOut({ scope: "global" });
  const cookieStore = await cookies();
  cookieStore.delete(REMEMBER_COOKIE);
  if (error) {
    for (const { name } of cookieStore.getAll()) {
      if (name.startsWith("sb-") && name.includes("-auth-token")) cookieStore.delete(name);
    }
    return { status: "error", code: authErrorCode(error), message: authErrorMessage(error) };
  }
  return { status: "success" };
}
