import "server-only";
import nodemailer, { type Transporter } from "nodemailer";

// Reminder e-mails go out through any SMTP account (company mail, Office 365, Gmail with an app
// password). Configure on the server only:
//   SMTP_HOST, SMTP_PORT (587 by default), SMTP_SECURE ("true" for port 465),
//   SMTP_USER, SMTP_PASS, SMTP_FROM (e.g. "Workflow <workflow@company.com>")

let transport: Transporter | null = null;

export function isMailConfigured(): boolean {
  return !!(process.env.SMTP_HOST && process.env.SMTP_FROM);
}

function getTransport(): Transporter {
  if (!transport) {
    const port = Number(process.env.SMTP_PORT || 587);
    transport = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port,
      secure: process.env.SMTP_SECURE === "true" || port === 465,
      auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } : undefined,
      // a slow mail server must not hold a serverless function until it times out
      connectionTimeout: 10_000,
      greetingTimeout: 10_000,
      socketTimeout: 20_000,
    });
  }
  return transport;
}

/** Sends one e-mail to one address; false (never throws) when the server refused it. */
export async function sendMail(to: string, mail: { subject: string; text: string; html: string }): Promise<boolean> {
  try {
    await getTransport().sendMail({ from: process.env.SMTP_FROM, to, subject: mail.subject, text: mail.text, html: mail.html });
    return true;
  } catch (err) {
    // the address and the server's reply can contain personal data: log the error code only
    console.warn("workflow mail: send failed", (err as { code?: string }).code ?? "error");
    return false;
  }
}
