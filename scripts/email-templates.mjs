// Builds the Supabase Auth e-mail settings from supabase/email-templates and
// refuses templates whose button does not lead to the app's /auth/confirm
// with a token hash (the link that works on any device and browser).

import { readFileSync } from "node:fs";
import { join } from "node:path";

export const TEMPLATES = [
  {
    file: "confirm-signup.html",
    subjectField: "mailer_subjects_confirmation",
    contentField: "mailer_templates_confirmation_content",
    subject: "Xác nhận đăng ký tài khoản / Confirm your sign-up",
    type: "email",
  },
  {
    file: "reset-password.html",
    subjectField: "mailer_subjects_recovery",
    contentField: "mailer_templates_recovery_content",
    subject: "Đặt lại mật khẩu / Reset your password",
    type: "recovery",
  },
];

/** Problems that make a template unsuitable (empty array = fine). */
export function templateProblems(html, type) {
  const problems = [];
  const link = new RegExp(`href="\\{\\{ \\.SiteURL \\}\\}/auth/confirm\\?token_hash=\\{\\{ \\.TokenHash \\}\\}&type=${type}&`);
  if (!link.test(html)) problems.push(`needs a button linking to {{ .SiteURL }}/auth/confirm?token_hash={{ .TokenHash }}&type=${type}&…`);
  if (/ConfirmationURL/.test(html)) problems.push("uses {{ .ConfirmationURL }} (works only in the browser that signed up)");
  return problems;
}

/** The PATCH body for /v1/projects/{ref}/config/auth. */
export function buildPayload(dir) {
  const payload = {};
  for (const t of TEMPLATES) {
    const html = readFileSync(join(dir, t.file), "utf8");
    const problems = templateProblems(html, t.type);
    if (problems.length) throw new Error(`${t.file}: ${problems.join("; ")}`);
    payload[t.subjectField] = t.subject;
    payload[t.contentField] = html;
  }
  return payload;
}

/** "https://abcd1234.supabase.co" -> "abcd1234". */
export function projectRefFromUrl(url) {
  const m = /^https:\/\/([a-z0-9]{10,40})\.supabase\.co\/?$/i.exec(String(url ?? "").trim());
  return m ? m[1] : null;
}
