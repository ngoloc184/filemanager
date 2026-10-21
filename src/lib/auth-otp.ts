// Pure helpers for e-mail OTP sign-up and password reset (unit-tested).

/** Supabase sends 6-digit codes by default (configurable up to 10). */
export const OTP_MIN = 6;
export const OTP_MAX = 10;
export const PASSWORD_MIN = 6;
/** Seconds before "Resend code" is available again. */
export const RESEND_COOLDOWN = 60;

/** Keeps the digits of a pasted or typed code ("123 456", "Code: 123456"). */
export function cleanOtp(raw: string): string {
  return raw.replace(/\D/g, "").slice(0, OTP_MAX);
}

export function isOtpComplete(code: string): boolean {
  return code.length >= OTP_MIN && code.length <= OTP_MAX && /^\d+$/.test(code);
}

export function passwordProblem(password: string, confirm: string): string | null {
  if (password.length < PASSWORD_MIN) return `Password must be at least ${PASSWORD_MIN} characters.`;
  if (password !== confirm) return "Passwords do not match.";
  return null;
}

/**
 * Only same-site paths are allowed after confirming ("/dashboard",
 * "/forgot-password?step=password"); anything else falls back to /dashboard,
 * so the confirm link cannot redirect to another site.
 */
export function safeNext(next: string | null | undefined, fallback = "/dashboard"): string {
  if (!next || !next.startsWith("/") || next.startsWith("//") || next.includes("\\")) return fallback;
  return next;
}

/** Turns Supabase Auth errors into messages users can act on. */
export function authErrorMessage(error: unknown): string {
  const message = (error as { message?: string } | null)?.message ?? "";
  const code = (error as { code?: string } | null)?.code ?? "";
  if (/otp_expired/.test(code) || /expired|invalid.*(token|otp)|token.*(invalid|expired)/i.test(message)) {
    return "The code is wrong or has expired. Check the latest e-mail or send a new code.";
  }
  if (/over_email_send_rate_limit|rate limit|too many/i.test(code + message)) {
    return "Too many e-mails were sent. Please wait a few minutes and try again.";
  }
  if (/email_address_not_authorized|not authorized/i.test(code + message)) {
    return "E-mails can't be sent to this address yet: the server's e-mail service is not configured. Contact the administrator.";
  }
  if (/email_not_confirmed|not confirmed/i.test(code + message)) {
    return "Your e-mail is not confirmed yet. Enter the code we sent you.";
  }
  if (/user_already_exists|already registered/i.test(code + message)) {
    return "This e-mail is already registered. Sign in, or reset your password.";
  }
  if (/weak_password|password should/i.test(code + message)) {
    return message || "This password is too weak.";
  }
  if (/same_password|different from the old/i.test(code + message)) {
    return "Choose a password different from your current one.";
  }
  if (/invalid login credentials/i.test(message)) return "Wrong e-mail or password.";
  return message || "Something went wrong. Please try again.";
}
