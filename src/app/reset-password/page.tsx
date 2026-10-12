import { redirect } from "next/navigation";
import { ResetPasswordForm } from "@/components/auth/reset-password-form";
import { getSessionAmr, requireUser } from "@/lib/auth";
import { MAILBOX_PROOF_METHODS, RECOVERY_WINDOW_SECONDS, authenticatedRecently } from "@/lib/auth/amr";

// Reached through the password-reset e-mail, which signs the user in with a
// recovery session (see /auth/callback and /auth/confirm). Other sessions
// change the password on /account, where the current password is required.
export default async function ResetPasswordPage() {
  const user = await requireUser();
  if (!authenticatedRecently(await getSessionAmr(), RECOVERY_WINDOW_SECONDS, MAILBOX_PROOF_METHODS)) {
    redirect("/account?error=recovery_required");
  }
  return <ResetPasswordForm email={user.email} />;
}
