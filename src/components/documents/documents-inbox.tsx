"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  AlertCircle,
  BookOpen,
  BarChart3,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Download,
  FileText,
  FolderArchive,
  Inbox as InboxIcon,
  Loader2,
  Plus,
  Settings,
} from "lucide-react";
import { toast } from "sonner";
import { Button, buttonVariants } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { DocumentFilters } from "@/components/documents/document-filters";
import { DocumentTable } from "@/components/documents/document-table";
import { getMyOrg, type MyOrg } from "@/lib/services/org";
import { listHolidays } from "@/lib/services/documents";
import { getDocumentDashboard, searchDocuments } from "@/lib/services/document-search";
import {
  DEFAULT_DOCUMENT_VIEW,
  csvForResults,
  hasActiveFilters,
  normalizeFilters,
  visibleViews,
  type DocumentDashboard,
  type DocumentFilters as Filters,
  type DocumentSearchRow,
  type DocumentView,
  type DocumentViewDef,
} from "@/lib/documents/filters";
import {
  csvFileName,
  emptyMessage,
  inboxSearch,
  pageCount,
  pageRangeText,
  viewCount,
} from "@/lib/documents/table-format";
import { holidaySet, todayIn } from "@/lib/documents/deadlines";
import { hasRole } from "@/lib/org";
import { getErrorMessage } from "@/lib/types/database";
import type { SessionUser } from "@/lib/auth";
import { cn } from "@/lib/utils";

// Documents inbox (/documents): dashboard cards, view tabs, filters and the
// results table. Filters live in the URL (router.replace, no scroll) so a
// reload or a shared link opens the same list; the page passes them in.

const PAGE_SIZE = 50;
/** CSV export: at most this many rows, fetched in pages of the server maximum. */
const EXPORT_LIMIT = 2000;
const EXPORT_PAGE_SIZE = 200;

type Loaded<T> = { key: string; data?: T; error?: string };

type CardDef = { view: DocumentView; label: string; hint: string; clerkOnly?: boolean };

const CARDS: readonly CardDef[] = [
  { view: "needs_me", label: "Needs me", hint: "Cần xử lý" },
  { view: "awaiting_approval", label: "Awaiting approval", hint: "Chờ duyệt" },
  { view: "due_soon", label: "Due soon", hint: "Sắp đến hạn" },
  { view: "overdue", label: "Overdue", hint: "Quá hạn" },
  { view: "for_info", label: "For information", hint: "Để biết" },
  { view: "to_register", label: "To register", hint: "Chờ vào sổ", clerkOnly: true },
  { view: "to_issue", label: "Ready to issue", hint: "Chờ phát hành", clerkOnly: true },
];

function downloadText(text: string, fileName: string, type: string) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement("a");
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export default function DocumentsInbox({
  initialFilters,
}: {
  user: SessionUser;
  initialFilters: Filters;
}) {
  const [orgReload, setOrgReload] = useState(0);
  const [org, setOrg] = useState<Loaded<MyOrg | null> | null>(null);

  useEffect(() => {
    let cancelled = false;
    const key = String(orgReload);
    getMyOrg()
      .then((data) => {
        if (!cancelled) setOrg({ key, data });
      })
      .catch((err: unknown) => {
        if (!cancelled) setOrg({ key, error: getErrorMessage(err) });
      });
    return () => {
      cancelled = true;
    };
  }, [orgReload]);

  if (!org || (org.key !== String(orgReload) && !org.data)) {
    return (
      <div className="flex items-center gap-2 text-sm text-muted-foreground" role="status">
        <Loader2 className="size-4 animate-spin" aria-hidden />
        Loading documents…
      </div>
    );
  }

  if (org.error) {
    return (
      <Card className="max-w-xl">
        <CardHeader>
          <CardTitle>Could not load your company</CardTitle>
          <CardDescription className="text-destructive">{org.error}</CardDescription>
        </CardHeader>
        <CardContent>
          <Button variant="outline" onClick={() => setOrgReload((n) => n + 1)}>
            Retry
          </Button>
        </CardContent>
      </Card>
    );
  }

  if (!org.data) return <NoCompany />;

  if (org.data.me.status !== "active") {
    return (
      <Card className="max-w-xl">
        <CardHeader>
          <CardTitle>Documents are unavailable</CardTitle>
          <CardDescription>
            Your company membership is suspended. Ask a company admin to reactivate it.
          </CardDescription>
        </CardHeader>
      </Card>
    );
  }

  return <Inbox myOrg={org.data} initialFilters={initialFilters} />;
}

