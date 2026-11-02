"use client";

import { useEffect, useId, useRef, useState } from "react";
import Link from "next/link";
import {
  Archive,
  ArrowLeft,
  FileArchive,
  FolderArchive,
  FolderOpen,
  Loader2,
  Lock,
  Pencil,
  RotateCcw,
  ShieldAlert,
  ShieldOff,
  Trash2,
} from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
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
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";
import { DepartmentSelect } from "@/components/org/department-select";
import { StatusBadge } from "@/components/documents/doc-badges";
import {
  DossierStatusBadge,
  LegalHoldBadge,
  RetentionSelect,
  TransferDue,
  retentionText,
} from "@/components/documents/dossiers-client";
import {
  closeDossier,
  getDossier,
  removeDocumentFromDossier,
  reopenDossier,
  setDossierLegalHold,
  transferDossier,
  updateDossier,
} from "@/lib/services/dossiers";
import { getDocument, logDocumentAccess } from "@/lib/services/documents";
import { getSignedUrl } from "@/lib/services/files";
import { getMyOrg } from "@/lib/services/org";
import {
  RESTRICTED_DOCUMENT_LABEL,
  transferDueDate,
  type DossierBundle,
  type DossierDetail as DossierInfo,
  type DossierDocument,
} from "@/lib/documents/dossiers";
import {
  MAX_EXPORT_FILE_BYTES,
  dossierZipName,
  packDossierZip,
  pickExportFile,
  planDossierExport,
  skippedSummary,
  type PackedFile,
  type SkippedFile,
} from "@/lib/documents/dossier-export";
import { DEFAULT_ORG_TIME_ZONE, formatDay, todayIn } from "@/lib/documents/deadlines";
import { getErrorMessage } from "@/lib/types/database";
import { cn } from "@/lib/utils";

// The dossier page (hồ sơ): header, details, its documents in order, the
// actions the caller's role allows (edit, close, reopen, transfer, legal
// hold) and the ZIP export. The server checks every action again.

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type Confirm = "reopen" | "transfer" | "hold" | "release";

type ExportProgress = { current: number; total: number; packing: boolean };

