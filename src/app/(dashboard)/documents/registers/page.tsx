import type { Metadata } from "next";
import { requireUser } from "@/lib/auth";
import RegistersClient from "@/components/documents/registers-client";

export const metadata: Metadata = { title: "Registers" };

export default async function RegistersPage() {
  const user = await requireUser();
  return <RegistersClient userId={user.id} />;
}
