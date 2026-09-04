import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import RecentClient from "@/components/files/recent-client";

export default async function RecentPage() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();

  if (!user) redirect("/login");

  return <RecentClient user={{ id: user.id, email: user.email ?? undefined }} />;
}
