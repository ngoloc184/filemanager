# Sign-up confirmation and password reset by e-mail link

* **Sign up** (`/register`): e-mail + password → “Confirm your e-mail” screen
  → the user clicks the link in the e-mail → signed in on the dashboard.
  “Resend e-mail” is available; signing in with an unconfirmed account opens
  the same screen.
* **Forgot password** (`/forgot-password`, link on the sign-in page): e-mail →
  “Check your e-mail” → the link opens “Choose a new password” → signed in
  with the new password. The page never reveals whether an address exists.
* **The link** opens `/auth/confirm`. Opening it changes nothing: the page
  shows one button (“Confirm my e-mail” / “Continue”) that confirms with a
  same-origin POST (`/auth/verify`). This stops other sites from signing a
  visitor into someone else's account by sending them a link, and keeps mail
  scanners that pre-open links from using them up. It understands:
  * the repository's templates: `token_hash` link — works on **any device or
    browser** (recommended);
  * Supabase's default template (`{{ .ConfirmationURL }}`): Supabase verifies
    the address, then redirects with a PKCE `code`, exchanged by
    `/auth/callback` — only in **the browser that asked for the e-mail**.
    Opened elsewhere, the sign-up is still confirmed (“Your e-mail is
    confirmed. Please sign in.”); a password reset must be requested again;
  * Supabase's error redirect (`error_code=otp_expired` …) → a clear message.

## Why the link “does not work” and how to fix it (Supabase dashboard)

1. **Site URL** — Authentication → URL Configuration. New projects use
   `http://localhost:3000`, so links in e-mails lead to *localhost* and the
   browser shows “site can't be reached”. Set it to your deployed address,
   e.g. `https://your-app.vercel.app`.
2. **Redirect URLs** — same page. The app's redirect carries a query string
   (`/auth/confirm?flow=signup&next=…`), so use entries ending in `**`:
   `https://your-app.vercel.app/auth/confirm**` (and
   `http://localhost:3000/**` for development; previews:
   `https://*-<team>.vercel.app/**`). A redirect that does not match falls
   back to the Site URL root and the user is not signed in.
3. **E-mail templates** (recommended) — the repository's templates link to
   `{{ .SiteURL }}/auth/confirm?token_hash={{ .TokenHash }}…`, which works on
   any device. Apply them:

   ```bash
   # Personal Access Token (starts with sbp_): https://supabase.com/dashboard/account/tokens
   SUPABASE_ACCESS_TOKEN=sbp_xxx npm run email:templates
   ```

   or paste them by hand: Authentication → Emails → “Confirm sign up” /
   “Reset password” → the HTML from `supabase/email-templates/` and the
   subjects from `scripts/email-templates.mjs`. Keeping Supabase's default
   templates also works, with the same-browser limit above.
4. **E-mail service** — Supabase's built-in e-mail only delivers to members of
   your Supabase team, about 2 messages per hour. For real users set up SMTP:
   Project Settings → Authentication → SMTP Settings (Resend, SendGrid,
   Brevo, Amazon SES, Gmail app password…).
