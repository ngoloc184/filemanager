import type { Metadata } from "next";
import { requireUser } from "@/lib/auth";
import { DocumentDetail } from "@/components/documents/document-detail";

export const metadata: Metadata = { title: "Document" };

export default async function DocumentPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await requireUser();
  const { id } = await params;
  // keyed, so moving to a related document starts with a fresh page state
  return <DocumentDetail key={id} id={id} user={user} />;
}
