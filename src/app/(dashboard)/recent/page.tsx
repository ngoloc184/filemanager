import RecentClient from "@/components/files/recent-client";
import { requireUser } from "@/lib/auth";

export default async function RecentPage() {
  const user = await requireUser();
  return <RecentClient user={user} />;
}
