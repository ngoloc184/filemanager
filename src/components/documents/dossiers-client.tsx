"use client";

import { useEffect, useId, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { AlarmClock, ArrowLeft, FolderArchive, Loader2, Plus, Search, ShieldAlert, X } from "lucide-react";
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
import { DepartmentSelect, nativeSelectClass } from "@/components/org/department-select";
import { getMyOrg, listDepartments, type Department, type MyOrg } from "@/lib/services/org";
import {
  createDossier,
  listDossiers,
  listDossiersDueForTransfer,
  listRetentionCodes,
} from "@/lib/services/dossiers";
import {
  DOSSIER_STATUS_LABELS,
  retentionLabel,
  suggestDossierCode,
  type DossierListItem,
  type DossierStatus,
  type RetentionCode,
} from "@/lib/documents/dossiers";
import { DEFAULT_ORG_TIME_ZONE, formatDay, todayIn } from "@/lib/documents/deadlines";
import { hasRole } from "@/lib/org";
import { getErrorMessage } from "@/lib/types/database";
import { cn } from "@/lib/utils";

// Dossiers (hồ sơ) list: year and status filters, search, the "due for
// transfer" banner for clerks, leaders and admins, and the New dossier dialog.
// Shared bits (status / hold badges, retention select) are exported for the
// dossier page and the Add to dossier control.

/** Days ahead the transfer banner looks (dossiers_due_for_transfer). */
const DUE_WINDOW_DAYS = 30;

export type DossierListFilters = {
  /** null = the current year in the company's time zone */
  year: number | "all" | null;
  status: DossierStatus | "all";
  q: string;
  /** show only the dossiers due for transfer */
  due: boolean;
};

const STATUS_TABS: { id: DossierStatus | "all"; label: string }[] = [
  { id: "open", label: "Open" },
  { id: "closed", label: "Closed" },
  { id: "transferred", label: "Transferred" },
  { id: "all", label: "All" },
];

// ---------------------------------------------------------------- shared bits

const STATUS_CLASSES: Record<DossierStatus, string> = {
  open: "bg-primary/10 text-primary dark:bg-primary/20",
  closed: "bg-muted text-muted-foreground",
  transferred: "bg-success/15 text-emerald-700 dark:bg-success/20 dark:text-emerald-300",
};

export function DossierStatusBadge({ status, className }: { status: DossierStatus; className?: string }) {
  return (
    <Badge variant="secondary" className={cn(STATUS_CLASSES[status], className)}>
      {DOSSIER_STATUS_LABELS[status] ?? status}
    </Badge>
  );
}

export function LegalHoldBadge({ className }: { className?: string }) {
  return (
    <Badge
      variant="secondary"
      className={cn("bg-destructive/10 text-destructive dark:bg-destructive/20", className)}
      title="Documents in this dossier cannot be deleted or changed"
    >
      <ShieldAlert data-icon="inline-start" aria-hidden="true" />
      Legal hold
    </Badge>
  );
}

/**
 * '10 – 10 years', 'VV – Vĩnh viễn (permanent)': the catalog code and label,
 * plus the period (retentionLabel) when the label does not already say it.
 */
export function retentionText(code: string, label: string, years: number | null): string {
  const period = retentionLabel({ years });
  const text = label.trim();
  return text.toLowerCase().includes(period.split(" (")[0].toLowerCase())
    ? `${code} – ${text}`
    : `${code} – ${text} (${period})`;
}

/** Retention codes of the company (thời hạn bảo quản) as a native select. */
export function RetentionSelect({
  id,
  value,
  onChange,
  disabled,
  "aria-describedby": describedBy,
}: {
  id?: string;
  value: string | null;
  onChange: (id: string | null) => void;
  disabled?: boolean;
  "aria-describedby"?: string;
}) {
  const [codes, setCodes] = useState<RetentionCode[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    listRetentionCodes()
      .then((rows) => {
        if (!cancelled) setCodes(rows);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setError(getErrorMessage(err));
        setCodes([]);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <>
      <select
        id={id}
        className={nativeSelectClass}
        value={value ?? ""}
        onChange={(e) => onChange(e.target.value || null)}
        disabled={disabled || codes === null}
        aria-describedby={describedBy}
      >
        <option value="">{codes === null ? "Loading…" : "Not set"}</option>
        {(codes ?? []).map((c) => (
          <option key={c.id} value={c.id}>
            {retentionText(c.code, c.label, c.years)}
          </option>
        ))}
      </select>
      {error && <p className="mt-1 text-xs text-destructive">{error}</p>}
    </>
  );
}

/** Transfer due date, flagged when it has passed (closed dossiers only). */
export function TransferDue({
  date,
  status,
  today,
}: {
  date: string | null;
  status: DossierStatus;
  today: string;
}) {
  if (!date) return <span className="text-muted-foreground">—</span>;
  const overdue = status === "closed" && date < today;
  return (
    <span className={cn("inline-flex items-center gap-1 whitespace-nowrap", overdue && "font-medium text-destructive")}>
      {overdue && <AlarmClock className="size-3.5" aria-hidden />}
      {formatDay(date)}
      {overdue && <span className="sr-only"> (overdue)</span>}
    </span>
  );
}

/** Lower case without Vietnamese accents: 'Hồ sơ Đất' → 'ho so dat'. */
function foldText(text: string): string {
  return text
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .replace(/đ/g, "d")
    .replace(/Đ/g, "D")
    .toLowerCase();
}

function yearOptions(current: number, selected: number | null): number[] {
  const years = new Set<number>();
  for (let y = current + 1; y >= current - 10; y -= 1) years.add(y);
  if (selected != null) years.add(selected);
  return [...years].sort((a, b) => b - a);
}

// ---------------------------------------------------------------- page

export default function DossiersClient({ initialFilters }: { initialFilters: DossierListFilters }) {
  const router = useRouter();
  const ids = useId();
  const [org, setOrg] = useState<MyOrg | null | undefined>(undefined);
  const [orgError, setOrgError] = useState<string | null>(null);
  const [filters, setFilters] = useState<DossierListFilters>(initialFilters);
  const [query, setQuery] = useState(initialFilters.q);
  const [rows, setRows] = useState<DossierListItem[] | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [due, setDue] = useState<DossierListItem[] | null>(null);
  const [creating, setCreating] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    let cancelled = false;
    getMyOrg()
      .then((result) => {
        if (!cancelled) setOrg(result);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setOrgError(getErrorMessage(err));
        setOrg(null);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const timeZone = org?.org.timezone || DEFAULT_ORG_TIME_ZONE;
  const today = todayIn(timeZone);
  const currentYear = Number(today.slice(0, 4));
  const year = filters.year === null ? currentYear : filters.year;
  const active = org?.me.status === "active";
  const canSeeDue =
    active && (hasRole(org?.me, "clerk") || hasRole(org?.me, "org_admin") || hasRole(org?.me, "leader"));
  // ?due=1 from someone who cannot load the due list falls back to the normal list
  const dueView = filters.due && canSeeDue;

  // debounce typing into the filter that loads
  useEffect(() => {
    const handle = window.setTimeout(() => {
      setFilters((f) => (f.q === query ? f : { ...f, q: query }));
    }, 300);
    return () => window.clearTimeout(handle);
  }, [query]);

  // keep the URL in step so Back from a dossier returns to the same view
  const firstSync = useRef(true);
  useEffect(() => {
    if (firstSync.current) {
      firstSync.current = false;
      return;
    }
    const params = new URLSearchParams();
    if (filters.year !== null) params.set("year", String(filters.year));
    if (filters.status !== "open") params.set("status", filters.status);
    if (filters.q.trim()) params.set("q", filters.q.trim());
    if (filters.due) params.set("due", "1");
    const search = params.toString();
    router.replace(search ? `/documents/dossiers?${search}` : "/documents/dossiers", { scroll: false });
  }, [filters, router]);

  useEffect(() => {
    if (!active || dueView) return;
    let cancelled = false;
    listDossiers({
      year: year === "all" ? null : year,
      status: filters.status === "all" ? null : filters.status,
      q: filters.q,
    })
      .then((result) => {
        if (cancelled) return;
        setRows(result);
        setListError(null);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setListError(getErrorMessage(err));
        setRows([]);
      });
    return () => {
      cancelled = true;
    };
  }, [active, year, filters.status, filters.q, dueView, reloadKey]);

  useEffect(() => {
    if (!canSeeDue) return;
    let cancelled = false;
    listDossiersDueForTransfer(DUE_WINDOW_DAYS)
      .then((result) => {
        if (!cancelled) setDue(result);
      })
      .catch(() => {
        // the banner is a hint; the list still works without it
        if (!cancelled) setDue([]);
      });
    return () => {
      cancelled = true;
    };
  }, [canSeeDue, reloadKey]);

  const shown = useMemo(() => {
    if (!dueView) return rows;
    if (!due) return null;
    // accents ignored, like list_dossiers on the server
    const q = foldText(filters.q.trim());
    return q ? due.filter((d) => foldText(`${d.code} ${d.title}`).includes(q)) : due;
  }, [dueView, filters.q, due, rows]);

  const setFilter = (patch: Partial<DossierListFilters>) => {
    // a new view starts from the spinner, not the previous view's rows
    setRows(null);
    setListError(null);
    setFilters((f) => ({ ...f, ...patch }));
  };

  const header = (
    <div className="space-y-2">
      <Link href="/documents" className={cn(buttonVariants({ variant: "ghost", size: "sm" }), "-ml-2")}>
        <ArrowLeft aria-hidden />
        Documents
      </Link>
      <div className="flex flex-wrap items-center gap-3">
        <FolderArchive className="size-7 shrink-0 text-primary" aria-hidden />
        <h2 className="min-w-0 flex-1 text-2xl font-bold">Dossiers (Hồ sơ)</h2>
        {active && (
          <Button onClick={() => setCreating(true)}>
            <Plus data-icon="inline-start" aria-hidden />
            New dossier
          </Button>
        )}
      </div>
      <p className="text-sm text-muted-foreground">
        Group documents of one matter into a dossier, close it at the end of the year and transfer it to the
        archive (nộp lưu).
      </p>
    </div>
  );

  if (org === undefined) {
    return (
      <div className="max-w-6xl space-y-6">
        {header}
        <div className="flex items-center gap-2 text-sm text-muted-foreground" role="status">
          <Loader2 className="size-4 animate-spin" aria-hidden />
          Loading…
        </div>
      </div>
    );
  }

  if (!active) {
    return (
      <div className="max-w-6xl space-y-6">
        {header}
        <Card className="max-w-xl">
          <CardHeader>
            <CardTitle>{orgError ? "Could not load your company" : "Not available"}</CardTitle>
            <CardDescription className={cn(orgError && "text-destructive")}>
              {orgError ??
                (org
                  ? "Your membership is suspended. Ask a company admin to reactivate it."
                  : "Dossiers belong to a company. Create or join one first.")}
            </CardDescription>
          </CardHeader>
          {!org && !orgError && (
            <CardContent>
              <Link href="/org" className={buttonVariants({ variant: "outline" })}>
                Go to Company
              </Link>
            </CardContent>
          )}
        </Card>
      </div>
    );
  }

  const dueCount = due?.length ?? 0;

  return (
    <div className="max-w-6xl space-y-6">
      {header}

      {canSeeDue && dueCount > 0 && !dueView && (
        <div
          className="flex flex-wrap items-center gap-3 rounded-lg border border-warning/40 bg-warning/10 px-3 py-2 text-sm text-amber-900 dark:text-amber-100"
          role="status"
        >
          <AlarmClock className="size-4 shrink-0" aria-hidden />
          <p className="min-w-0 flex-1">
            {dueCount === 1 ? "1 dossier is" : `${dueCount} dossiers are`} due for transfer to the archive within{" "}
            {DUE_WINDOW_DAYS} days.
          </p>
          <Button variant="outline" size="sm" onClick={() => setFilter({ due: true })}>
            Show {dueCount === 1 ? "it" : "them"}
          </Button>
        </div>
      )}

      <div className="flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-end">
        <div className="space-y-1">
          <Label htmlFor={`${ids}-year`}>Year</Label>
          <select
            id={`${ids}-year`}
            className={cn(nativeSelectClass, "sm:w-36")}
            value={year === "all" ? "all" : String(year)}
            disabled={dueView}
            onChange={(e) =>
              setFilter({ year: e.target.value === "all" ? "all" : Number(e.target.value) === currentYear ? null : Number(e.target.value) })
            }
          >
            <option value="all">All years</option>
            {yearOptions(currentYear, typeof year === "number" ? year : null).map((y) => (
              <option key={y} value={y}>
                {y}
              </option>
            ))}
          </select>
        </div>
        <div className="min-w-0 flex-1 space-y-1 sm:min-w-56">
          <Label htmlFor={`${ids}-q`}>Search</Label>
          <div className="relative">
            <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
            <Input
              id={`${ids}-q`}
              type="search"
              className="pl-8"
              placeholder="Code or title"
              value={query}
              maxLength={100}
              onChange={(e) => setQuery(e.target.value)}
            />
          </div>
        </div>
      </div>

      {dueView ? (
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <Badge variant="secondary" className="bg-warning/15 text-amber-800 dark:bg-warning/20 dark:text-amber-200">
            <AlarmClock data-icon="inline-start" aria-hidden="true" />
            Due for transfer within {DUE_WINDOW_DAYS} days (all years)
          </Badge>
          <Button variant="ghost" size="sm" onClick={() => setFilter({ due: false })}>
            <X data-icon="inline-start" aria-hidden />
            Show all dossiers
          </Button>
        </div>
      ) : (
        <StatusTabs active={filters.status} onChange={(status) => setFilter({ status })} />
      )}

      <div role={dueView ? undefined : "tabpanel"} aria-labelledby={dueView ? undefined : `dossier-tab-${filters.status}`}>
        {listError && !dueView ? (
          <p className="rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive" role="alert">
            {listError}
          </p>
        ) : shown === null ? (
          <div className="flex items-center gap-2 py-6 text-sm text-muted-foreground" role="status">
            <Loader2 className="size-4 animate-spin" aria-hidden />
            Loading dossiers…
          </div>
        ) : shown.length === 0 ? (
          <p className="rounded-lg border border-dashed px-4 py-8 text-center text-sm text-muted-foreground">
            {dueView
              ? "No dossiers are due for transfer."
              : filters.q.trim()
                ? "No dossiers match your search."
                : "No dossiers here yet."}
          </p>
        ) : (
          <DossierTable rows={shown} today={today} />
        )}
      </div>

      {creating && (
        <NewDossierDialog
          defaultYear={typeof year === "number" ? year : currentYear}
          currentYear={currentYear}
          myDepartmentId={org?.me.department_id ?? null}
          onOpenChange={setCreating}
          onCreated={(id) => {
            setReloadKey((k) => k + 1);
            router.push(`/documents/dossiers/${id}`);
          }}
        />
      )}
    </div>
  );
}

function StatusTabs({
  active,
  onChange,
}: {
  active: DossierStatus | "all";
  onChange: (id: DossierStatus | "all") => void;
}) {
  const refs = useRef<Record<string, HTMLButtonElement | null>>({});

  const onKeyDown = (e: React.KeyboardEvent) => {
    const index = STATUS_TABS.findIndex((t) => t.id === active);
    let next = -1;
    if (e.key === "ArrowRight") next = (index + 1) % STATUS_TABS.length;
    else if (e.key === "ArrowLeft") next = (index - 1 + STATUS_TABS.length) % STATUS_TABS.length;
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = STATUS_TABS.length - 1;
    if (next < 0) return;
    e.preventDefault();
    onChange(STATUS_TABS[next].id);
    refs.current[STATUS_TABS[next].id]?.focus();
  };

  return (
    <div
      role="tablist"
      aria-label="Dossier status"
      className="-mx-1 flex gap-1 overflow-x-auto border-b px-1"
      onKeyDown={onKeyDown}
    >
      {STATUS_TABS.map((t) => {
        const selected = t.id === active;
        return (
          <button
            key={t.id}
            ref={(el) => {
              refs.current[t.id] = el;
            }}
            type="button"
            role="tab"
            id={`dossier-tab-${t.id}`}
            aria-selected={selected}
            tabIndex={selected ? 0 : -1}
            onClick={() => onChange(t.id)}
            className={cn(
              "-mb-px shrink-0 border-b-2 px-3 py-2 text-sm font-medium whitespace-nowrap transition-colors outline-none focus-visible:ring-3 focus-visible:ring-ring/50",
              selected
                ? "border-primary text-foreground"
                : "border-transparent text-muted-foreground hover:text-foreground"
            )}
          >
            {t.label}
          </button>
        );
      })}
    </div>
  );
}

function DossierTable({ rows, today }: { rows: DossierListItem[]; today: string }) {
  return (
    <Table className="min-w-[56rem]">
      <TableHeader>
        <TableRow>
          <TableHead>Code</TableHead>
          <TableHead>Title</TableHead>
          <TableHead>Department</TableHead>
          <TableHead>Retention</TableHead>
          <TableHead className="text-right">Documents</TableHead>
          <TableHead>Owner</TableHead>
          <TableHead>Status</TableHead>
          <TableHead>Transfer due</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((d) => (
          <TableRow key={d.id}>
            <TableCell className="font-mono text-xs whitespace-nowrap">
              {d.code}
              <span className="ml-1 text-muted-foreground">· {d.year}</span>
            </TableCell>
            <TableCell className="max-w-80 whitespace-normal">
              <Link
                href={`/documents/dossiers/${d.id}`}
                className="font-medium [overflow-wrap:anywhere] text-foreground underline-offset-4 hover:underline focus-visible:underline"
              >
                {d.title}
              </Link>
            </TableCell>
            <TableCell className="whitespace-normal">{d.department_name ?? "—"}</TableCell>
            <TableCell>{d.retention_label ?? "Not set"}</TableCell>
            <TableCell className="text-right tabular-nums">{d.doc_count}</TableCell>
            <TableCell className="whitespace-normal">{d.owner_name ?? "—"}</TableCell>
            <TableCell>
              <div className="flex flex-wrap gap-1">
                <DossierStatusBadge status={d.status} />
                {d.legal_hold && <LegalHoldBadge />}
              </div>
            </TableCell>
            <TableCell>
              <TransferDue date={d.transfer_due_date} status={d.status} today={today} />
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

// ---------------------------------------------------------------- new dossier

function NewDossierDialog({
  defaultYear,
  currentYear,
  myDepartmentId,
  onOpenChange,
  onCreated,
}: {
  defaultYear: number;
  currentYear: number;
  myDepartmentId: string | null;
  onOpenChange: (open: boolean) => void;
  onCreated: (id: string) => void;
}) {
  const ids = useId();
  const [year, setYear] = useState(defaultYear);
  const [code, setCode] = useState("");
  const [codeEdited, setCodeEdited] = useState(false);
  const [title, setTitle] = useState("");
  const [departmentId, setDepartmentId] = useState<string | null>(myDepartmentId);
  const [retentionId, setRetentionId] = useState<string | null>(null);
  const [description, setDescription] = useState("");
  const [departments, setDepartments] = useState<Department[]>([]);
  const [existingCodes, setExistingCodes] = useState<string[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let cancelled = false;
    listDepartments()
      .then((rows) => {
        if (!cancelled) setDepartments(rows);
      })
      .catch(() => {
        // the suggestion then has no department part; the code stays editable
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // codes already used in the chosen year feed the suggestion
  useEffect(() => {
    let cancelled = false;
    listDossiers({ year })
      .then((rows) => {
        if (!cancelled) setExistingCodes(rows.map((r) => r.code));
      })
      .catch(() => {
        if (!cancelled) setExistingCodes([]);
      });
    return () => {
      cancelled = true;
    };
  }, [year]);

  // no department = the creator's department (create_dossier)
  const deptCode = departments.find((d) => d.id === (departmentId ?? myDepartmentId))?.code ?? "";
  const suggestion = existingCodes ? suggestDossierCode(existingCodes, deptCode) : "";
  const shownCode = codeEdited ? code : suggestion;

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    if (saving) return;
    const finalCode = shownCode.trim();
    if (!finalCode || finalCode.length > 30) {
      setError("Code must be 1 to 30 characters.");
      return;
    }
    if (!title.trim()) {
      setError("Enter a title.");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const row = await createDossier({
        year,
        code: finalCode,
        title: title.trim(),
        department_id: departmentId,
        retention_code_id: retentionId,
        description: description.trim() || null,
      });
      toast.success(`Dossier ${row.code} created`);
      onOpenChange(false);
      onCreated(row.id);
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
          <DialogTitle>New dossier (Lập hồ sơ)</DialogTitle>
          <DialogDescription>You own the dossier. Add documents to it from each document&apos;s page.</DialogDescription>
        </DialogHeader>
        <form id={`${ids}-form`} onSubmit={save} className="max-h-[60vh] space-y-4 overflow-y-auto px-0.5" noValidate>
          <div className="grid gap-4 sm:grid-cols-[8rem_1fr]">
            <div className="space-y-2">
              <Label htmlFor={`${ids}-year`}>Year</Label>
              <select
                id={`${ids}-year`}
                className={nativeSelectClass}
                value={year}
                onChange={(e) => setYear(Number(e.target.value))}
              >
                {yearOptions(currentYear, year).map((y) => (
                  <option key={y} value={y}>
                    {y}
                  </option>
                ))}
              </select>
            </div>
            <div className="space-y-2">
              <Label htmlFor={`${ids}-code`}>Code (Ký hiệu hồ sơ)</Label>
              <Input
                id={`${ids}-code`}
                value={shownCode}
                placeholder={existingCodes === null ? "Suggesting…" : "01.HCNS"}
                maxLength={30}
                onChange={(e) => {
                  setCodeEdited(true);
                  setCode(e.target.value);
                }}
                aria-describedby={`${ids}-code-hint`}
                className="font-mono"
              />
              <p id={`${ids}-code-hint`} className="text-xs text-muted-foreground">
                Suggested from the department&apos;s codes this year; you can change it.
                {codeEdited && suggestion && (
                  <>
                    {" "}
                    <button
                      type="button"
                      className="text-primary underline-offset-4 hover:underline"
                      onClick={() => {
                        setCodeEdited(false);
                        setCode("");
                      }}
                    >
                      Use {suggestion}
                    </button>
                  </>
                )}
              </p>
            </div>
          </div>
          <div className="space-y-2">
            <Label htmlFor={`${ids}-title`}>Title (Tiêu đề hồ sơ)</Label>
            <Input
              id={`${ids}-title`}
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              maxLength={500}
              placeholder="e.g. Hồ sơ hợp đồng lao động năm 2026"
              autoFocus
            />
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor={`${ids}-dept`}>Department</Label>
              <DepartmentSelect id={`${ids}-dept`} value={departmentId} onChange={setDepartmentId} placeholder="My department" />
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
            {saving && <Loader2 className="animate-spin" aria-hidden />}
            {saving ? "Creating…" : "Create dossier"}
          </button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
