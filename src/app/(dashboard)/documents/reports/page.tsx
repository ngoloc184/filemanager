import type { Metadata } from "next";
import { requireUser } from "@/lib/auth";
import DocumentReports from "@/components/documents/document-reports";

export const metadata: Metadata = { title: "Document reports" };

export default async function DocumentReportsPage() {
  const user = await requireUser();
  return <DocumentReports userId={user.id} />;
}