export default function DossierDetail({ id }: { id: string }) {
  const [bundle, setBundle] = useState<DossierBundle | null>(null);
  const [error, setError] = useState<string | null>(UUID_RE.test(id) ? null : "Dossier not found");
  const [timeZone, setTimeZone] = useState(DEFAULT_ORG_TIME_ZONE);
  const [reloadKey, setReloadKey] = useState(0);
  const [editing, setEditing] = useState(false);
  const [closing, setClosing] = useState(false);
  const [confirm, setConfirm] = useState<Confirm | null>(null);
  const [removing, setRemoving] = useState<string | null>(null);
  const [progress, setProgress] = useState<ExportProgress | null>(null);
  const cancelExport = useRef(false);

  useEffect(() => {
    if (!UUID_RE.test(id)) return;
    let cancelled = false;
    getDossier(id)
      .then((result) => {
        if (cancelled) return;
        setBundle(result);
        setError(null);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(getErrorMessage(err));
      });
    return () => {
      cancelled = true;
    };
  }, [id, reloadKey]);

  useEffect(() => {
    let cancelled = false;
    getMyOrg()
      .then((org) => {
        if (!cancelled && org?.org.timezone) setTimeZone(org.org.timezone);
      })
      .catch(() => {
        // the default company time zone is good enough for "today"
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // stop a running export when the page goes away
  useEffect(
    () => () => {
      cancelExport.current = true;
    },
    []
  );

  const reload = () => setReloadKey((k) => k + 1);
  const today = todayIn(timeZone);

  const back = (
    <Link href="/documents/dossiers" className={cn(buttonVariants({ variant: "ghost", size: "sm" }), "-ml-2")}>
      <ArrowLeft aria-hidden />
      Dossiers
    </Link>
  );

  if (!bundle) {
    return (
      <div className="max-w-6xl space-y-6">
        {back}
        {error ? (
          <Card className="max-w-xl">
            <CardHeader>
              <CardTitle>{/not found/i.test(error) ? "Dossier not found" : "Could not load the dossier"}</CardTitle>
              <CardDescription>
                {/not found/i.test(error)
                  ? "It does not exist, or you do not have access to it."
                  : error}
              </CardDescription>
            </CardHeader>
            {!/not found/i.test(error) && (
              <CardContent>
                <Button variant="outline" onClick={reload}>
                  Try again
                </Button>
              </CardContent>
            )}
          </Card>
        ) : (
          <div className="flex items-center gap-2 text-sm text-muted-foreground" role="status">
            <Loader2 className="size-4 animate-spin" aria-hidden />
            Loading dossier…
          </div>
        )}
      </div>
    );
  }

  const { dossier, documents } = bundle;
  const ordered = [...documents].sort((a, b) => a.ordinal - b.ordinal);
  const isOpen = dossier.status === "open";
  const canEdit = isOpen && dossier.can_manage;
  const canRemove = isOpen && dossier.can_manage && !dossier.legal_hold;
  const canReopen = dossier.status === "closed" && dossier.is_admin;
  const canTransfer = dossier.status === "closed" && (dossier.is_clerk || dossier.is_admin);
  const exporting = progress !== null;

  const remove = async (documentId: string) => {
    if (removing) return;
    setRemoving(documentId);
    try {
      await removeDocumentFromDossier(dossier.id, documentId);
      toast.success("Removed from the dossier");
      reload();
    } catch (err) {
      toast.error(getErrorMessage(err));
    } finally {
      setRemoving(null);
    }
  };

  const exportZip = async () => {
    if (exporting) return;
    cancelExport.current = false;
    const plan = planDossierExport(dossier, documents);
    const total = plan.items.length;
    const packed: PackedFile[] = [];
    const skipped: SkippedFile[] = [];
    setProgress({ current: 0, total, packing: false });
    try {
      for (const [index, item] of plan.items.entries()) {
        if (cancelExport.current) {
          toast.info("Export cancelled");
          return;
        }
        setProgress({ current: index + 1, total, packing: false });
        const subject = item.document.subject;
        try {
          const doc = await getDocument(item.document.document_id);
          const file = pickExportFile(doc.files);
          if (!file) {
            skipped.push({ ordinal: item.ordinal, name: subject, reason: "No file attached" });
            continue;
          }
          if (Number(file.size) > MAX_EXPORT_FILE_BYTES) {
            skipped.push({ ordinal: item.ordinal, name: file.name, reason: "Over 200 MB" });
            continue;
          }
          // log first, so every file that leaves in the ZIP is in the access log
          await logDocumentAccess(item.document.document_id, "download");
          const url = await getSignedUrl({
            id: file.file_id,
            name: file.name,
            current_version_id: file.current_version_id,
          });
          const response = await fetch(url, { cache: "no-store" });
          if (!response.ok) throw new Error(`Download failed (HTTP ${response.status})`);
          const bytes = new Uint8Array(await response.arrayBuffer());
          if (bytes.byteLength > MAX_EXPORT_FILE_BYTES) {
            skipped.push({ ordinal: item.ordinal, name: file.name, reason: "Over 200 MB" });
            continue;
          }
          packed.push({ ordinal: item.ordinal, name: file.name, bytes });
        } catch (err) {
          skipped.push({ ordinal: item.ordinal, name: subject, reason: getErrorMessage(err) });
        }
      }
      // Cancel pressed while the last file was downloading
      if (cancelExport.current) {
        toast.info("Export cancelled");
        return;
      }

      setProgress({ current: total, total, packing: true });
      // let the "Building the ZIP…" text paint before the synchronous zip
      await new Promise((resolve) => window.setTimeout(resolve, 0));
      const zip = packDossierZip(plan.manifest, packed);
      const blob = new Blob([zip as Uint8Array<ArrayBuffer>], { type: "application/zip" });
      const href = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = href;
      link.download = dossierZipName(dossier.code, dossier.title);
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      window.setTimeout(() => URL.revokeObjectURL(href), 60_000);

      const fileCount = `${packed.length} ${packed.length === 1 ? "file" : "files"}`;
      if (skipped.length > 0) {
        toast.warning(`ZIP downloaded with ${fileCount}; ${skipped.length} skipped`, {
          description: <span className="whitespace-pre-line">{skippedSummary(skipped)}</span>,
          duration: 15_000,
        });
      } else {
        toast.success(`ZIP downloaded with ${fileCount}`);
      }
    } catch (err) {
      toast.error(`Could not build the ZIP: ${getErrorMessage(err)}`);
    } finally {
      setProgress(null);
    }
  };

  const progressText = progress
    ? progress.packing
      ? "Building the ZIP…"
      : progress.total === 0
        ? "Preparing…"
        : `Packing ${progress.current} of ${progress.total}…`
    : "";

  return (
    <div className="max-w-6xl space-y-6">
      <div className="space-y-3">
        {back}
        <div className="flex flex-wrap items-start gap-3">
          <FolderArchive className="mt-1 size-7 shrink-0 text-primary" aria-hidden />
          <div className="min-w-0 flex-1 space-y-1">
            <div className="flex flex-wrap items-center gap-2">
              <Badge variant="outline" className="font-mono" title="Dossier code (ký hiệu hồ sơ)">
                {dossier.code}
              </Badge>
              <span className="text-sm text-muted-foreground">{dossier.year}</span>
              <DossierStatusBadge status={dossier.status} />
              {dossier.legal_hold && <LegalHoldBadge />}
            </div>
            <h2 className="text-2xl font-bold [overflow-wrap:anywhere]">{dossier.title}</h2>
          </div>
        </div>

        <div className="flex flex-wrap gap-2">
          {canEdit && (
            <Button variant="outline" onClick={() => setEditing(true)}>
              <Pencil data-icon="inline-start" aria-hidden />
              Edit
            </Button>
          )}
          {canEdit && (
            <Button variant="outline" onClick={() => setClosing(true)}>
              <Lock data-icon="inline-start" aria-hidden />
              Close dossier
            </Button>
          )}
          {canReopen && (
            <Button variant="outline" onClick={() => setConfirm("reopen")}>
              <RotateCcw data-icon="inline-start" aria-hidden />
              Reopen
            </Button>
          )}
          {canTransfer && (
            <Button onClick={() => setConfirm("transfer")}>
              <Archive data-icon="inline-start" aria-hidden />
              Transfer to archive
            </Button>
          )}
          {dossier.is_admin && (
            <Button
              variant={dossier.legal_hold ? "destructive" : "outline"}
              aria-pressed={dossier.legal_hold}
              onClick={() => setConfirm(dossier.legal_hold ? "release" : "hold")}
            >
              {dossier.legal_hold ? (
                <ShieldOff data-icon="inline-start" aria-hidden />
              ) : (
                <ShieldAlert data-icon="inline-start" aria-hidden />
              )}
              Legal hold{dossier.legal_hold ? ": on" : ""}
            </Button>
          )}
          <Button variant="outline" onClick={() => void exportZip()} disabled={exporting}>
            {exporting ? (
              <Loader2 data-icon="inline-start" className="animate-spin" aria-hidden />
            ) : (
              <FileArchive data-icon="inline-start" aria-hidden />
            )}
            {exporting ? progressText : "Export ZIP"}
          </Button>
          {exporting && !progress?.packing && (
            <Button variant="ghost" onClick={() => (cancelExport.current = true)}>
              Cancel export
            </Button>
          )}
        </div>
        <p className="sr-only" role="status" aria-live="polite">
          {progressText}
        </p>
      </div>

      <MetaGrid dossier={dossier} today={today} />

      <section className="space-y-3" aria-labelledby="dossier-docs-heading">
        <div className="flex flex-wrap items-baseline gap-2">
          <h3 id="dossier-docs-heading" className="text-lg font-semibold">
            Documents
          </h3>
          <span className="text-sm text-muted-foreground">
            {ordered.length} {ordered.length === 1 ? "document" : "documents"}
          </span>
        </div>
        {ordered.length === 0 ? (
          <p className="rounded-lg border border-dashed px-4 py-8 text-center text-sm text-muted-foreground">
            No documents yet. Open a document and use <span className="font-medium">Add to dossier</span> to file
            it here.
          </p>
        ) : (
          <DocumentTable
            documents={ordered}
            canRemove={canRemove}
            removing={removing}
            onRemove={(documentId) => void remove(documentId)}
          />
        )}
      </section>

      {editing && <EditDossierDialog dossier={dossier} onOpenChange={setEditing} onSaved={reload} />}
      {closing && (
        <CloseDossierDialog dossier={dossier} today={today} onOpenChange={setClosing} onClosed={reload} />
      )}
      {confirm && (
        <ConfirmDialog kind={confirm} dossier={dossier} onOpenChange={(open) => !open && setConfirm(null)} onDone={reload} />
      )}
    </div>
  );
}

function MetaGrid({ dossier, today }: { dossier: DossierInfo; today: string }) {
  const retention =
    dossier.retention_code && dossier.retention_label
      ? retentionText(dossier.retention_code, dossier.retention_label, dossier.retention_years)
      : "Not set";
  const items: { label: string; value: React.ReactNode }[] = [
    { label: "Department", value: dossier.department_name ?? "—" },
    { label: "Retention (Thời hạn bảo quản)", value: retention },
    { label: "Owner", value: dossier.owner_name ?? "—" },
    { label: "Start date", value: dossier.start_date ? formatDay(dossier.start_date) : "—" },
    { label: "End date", value: dossier.end_date ? formatDay(dossier.end_date) : "—" },
    {
      label: "Transfer due (Hạn nộp lưu)",
      value: <TransferDue date={dossier.transfer_due_date} status={dossier.status} today={today} />,
    },
  ];
  if (dossier.is_capital_construction) {
    items.push({ label: "Kind", value: "Capital construction (Xây dựng cơ bản)" });
  }
  return (
    <div className="space-y-3 rounded-xl border p-4">
      <dl className="grid gap-x-6 gap-y-3 sm:grid-cols-2 lg:grid-cols-3">
        {items.map((item) => (
          <div key={item.label} className="min-w-0">
            <dt className="text-xs text-muted-foreground">{item.label}</dt>
            <dd className="text-sm [overflow-wrap:anywhere]">{item.value}</dd>
          </div>
        ))}
      </dl>
      {dossier.description && (
        <p className="border-t pt-3 text-sm whitespace-pre-line text-muted-foreground [overflow-wrap:anywhere]">
          {dossier.description}
        </p>
      )}
    </div>
  );
}

function DocumentTable({
  documents,
  canRemove,
  removing,
  onRemove,
}: {
  documents: DossierDocument[];
  canRemove: boolean;
  removing: string | null;
  onRemove: (documentId: string) => void;
}) {
  return (
    <Table className="min-w-[44rem]">
      <TableHeader>
        <TableRow>
          <TableHead className="w-12">#</TableHead>
          <TableHead>Number</TableHead>
          <TableHead>Date</TableHead>
          <TableHead>Subject</TableHead>
          <TableHead>Type</TableHead>
          <TableHead>Status</TableHead>
          {canRemove && (
            <TableHead>
              <span className="sr-only">Actions</span>
            </TableHead>
          )}
        </TableRow>
      </TableHeader>
      <TableBody>
        {documents.map((doc) => {
          const busy = removing === doc.document_id;
          const removeButton = canRemove && (
            <TableCell className="text-right">
              <Button
                variant="ghost"
                size="sm"
                onClick={() => onRemove(doc.document_id)}
                disabled={removing !== null}
                aria-label={`Remove document ${doc.ordinal} from the dossier`}
              >
                {busy ? (
                  <Loader2 data-icon="inline-start" className="animate-spin" aria-hidden />
                ) : (
                  <Trash2 data-icon="inline-start" aria-hidden />
                )}
                Remove
              </Button>
            </TableCell>
          );
          if (!doc.readable) {
            return (
              <TableRow key={doc.document_id}>
                <TableCell className="tabular-nums">{doc.ordinal}</TableCell>
                <TableCell colSpan={5} className="text-muted-foreground italic">
                  <Lock className="mr-1 inline size-3.5 align-[-2px]" aria-hidden />
                  {RESTRICTED_DOCUMENT_LABEL}
                </TableCell>
                {removeButton}
              </TableRow>
            );
          }
          const date = doc.issued_date ?? doc.arrival_date;
          return (
            <TableRow key={doc.document_id}>
              <TableCell className="tabular-nums">{doc.ordinal}</TableCell>
              <TableCell className="whitespace-nowrap">
                {doc.notation ?? (doc.arrival_number == null ? "—" : null)}
                {doc.arrival_number != null && (
                  <span className={cn("text-xs text-muted-foreground", doc.notation && "block")}>
                    Arrival no. {doc.arrival_number}
                  </span>
                )}
              </TableCell>
              <TableCell className="whitespace-nowrap">{date ? formatDay(date) : "—"}</TableCell>
              <TableCell className="max-w-96 whitespace-normal">
                <Link
                  href={`/documents/${doc.document_id}`}
                  className="font-medium [overflow-wrap:anywhere] underline-offset-4 hover:underline focus-visible:underline"
                >
                  {doc.subject}
                </Link>
              </TableCell>
              <TableCell className="whitespace-normal">{doc.type_name ?? "—"}</TableCell>
              <TableCell>
                <StatusBadge status={doc.status} />
              </TableCell>
              {removeButton}
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}

// ---------------------------------------------------------------- dialogs

function EditDossierDialog({
  dossier,
  onOpenChange,
  onSaved,
}: {
  dossier: DossierInfo;
  onOpenChange: (open: boolean) => void;
  onSaved: () => void;
}) {
  const ids = useId();
  const [title, setTitle] = useState(dossier.title);
  const [departmentId, setDepartmentId] = useState<string | null>(dossier.department_id);
  const [retentionId, setRetentionId] = useState<string | null>(dossier.retention_code_id);
  const [description, setDescription] = useState(dossier.description ?? "");
  const [capital, setCapital] = useState(dossier.is_capital_construction);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    if (saving) return;
    if (!title.trim()) {
      setError("Enter a title.");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await updateDossier(dossier.id, {
        title: title.trim(),
        department_id: departmentId,
        retention_code_id: retentionId,
        description: description.trim() || null,
        is_capital_construction: capital,
      });
      toast.success("Dossier saved");
      onOpenChange(false);
      onSaved();
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Edit dossier {dossier.code}</DialogTitle>
          <DialogDescription>The code and year cannot change once the dossier exists.</DialogDescription>
        </DialogHeader>
        <form id={`${ids}-form`} onSubmit={save} className="max-h-[60vh] space-y-4 overflow-y-auto px-0.5" noValidate>
          <div className="space-y-2">
            <Label htmlFor={`${ids}-title`}>Title (Tiêu đề hồ sơ)</Label>
            <Input
              id={`${ids}-title`}
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              maxLength={500}
              autoFocus
            />
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor={`${ids}-dept`}>Department</Label>
              <DepartmentSelect id={`${ids}-dept`} value={departmentId} onChange={setDepartmentId} />
            </div>
            <div className="space-y-2">
              <Label htmlFor={`${ids}-retention`}>Retention (Thời hạn bảo quản)</Label>
              <RetentionSelect id={`${ids}-retention`} value={retentionId} onChange={setRetentionId} />
            </div>
          </div>
          <div className="space-y-2">
            <Label htmlFor={`${ids}-description`}>Description</Label>
            <Textarea
              id={`${ids}-description`}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              maxLength={2000}
              rows={3}
            />
          </div>
          <label className="flex items-start gap-2 text-sm">
            <input
              type="checkbox"
              className="mt-0.5 size-4 accent-primary"
              checked={capital}
              onChange={(e) => setCapital(e.target.checked)}
              aria-describedby={`${ids}-capital-hint`}
            />
            <span>
              Capital construction dossier (Hồ sơ xây dựng cơ bản)
              <span id={`${ids}-capital-hint`} className="block text-xs text-muted-foreground">
                Due at the archive 3 months after the end date instead of 1 year.
              </span>
            </span>
          </label>
          {error && (
            <p className="text-sm text-destructive" role="alert">
              {error}
            </p>
          )}
        </form>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>
            Cancel
          </Button>
          <button type="submit" form={`${ids}-form`} disabled={saving} className={buttonVariants()}>
            {saving ? "Saving…" : "Save"}
          </button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function CloseDossierDialog({
  dossier,
  today,
  onOpenChange,
  onClosed,
}: {
  dossier: DossierInfo;
  today: string;
  onOpenChange: (open: boolean) => void;
  onClosed: () => void;
}) {
  const ids = useId();
  const [endDate, setEndDate] = useState(today);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  let due = "";
  try {
    due = endDate ? transferDueDate(endDate, dossier.is_capital_construction) : "";
  } catch {
    due = "";
  }

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    if (saving) return;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(endDate)) {
      setError("Choose the end date.");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await closeDossier(dossier.id, endDate);
      toast.success(`Dossier ${dossier.code} closed`);
      onOpenChange(false);
      onClosed();
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Close dossier {dossier.code}</DialogTitle>
          <DialogDescription>
            Remove drafts and duplicates first. Closing sets the transfer deadline to 1 year after the end date (3
            months for capital construction).
          </DialogDescription>
        </DialogHeader>
        <form id={`${ids}-form`} onSubmit={save} className="space-y-4" noValidate>
          <div className="space-y-2">
            <Label htmlFor={`${ids}-end`}>End date (Ngày kết thúc)</Label>
            <Input
              id={`${ids}-end`}
              type="date"
              value={endDate}
              onChange={(e) => setEndDate(e.target.value)}
              aria-describedby={`${ids}-due`}
              required
            />
            <p id={`${ids}-due`} className="text-xs text-muted-foreground">
              {due ? `Transfer to the archive due by ${formatDay(due)}.` : "Choose a date."}
            </p>
          </div>
          {error && (
            <p className="text-sm text-destructive" role="alert">
              {error}
            </p>
          )}
        </form>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>
            Cancel
          </Button>
          <button type="submit" form={`${ids}-form`} disabled={saving} className={buttonVariants()}>
            {saving ? "Closing…" : "Close dossier"}
          </button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

const CONFIRM_COPY: Record<
  Confirm,
  { title: (code: string) => string; body: string; action: string; busy: string; done: string; danger?: boolean }
> = {
  reopen: {
    title: (code) => `Reopen dossier ${code}?`,
    body: "The end date and the transfer deadline are cleared, and documents can be added or removed again.",
    action: "Reopen",
    busy: "Reopening…",
    done: "Dossier reopened",
  },
  transfer: {
    title: (code) => `Transfer ${code} to the archive?`,
    body: "Completed and issued documents in this dossier will be marked Archived.",
    action: "Transfer to archive",
    busy: "Transferring…",
    done: "Dossier transferred to the archive",
  },
  hold: {
    title: (code) => `Put ${code} on legal hold?`,
    body: "While on hold, the documents in this dossier cannot be deleted or removed from it, and their files cannot be changed, trashed or deleted.",
    action: "Put on legal hold",
    busy: "Saving…",
    done: "Legal hold is on",
    danger: true,
  },
  release: {
    title: (code) => `Lift the legal hold on ${code}?`,
    body: "Documents and files in this dossier can be changed and deleted again under the normal rules.",
    action: "Lift legal hold",
    busy: "Saving…",
    done: "Legal hold lifted",
  },
};

function ConfirmDialog({
  kind,
  dossier,
  onOpenChange,
  onDone,
}: {
  kind: Confirm;
  dossier: DossierInfo;
  onOpenChange: (open: boolean) => void;
  onDone: () => void;
}) {
  const copy = CONFIRM_COPY[kind];
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const run = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      if (kind === "reopen") await reopenDossier(dossier.id);
      else if (kind === "transfer") await transferDossier(dossier.id);
      else await setDossierLegalHold(dossier.id, kind === "hold");
      toast.success(copy.done);
      onOpenChange(false);
      onDone();
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{copy.title(dossier.code)}</DialogTitle>
          <DialogDescription>{copy.body}</DialogDescription>
        </DialogHeader>
        {error && (
          <p className="text-sm text-destructive" role="alert">
            {error}
          </p>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>
            Cancel
          </Button>
          <Button variant={copy.danger ? "destructive" : "default"} onClick={() => void run()} disabled={busy}>
            {busy ? (
              <Loader2 data-icon="inline-start" className="animate-spin" aria-hidden />
            ) : kind === "transfer" ? (
              <Archive data-icon="inline-start" aria-hidden />
            ) : kind === "reopen" ? (
              <FolderOpen data-icon="inline-start" aria-hidden />
            ) : null}
            {busy ? copy.busy : copy.action}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
