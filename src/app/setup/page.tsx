import { redirect } from "next/navigation";

// The old "Create admin" page set user_metadata.role = "admin", which nothing
// reads: there is no app-wide admin. Company admins are the org_admin role of
// an organization, so /setup now just leads to the normal sign-up.
export default function SetupPage() {
  redirect("/register");
}
