import ActivityClient from "@/components/files/activity-client";
import { requireUser } from "@/lib/auth";

export default async function ActivityPage() {
  const user = await requireUser();
  return <ActivityClient user={user} />;
}
