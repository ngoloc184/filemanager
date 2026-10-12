// Result shape shared by the auth Server Actions and the forms using them.

export type AuthField =
  | "email"
  | "password"
  | "confirmPassword"
  | "currentPassword"
  | "token";

export type AuthFormState = {
  status: "idle" | "error" | "success";
  message?: string;
  /** Machine-readable outcome the UI can branch on (e.g. "check_email"). */
  code?: string;
  fieldErrors?: Partial<Record<AuthField, string>>;
  /** Normalised address for follow-up steps (resend, code entry). */
  email?: string;
};

export const INITIAL_AUTH_STATE: AuthFormState = { status: "idle" };
