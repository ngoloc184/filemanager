import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { requireUser } from "@/lib/auth";
import { DocumentForm } from "@/components/documents/document-form";

export const metadata: Metadata = { title: "New document" };

/** /documents/new?direction=outgoing|internal (default outgoing). */
export default async function NewDocumentPage({
  searchParams,
}: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  const user = await requireUser();
  const { direction: raw } = await searchParams;
  // incoming documents are registered by the clerk on their own page
  if (raw === "incoming") redirect("/documents/incoming/new");
  const direction = raw === "internal" ? "internal" : "outgoing";
  // keyed, so switching direction starts a fresh form
  return <DocumentForm key={direction} mode="create" direction={direction} userId={user.id} />;
}
