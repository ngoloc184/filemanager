import type { Metadata } from "next";
import { requireUser } from "@/lib/auth";
import DocumentSettings from "@/components/documents/document-settings";

export const metadata: Metadata = { title: "Document settings" };

export default async function DocumentSettingsPage() {
  await requireUser();
  return <DocumentSettings />;
}
