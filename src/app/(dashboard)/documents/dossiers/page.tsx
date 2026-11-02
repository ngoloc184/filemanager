import type { Metadata } from "next";
import { requireUser } from "@/lib/auth";
import DossiersClient, { type DossierListFilters } from "@/components/documents/dossiers-client";
import { DOSSIER_STATUSES, type DossierStatus } from "@/lib/documents/dossiers";

export const metadata: Metadata = { title: "Dossiers" };

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

export default async function DossiersPage({
  searchParams,
}: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  await requireUser();
  const raw = await searchParams;

  // invalid values are dropped, so the client starts from clean filters
  const year = first(raw.year);
  const status = first(raw.status);
  const q = first(raw.q);
  const initial: DossierListFilters = {
    year: year === "all" ? "all" : year && /^\d{4}$/.test(year) ? Number(year) : null,
    status: status && (DOSSIER_STATUSES as readonly string[]).includes(status) ? (status as DossierStatus) : "open",
    q: q ? q.slice(0, 100) : "",
    due: first(raw.due) === "1",
  };
  if (status === "all") initial.status = "all";
  return <DossiersClient initialFilters={initial} />;
}
