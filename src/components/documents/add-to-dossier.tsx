"use client";

import { useEffect, useId, useState } from "react";
import Link from "next/link";
import { Check, FolderArchive, FolderPlus, Loader2, Search } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { LegalHoldBadge } from "@/components/documents/dossiers-client";
import { addDocumentToDossier, listDocumentDossiers, listDossiers } from "@/lib/services/dossiers";
import { getMyOrg } from "@/lib/services/org";
import type { DocumentDossier, DossierListItem } from "@/lib/documents/dossiers";
import { DEFAULT_ORG_TIME_ZONE, todayIn } from "@/lib/documents/deadlines";
import { getErrorMessage } from "@/lib/types/database";

// "Add to dossier" for the document page: shows the dossiers that already
// hold the document and files it in an open dossier of the current year.
// The server decides who may file (dossier owner, clerk or admin).

export function AddToDossier({ documentId, onAdded }: { documentId: string; onAdded?: () => void }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button variant="outline" onClick={() => setOpen(true)}>
        <FolderPlus data-icon="inline-start" aria-hidden />
        Add to dossier
      </Button>
      {open && <AddToDossierDialog documentId={documentId} onAdded={onAdded} onOpenChange={setOpen} />}
    </>
  );
}

function AddToDossierDialog({
  documentId,
  onAdded,
  onOpenChange,
}: {
  documentId: string;
  onAdded?: () => void;
  onOpenChange: (open: boolean) => void;
}) {
  const ids = useId();
  const [year, setYear] = useState(() => Number(todayIn(DEFAULT_ORG_TIME_ZONE).slice(0, 4)));
  const [query, setQuery] = useState("");
  const [q, setQ] = useState("");
  const [current, setCurrent] = useState<DocumentDossier[] | null>(null);
  const [results, setResults] = useState<DossierListItem[] | null>(null);
  // separate, so a search that succeeds does not hide why the chips failed
  const [currentError, setCurrentError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filing, setFiling] = useState<string | null>(null);
  const [currentKey, setCurrentKey] = useState(0);

  // the current year in the company's time zone
  useEffect(() => {
    let cancelled = false;
    getMyOrg()
      .then((org) => {
        if (!cancelled && org?.org.timezone) setYear(Number(todayIn(org.org.timezone).slice(0, 4)));
      })
      .catch(() => {
        // keep the default time zone's year
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const handle = window.setTimeout(() => setQ(query.trim()), 300);
    return () => window.clearTimeout(handle);
  }, [query]);

  useEffect(() => {
    let cancelled = false;
    listDocumentDossiers(documentId)
      .then((rows) => {
        if (cancelled) return;
        setCurrent(rows);
        setCurrentError(null);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setCurrent([]);
        setCurrentError(getErrorMessage(err));
      });
    return () => {
      cancelled = true;
    };
  }, [documentId, currentKey]);

  useEffect(() => {
    let cancelled = false;
    listDossiers({ status: "open", year, q })
      .then((rows) => {
        if (cancelled) return;
        setResults(rows);
        setError(null);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setResults([]);
        setError(getErrorMessage(err));
      });
    return () => {
      cancelled = true;
    };
  }, [year, q]);

  const filedIds = new Set((current ?? []).map((d) => d.dossier_id));

  const file = async (dossier: DossierListItem) => {
    if (filing) return;
    setFiling(dossier.id);
    try {
      await addDocumentToDossier(dossier.id, documentId);
      toast.success(`Filed in ${dossier.code}`);
      // the list is not reloaded, so count the new document here
      setResults((rows) =>
        rows ? rows.map((r) => (r.id === dossier.id ? { ...r, doc_count: r.doc_count + 1 } : r)) : rows
      );
      setCurrentKey((k) => k + 1);
      onAdded?.();
    } catch (err) {
      toast.error(getErrorMessage(err));
    } finally {
      setFiling(null);
    }
  };

  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Add to dossier (Lập hồ sơ)</DialogTitle>
          <DialogDescription>
            File this document in an open dossier of {year}. A document can be in more than one dossier.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-2">
          <p className="text-xs font-medium text-muted-foreground" id={`${ids}-current`}>
            In dossiers
          </p>
          {current === null ? (
            <p className="flex items-center gap-2 text-sm text-muted-foreground" role="status">
              <Loader2 className="size-4 animate-spin" aria-hidden />
              Loading…
            </p>
          ) : currentError ? (
            <p className="text-sm text-destructive" role="alert">
              {currentError}
            </p>
          ) : current.length === 0 ? (
            <p className="text-sm text-muted-foreground">Not filed in any dossier yet.</p>
          ) : (
            <ul className="flex flex-wrap gap-1.5" aria-labelledby={`${ids}-current`}>
              {current.map((d) => (
                <li key={d.dossier_id}>
                  <Link
                    href={`/documents/dossiers/${d.dossier_id}`}
                    className="inline-flex max-w-full items-center gap-1 rounded-full border bg-muted/50 px-2 py-0.5 text-xs hover:bg-muted focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none"
                    title={`${d.title} (${d.status})`}
                  >
                    <FolderArchive className="size-3 shrink-0" aria-hidden />
                    <span className="font-mono">{d.code}</span>
                    <span className="max-w-40 truncate text-muted-foreground">{d.title}</span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="space-y-2">
          <Label htmlFor={`${ids}-q`}>Find an open dossier</Label>
          <div className="relative">
            <Search
              className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground"
              aria-hidden
            />
            <Input
              id={`${ids}-q`}
              type="search"
              className="pl-8"
              placeholder="Code or title"
              value={query}
              maxLength={100}
              onChange={(e) => setQuery(e.target.value)}
              autoFocus
            />
          </div>
        </div>

        <div className="max-h-72 min-h-24 overflow-y-auto rounded-lg border" aria-busy={results === null}>
          {results === null ? (
            <p className="flex items-center gap-2 p-3 text-sm text-muted-foreground" role="status">
              <Loader2 className="size-4 animate-spin" aria-hidden />
              Searching…
            </p>
          ) : results.length === 0 ? (
            <p className="p-3 text-sm text-muted-foreground">
              {q ? "No open dossiers match." : `No open dossiers for ${year}.`}{" "}
              <Link href="/documents/dossiers" className="text-primary underline-offset-4 hover:underline">
                Create one
              </Link>
            </p>
          ) : (
            <ul className="divide-y">
              {results.map((d) => {
                const filed = filedIds.has(d.id);
                const busy = filing === d.id;
                return (
                  <li key={d.id} className="flex items-center gap-3 p-2.5">
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-1.5">
                        <span className="font-mono text-xs">{d.code}</span>
                        {d.legal_hold && <LegalHoldBadge />}
                      </div>
                      <p className="text-sm font-medium [overflow-wrap:anywhere]">{d.title}</p>
                      <p className="text-xs text-muted-foreground">
                        {[d.department_name, `${d.doc_count} ${d.doc_count === 1 ? "document" : "documents"}`]
                          .filter(Boolean)
                          .join(" · ")}
                      </p>
                    </div>
                    {filed ? (
                      <Badge variant="secondary" className="shrink-0">
                        <Check data-icon="inline-start" aria-hidden="true" />
                        Filed
                      </Badge>
                    ) : (
                      <Button
                        size="sm"
                        variant="outline"
                        className="shrink-0"
                        onClick={() => void file(d)}
                        disabled={filing !== null || current === null}
                        aria-label={`File in ${d.code} ${d.title}`}
                      >
                        {busy && <Loader2 data-icon="inline-start" className="animate-spin" aria-hidden />}
                        {busy ? "Filing…" : "File here"}
                      </Button>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        {error && (
          <p className="text-sm text-destructive" role="alert">
            {error}
          </p>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Done
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
