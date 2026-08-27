import { createClient } from "@/lib/supabase/server";
import DashboardClient from "@/components/dashboard-client";

export default async function DashboardPage() {
  const supabase = await createClient();

  const { data: batches, error } = await supabase
    .from("upload_batches")
    .select(
      `
      *,
      uploaded_files:uploaded_files(*)
    `
    )
    .order("created_at", { ascending: false });

  const { data: { user } } = await supabase.auth.getUser();

  if (error) {
    console.error("Error fetching batches:", error);
  }

  return <DashboardClient initialBatches={batches || []} user={user!} />;
}
