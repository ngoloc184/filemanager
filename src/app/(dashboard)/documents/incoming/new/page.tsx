import type { Metadata } from "next";
import { requireUser } from "@/lib/auth";
import { DocumentForm } from "@/components/documents/document-form";

export const metadata: Metadata = { title: "Register incoming document" };

/** Clerks (Văn thư) register incoming documents here; others see why they cannot. */
export default async function NewIncomingDocumentPage() {
  const user = await requireUser();
  return <DocumentForm mode="create" direction="incoming" userId={user.id} />;
}
