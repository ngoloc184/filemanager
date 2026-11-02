import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { requireUser } from "@/lib/auth";
import { DocumentEditForm } from "@/components/documents/document-form";

export const metadata: Metadata = { title: "Edit document" };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function EditDocumentPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await requireUser();
  const { id } = await params;
  if (!UUID_RE.test(id)) notFound();
  // keyed, so moving to another document starts with a fresh form
  return <DocumentEditForm key={id} id={id} userId={user.id} />;
}
