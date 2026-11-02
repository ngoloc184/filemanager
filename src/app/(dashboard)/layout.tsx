import DashboardLayout from "@/components/dashboard-layout";
import { isAppAdmin } from "@/lib/admin";
import { requireUser } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";

/** Whether the user belongs to a company; false when that cannot be read. */
async function belongsToOrg(): Promise<boolean> {
  try {
    const supabase = await createClient();
    const { data, error } = await supabase.rpc("get_my_org");
    return !error && Boolean(data);
  } catch {
    return false;
  }
}

export default async function AuthenticatedLayout({
  children,
}: LayoutProps<"/">) {
  const user = await requireUser();
  const [hasOrg, isAdmin] = await Promise.all([belongsToOrg(), isAppAdmin()]);
  return (
    <DashboardLayout user={user} hasOrg={hasOrg} isAdmin={isAdmin}>
      {children}
    </DashboardLayout>
  );
}
