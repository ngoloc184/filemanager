import type { Metadata } from "next";
import { requireUser } from "@/lib/auth";
import OrgClient from "@/components/org/org-client";

export const metadata: Metadata = { title: "Company" };

export default async function OrgPage() {
  const user = await requireUser();
  return <OrgClient user={user} />;
}
