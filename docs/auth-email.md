# Sign-up and password reset with e-mail codes (OTP)

* **Sign up** (`/register`): e-mail + password → a code is e-mailed → enter
  it → signed in. Signing in with an unconfirmed account sends you to the
  code step (`/register?verify=<email>`, with “Resend code”).
* **Forgot password** (`/forgot-password`, link on the sign-in page): e-mail
  → code + new password → signed in with the new password. The page never
  reveals whether an address has an account.
* **Links still work**: e-mail links land on `/auth/confirm` (token hash or
  PKCE code), which signs the user in and redirects (same-site paths only).

The app calls `signUp` / `resend` / `resetPasswordForEmail` and verifies with
`verifyOtp({ email, token, type: "email" | "recovery" })`.

## Supabase configuration (required)

1. **E-mail service (most important).** Supabase's built-in e-mail only
   delivers to members of your Supabase team and about 2 messages per hour —
   other users get no e-mail at all ("Email address not authorized"). Set up
   your own SMTP: Dashboard → Project Settings → Authentication → **SMTP
   Settings** (e.g. Resend, SendGrid, Amazon SES, Brevo, or Gmail with an app
   password). Then raise the e-mail rate limit under Authentication → Rate
   Limits if needed.
2. **E-mail templates.** Authentication → Emails:
   * “Confirm sign up” → paste `supabase/email-templates/confirm-signup.html`
   * “Reset password” → paste `supabase/email-templates/reset-password.html`

   Both show the code (`{{ .Token }}`) and a fallback link to `/auth/confirm`.
3. **URLs.** Authentication → URL Configuration:
   * **Site URL**: your deployed address, e.g. `https://your-app.vercel.app`
     (not `http://localhost:3000`) — links in e-mails start with it.
   * **Redirect URLs**: add `https://your-app.vercel.app/auth/confirm` (and
     `http://localhost:3000/auth/confirm` for development).
4. **Code settings** (optional): Authentication → Providers → Email: keep
   “Confirm email” on; “Email OTP Length” 6–10 digits (the app accepts both);
   “Email OTP Expiration” e.g. 600 seconds.
