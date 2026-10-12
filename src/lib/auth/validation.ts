// Input rules shared by the auth forms (instant feedback) and the server
// actions (the actual check). Pure functions: safe in client and server code.

export const MIN_PASSWORD_LENGTH = 8;
/** bcrypt (used by Supabase Auth) only reads the first 72 bytes. */
export const MAX_PASSWORD_BYTES = 72;
const MAX_EMAIL_LENGTH = 254;

/**
 * Canonical form used everywhere an address is stored or compared:
 * Unicode NFC, surrounding whitespace removed, lower-cased.
 */
export function normalizeEmail(raw: unknown): string {
  if (typeof raw !== "string") return "";
  return raw.normalize("NFC").trim().toLowerCase();
}

const LOCAL_PART = /^[a-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[a-z0-9!#$%&'*+/=?^_`{|}~-]+)*$/;
const DOMAIN_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

/** Validates an already-normalised address (any provider, not only Gmail). */
export function isValidEmail(email: string): boolean {
  if (!email || email.length > MAX_EMAIL_LENGTH) return false;
  const at = email.lastIndexOf("@");
  if (at <= 0 || at !== email.indexOf("@")) return false;

  const local = email.slice(0, at);
  const domain = email.slice(at + 1);
  if (local.length > 64 || !LOCAL_PART.test(local)) return false;

  const labels = domain.split(".");
  if (labels.length < 2) return false;
  if (!labels.every((label) => DOMAIN_LABEL.test(label))) return false;
  return /^[a-z]{2,63}$/.test(labels[labels.length - 1]);
}

export type PasswordRule = {
  id: "length" | "lowercase" | "uppercase" | "digit" | "maxBytes" | "notEmail";
  label: string;
};

export const PASSWORD_RULES: readonly PasswordRule[] = [
  { id: "length", label: `Ít nhất ${MIN_PASSWORD_LENGTH} ký tự` },
  { id: "lowercase", label: "Có chữ thường (a-z)" },
  { id: "uppercase", label: "Có chữ hoa (A-Z)" },
  { id: "digit", label: "Có chữ số (0-9)" },
];

function byteLength(value: string): number {
  return new TextEncoder().encode(value).length;
}

/** Returns the ids of every rule the password breaks (empty = acceptable). */
export function passwordProblems(
  password: string,
  email?: string
): PasswordRule["id"][] {
  const problems: PasswordRule["id"][] = [];
  if (password.length < MIN_PASSWORD_LENGTH) problems.push("length");
  if (!/[a-z]/.test(password)) problems.push("lowercase");
  if (!/[A-Z]/.test(password)) problems.push("uppercase");
  if (!/[0-9]/.test(password)) problems.push("digit");
  if (byteLength(password) > MAX_PASSWORD_BYTES) problems.push("maxBytes");
  if (email && password.trim().toLowerCase() === normalizeEmail(email)) {
    problems.push("notEmail");
  }
  return problems;
}

/** A single user-facing sentence for the first broken password rule. */
export function passwordProblemMessage(
  problems: PasswordRule["id"][]
): string | null {
  if (problems.length === 0) return null;
  if (problems.includes("maxBytes")) {
    return `Mật khẩu quá dài (tối đa ${MAX_PASSWORD_BYTES} byte).`;
  }
  if (problems.includes("notEmail")) {
    return "Mật khẩu không được trùng với địa chỉ email.";
  }
  return `Mật khẩu cần ít nhất ${MIN_PASSWORD_LENGTH} ký tự, gồm chữ thường, chữ hoa và chữ số.`;
}

/** Six to ten digit one-time code from a Supabase e-mail. */
export function normalizeOtp(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const digits = raw.replace(/\s+/g, "");
  return /^\d{6,10}$/.test(digits) ? digits : null;
}
