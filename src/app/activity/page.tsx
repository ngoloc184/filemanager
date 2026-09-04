import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import ActivityClient from "@/components/files/activity-client";

export default async function ActivityPage() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();

  if (!user) redirect("/login");

  return <ActivityClient user={{ id: user.id, email: user.email ?? undefined }} />;
}
