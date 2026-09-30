import DashboardLayout from "@/components/dashboard-layout";
import { requireUser } from "@/lib/auth";

export default async function AuthenticatedLayout({
  children,
}: LayoutProps<"/">) {
  const user = await requireUser();
  return <DashboardLayout user={user}>{children}</DashboardLayout>;
}
