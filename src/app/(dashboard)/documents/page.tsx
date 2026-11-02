import type { Metadata } from "next";
import { requireUser } from "@/lib/auth";
import DocumentsInbox from "@/components/documents/documents-inbox";
import { filtersFromSearchParams } from "@/lib/documents/filters";

export const metadata: Metadata = { title: "Documents" };

export default async function DocumentsPage({
  searchParams,
}: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  const user = await requireUser();
  const raw = await searchParams;
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(raw)) {
    for (const item of Array.isArray(value) ? value : value === undefined ? [] : [value]) {
      query.append(key, item);
    }
  }
  // invalid values are dropped here, so the client starts from clean filters
  return <DocumentsInbox user={user} initialFilters={filtersFromSearchParams(query)} />;
}
