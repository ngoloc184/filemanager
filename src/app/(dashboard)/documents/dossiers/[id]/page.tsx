import type { Metadata } from "next";
import { requireUser } from "@/lib/auth";
import DossierDetail from "@/components/documents/dossier-detail";

export const metadata: Metadata = { title: "Dossier" };

export default async function DossierPage({ params }: { params: Promise<{ id: string }> }) {
  await requireUser();
  const { id } = await params;
  return <DossierDetail id={id} />;
}