function NoCompany() {
  return (
    <Card className="max-w-xl">
      <CardHeader>
        <FileText className="mb-2 size-8 text-primary" aria-hidden />
        <CardTitle>Documents need a company</CardTitle>
        <CardDescription>
          Create or join a company to register, route and approve official documents (văn bản).
        </CardDescription>
      </CardHeader>
      <CardContent>
        <Link href="/org" className={buttonVariants()}>
          Go to Organization
        </Link>
      </CardContent>
    </Card>
  );
}

function Inbox({ myOrg, initialFilters }: { myOrg: MyOrg; initialFilters: Filters }) {
  const router = useRouter();
  const { org, me } = myOrg;
  const roles = me.roles;
  const isClerk = hasRole(me, "clerk");
  const isAdmin = hasRole(me, "org_admin");
  const canReports = isAdmin || isClerk || hasRole(me, "leader") || hasRole(me, "dept_head");

  const today = useMemo(() => todayIn(org.timezone), [org.timezone]);
  const views = useMemo(() => visibleViews(roles), [roles]);

  // ---- filters (state + URL)
  const [filters, setFilters] = useState<Filters>(() => normalizeFilters(initialFilters));
  const [page, setPage] = useState(1);

  // the server page passes the URL's filters; adopt them when they change
  // from outside (a link or the address bar), not when we wrote them
  const initialKey = inboxSearch(initialFilters);
  const [seenInitialKey, setSeenInitialKey] = useState(initialKey);
  if (initialKey !== seenInitialKey) {
    setSeenInitialKey(initialKey);
    if (initialKey !== inboxSearch(filters)) {
      setFilters(normalizeFilters(initialFilters));
      setPage(1);
    }
  }

  const applyFilters = useCallback(
    (next: Filters) => {
      const clean = normalizeFilters(next);
      setFilters(clean);
      setPage(1);
      router.replace(`/documents${inboxSearch(clean)}`, { scroll: false });
    },
    [router]
  );

  const view: DocumentView =
    filters.view && views.some((v) => v.key === filters.view) ? filters.view : DEFAULT_DOCUMENT_VIEW;
  const queryFilters = useMemo<Filters>(() => ({ ...filters, view }), [filters, view]);
  const filtered = hasActiveFilters(filters);

  const selectView = (next: DocumentView) => {
    if (next !== view) applyFilters({ ...filters, view: next });
  };

  // ---- holidays (deadline badges); optional, the list works without them
  const [holidays, setHolidays] = useState<ReadonlySet<string>>(() => new Set());
  useEffect(() => {
    let cancelled = false;
    listHolidays()
      .then((rows) => {
        if (!cancelled) setHolidays(holidaySet(rows));
      })
      .catch(() => {
        /* badges fall back to Monday–Friday */
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // ---- dashboard counts
  const [dashReload, setDashReload] = useState(0);
  const [dashboard, setDashboard] = useState<Loaded<DocumentDashboard> | null>(null);
  useEffect(() => {
    let cancelled = false;
    const key = String(dashReload);
    getDocumentDashboard()
      .then((data) => {
        if (!cancelled) setDashboard({ key, data });
      })
      .catch((err: unknown) => {
        if (!cancelled) setDashboard({ key, error: getErrorMessage(err) });
      });
    return () => {
      cancelled = true;
    };
  }, [dashReload]);
  const counts = dashboard?.data ?? null;

  // ---- results
  const [reload, setReload] = useState(0);
  const requestKey = `${inboxSearch(queryFilters)}#${page}#${reload}`;
  const [results, setResults] = useState<Loaded<{ rows: DocumentSearchRow[]; total: number }> | null>(null);
  useEffect(() => {
    let cancelled = false;
    searchDocuments(queryFilters, page, PAGE_SIZE)
      .then((data) => {
        if (!cancelled) setResults({ key: requestKey, data });
      })
      .catch((err: unknown) => {
        if (!cancelled) setResults({ key: requestKey, error: getErrorMessage(err) });
      });
    return () => {
      cancelled = true;
    };
  }, [queryFilters, page, requestKey]);
  const loading = results?.key !== requestKey;
  const total = !loading ? (results?.data?.total ?? 0) : 0;
  const lastPage = pageCount(total, PAGE_SIZE);

  const retry = () => {
    setReload((n) => n + 1);
    setDashReload((n) => n + 1);
  };

  // ---- CSV export
  const [exporting, setExporting] = useState(false);
  const exportCsv = async () => {
    setExporting(true);
    try {
      const rows: DocumentSearchRow[] = [];
      let matching = 0;
      for (let p = 1; rows.length < EXPORT_LIMIT; p++) {
        const res = await searchDocuments(queryFilters, p, EXPORT_PAGE_SIZE);
        matching = res.total;
        rows.push(...res.rows);
        if (res.rows.length < EXPORT_PAGE_SIZE || rows.length >= res.total) break;
      }
      const exported = rows.slice(0, EXPORT_LIMIT);
      if (exported.length === 0) {
        toast.info("There are no documents to export.");
        return;
      }
      downloadText(csvForResults(exported), csvFileName(today), "text/csv;charset=utf-8");
      toast.success(
        matching > exported.length
          ? `Exported the first ${exported.length} of ${matching} documents.`
          : `Exported ${exported.length} document${exported.length === 1 ? "" : "s"}.`
      );
    } catch (err) {
      toast.error(`Export failed: ${getErrorMessage(err)}`);
    } finally {
      setExporting(false);
    }
  };

  const currentView = views.find((v) => v.key === view);

  return (
    <div className="max-w-7xl space-y-6">
      <Header isClerk={isClerk} isAdmin={isAdmin} canReports={canReports} />

      <DashboardCards
        counts={counts}
        error={dashboard?.error ?? null}
        isClerk={isClerk}
        view={view}
        onSelect={selectView}
        onRetry={() => setDashReload((n) => n + 1)}
      />

      <ViewTabs views={views} active={view} counts={counts} onChange={selectView} />

      <div role="tabpanel" id="documents-panel" aria-labelledby={`documents-tab-${view}`} className="space-y-4">
        <DocumentFilters filters={filters} onChange={applyFilters} today={today} />

        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="text-sm text-muted-foreground" aria-live="polite">
            {loading ? "Loading…" : results?.error ? "" : pageRangeText(page, PAGE_SIZE, total)}
          </p>
          <Button
            variant="outline"
            size="sm"
            onClick={() => void exportCsv()}
            disabled={exporting || loading || !!results?.error || total === 0}
          >
            {exporting ? (
              <Loader2 className="animate-spin" aria-hidden />
            ) : (
              <Download aria-hidden />
            )}
            Export CSV
          </Button>
        </div>

        {!loading && results?.error ? (
          <div
            className="flex flex-wrap items-center gap-3 rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive"
            role="alert"
          >
            <AlertCircle className="size-4 shrink-0" aria-hidden />
            <span className="min-w-0 flex-1 [overflow-wrap:anywhere]">
              Could not load documents: {results.error}
            </span>
            <Button variant="outline" size="sm" onClick={retry}>
              Retry
            </Button>
          </div>
        ) : (
          <DocumentTable
            rows={loading ? null : (results?.data?.rows ?? [])}
            today={today}
            holidays={holidays}
            emptyMessage={emptyMessage(view, filtered)}
            caption={currentView?.label}
          />
        )}

        {!loading && !results?.error && total > PAGE_SIZE && (
          <nav className="flex items-center justify-between gap-2" aria-label="Pages">
            <Button
              variant="outline"
              size="sm"
              disabled={page <= 1}
              onClick={() => setPage((p) => Math.max(1, p - 1))}
            >
              <ChevronLeft aria-hidden />
              Previous
            </Button>
            <span className="text-xs text-muted-foreground">
              Page {Math.min(page, lastPage)} of {lastPage}
            </span>
            <Button
              variant="outline"
              size="sm"
              disabled={page >= lastPage}
              onClick={() => setPage((p) => Math.min(lastPage, p + 1))}
            >
              Next
              <ChevronRight aria-hidden />
            </Button>
          </nav>
        )}
      </div>
    </div>
  );
}

function Header({ isClerk, isAdmin, canReports }: { isClerk: boolean; isAdmin: boolean; canReports: boolean }) {
  const secondary = cn(buttonVariants({ variant: "outline", size: "sm" }));
  return (
    <div className="flex flex-wrap items-start justify-between gap-4">
      <div className="min-w-0">
        <h2 className="text-2xl font-bold">Documents</h2>
        <p className="text-sm text-muted-foreground">Incoming, outgoing and internal documents</p>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        {isClerk && (
          <Link href="/documents/incoming/new" className={buttonVariants({ variant: "outline" })}>
            <InboxIcon aria-hidden />
            Register incoming
          </Link>
        )}
        <div className="inline-flex" role="group" aria-label="New document">
          <Link
            href="/documents/new?direction=outgoing"
            className={cn(buttonVariants(), "rounded-r-none")}
          >
            <Plus aria-hidden />
            New document
          </Link>
          <DropdownMenu>
            <DropdownMenuTrigger
              render={
                <button
                  type="button"
                  className={cn(
                    buttonVariants({ size: "icon" }),
                    "rounded-l-none border-l border-l-primary-foreground/25"
                  )}
                  aria-label="Choose the kind of new document"
                />
              }
            >
              <ChevronDown aria-hidden />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="min-w-64">
              <DropdownMenuItem render={<Link href="/documents/new?direction=outgoing" />}>
                Outgoing document (Văn bản đi)
              </DropdownMenuItem>
              <DropdownMenuItem render={<Link href="/documents/new?direction=internal" />}>
                Internal document (Văn bản nội bộ)
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
        {(isClerk || isAdmin) && (
          <Link href="/documents/registers" className={secondary}>
            <BookOpen aria-hidden />
            Registers
          </Link>
        )}
        {canReports && (
          <Link href="/documents/reports" className={secondary}>
            <BarChart3 aria-hidden />
            Reports
          </Link>
        )}
        {(isClerk || isAdmin) && (
          <Link href="/documents/settings" className={secondary}>
            <Settings aria-hidden />
            Settings
          </Link>
        )}
        <Link href="/documents/dossiers" className={secondary}>
          <FolderArchive aria-hidden />
          Dossiers
        </Link>
      </div>
    </div>
  );
}

function DashboardCards({
  counts,
  error,
  isClerk,
  view,
  onSelect,
  onRetry,
}: {
  counts: DocumentDashboard | null;
  error: string | null;
  isClerk: boolean;
  view: DocumentView;
  onSelect: (view: DocumentView) => void;
  onRetry: () => void;
}) {
  const cards = CARDS.filter((c) => !c.clerkOnly || isClerk);
  return (
    <section aria-label="Overview" className="space-y-2">
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-5 xl:grid-cols-7">
        {cards.map((card) => {
          const count = viewCount(counts, card.view);
          const danger = card.view === "overdue" && !!count && count > 0;
          const selected = view === card.view;
          return (
            <button
              key={card.view}
              type="button"
              aria-pressed={selected}
              onClick={() => onSelect(card.view)}
              className={cn(
                "flex min-w-0 flex-col items-start gap-1 rounded-xl border bg-card p-3 text-left outline-none transition-colors hover:bg-muted/50 focus-visible:ring-3 focus-visible:ring-ring/50",
                selected && "border-primary ring-1 ring-primary",
                danger && "border-destructive/40 bg-destructive/5 dark:bg-destructive/10"
              )}
            >
              <span className="flex w-full items-center justify-between gap-2">
                <span
                  className={cn("text-2xl font-semibold tabular-nums", danger && "text-destructive")}
                >
                  {count === null && error ? (
                    <>
                      <span aria-hidden>—</span>
                      <span className="sr-only">Unavailable</span>
                    </>
                  ) : count === null ? (
                    <>
                      <span className="inline-block h-7 w-8 animate-pulse rounded bg-muted align-middle" aria-hidden />
                      <span className="sr-only">Loading</span>
                    </>
                  ) : (
                    count
                  )}
                </span>
                {card.view === "needs_me" && !!counts?.urgent && (
                  <span className="rounded-full bg-destructive/10 px-2 py-0.5 text-xs font-medium text-destructive dark:bg-destructive/20">
                    {counts.urgent} urgent
                  </span>
                )}
              </span>
              <span className="text-sm font-medium leading-tight">{card.label}</span>
              <span className="text-xs text-muted-foreground">{card.hint}</span>
            </button>
          );
        })}
      </div>
      {error && (
        <div className="flex flex-wrap items-center gap-2 text-sm text-destructive" role="alert">
          <AlertCircle className="size-4 shrink-0" aria-hidden />
          <span className="min-w-0 [overflow-wrap:anywhere]">Could not load the counts: {error}</span>
          <Button variant="link" size="sm" className="h-auto px-0" onClick={onRetry}>
            Retry
          </Button>
        </div>
      )}
    </section>
  );
}

function ViewTabs({
  views,
  active,
  counts,
  onChange,
}: {
  views: readonly DocumentViewDef[];
  active: DocumentView;
  counts: DocumentDashboard | null;
  onChange: (view: DocumentView) => void;
}) {
  const refs = useRef<Record<string, HTMLButtonElement | null>>({});

  const onKeyDown = (e: React.KeyboardEvent) => {
    const index = views.findIndex((v) => v.key === active);
    let next = -1;
    if (e.key === "ArrowRight") next = (index + 1) % views.length;
    else if (e.key === "ArrowLeft") next = (index - 1 + views.length) % views.length;
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = views.length - 1;
    if (next < 0) return;
    e.preventDefault();
    onChange(views[next].key);
    refs.current[views[next].key]?.focus();
  };

  return (
    <div
      role="tablist"
      aria-label="Document views"
      className="-mx-1 flex gap-1 overflow-x-auto border-b px-1"
      onKeyDown={onKeyDown}
    >
      {views.map((v) => {
        const selected = v.key === active;
        const count = viewCount(counts, v.key);
        return (
          <button
            key={v.key}
            ref={(el) => {
              refs.current[v.key] = el;
            }}
            type="button"
            role="tab"
            id={`documents-tab-${v.key}`}
            aria-selected={selected}
            aria-controls="documents-panel"
            tabIndex={selected ? 0 : -1}
            onClick={() => onChange(v.key)}
            className={cn(
              "-mb-px inline-flex shrink-0 items-center gap-1.5 border-b-2 px-3 py-2 text-sm font-medium whitespace-nowrap transition-colors outline-none focus-visible:ring-3 focus-visible:ring-ring/50",
              selected
                ? "border-primary text-foreground"
                : "border-transparent text-muted-foreground hover:text-foreground"
            )}
          >
            {v.label}
            {count !== null && count > 0 && (
              <span
                className={cn(
                  "rounded-full px-1.5 py-0.5 text-xs tabular-nums",
                  v.key === "overdue"
                    ? "bg-destructive/10 text-destructive dark:bg-destructive/20"
                    : "bg-muted text-muted-foreground"
                )}
              >
                {count}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}
