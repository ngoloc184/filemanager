import type { Metadata } from "next";
import { isAppAdmin, requireAppAdmin } from "@/lib/admin";
import StickersAdminClient from "@/components/admin/stickers/stickers-admin-client";

/** The title names the page for site admins only, so a 404 does not give it away. */
export async function generateMetadata(): Promise<Metadata> {
  return { title: (await isAppAdmin()) ? "Stickers" : "Page not found" };
}

/** Site admins only; everyone else gets a 404. */
export default async function AdminStickersPage() {
  await requireAppAdmin();
  return <StickersAdminClient />;
}
