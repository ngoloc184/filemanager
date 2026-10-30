import type { Metadata } from "next";
import InviteAccept from "@/components/org/invite-accept";

export const metadata: Metadata = { title: "Invitation" };

// Signed-out visitors never get here: the proxy sends them to
// /login?next=/invite/<token> and sign-in brings them back.
export default async function InvitePage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  return <InviteAccept token={token} />;
}
