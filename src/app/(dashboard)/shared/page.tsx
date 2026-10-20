import SharedClient from "@/components/files/shared-client";
import { requireUser } from "@/lib/auth";

export default async function SharedPage() {
  const user = await requireUser();
  return <SharedClient userId={user.id} />;
}
