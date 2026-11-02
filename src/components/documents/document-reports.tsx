"use client";

import Link from "next/link";
import { Fragment, useEffect, useMemo, useState } from "react";
import { BarChart3, ChevronDown, ChevronRight, Download, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { DepartmentSelect } from "@/components/org/department-select";
import { downloadCsv } from "@/components/documents/register-print";
import { getMyOrg, listDepartments, type Department, type MyOrg } from "@/lib/services/org";
import {
  reportIncoming,
  reportOutgoing,
  type IncomingReportRow,
  type OutgoingReportRow,
} from "@/lib/services/document-search";
import { todayIn } from "@/lib/documents/deadlines";
import { isIsoDay } from "@/lib/documents/filters";
import {
  formatDays,
  formatDuration,
  groupReportRows,
  incomingReportCsv,
  monthRange,
  onTimeRate,
  outgoingReportCsv,
  pivotOutgoing,
  type ReportCounts,
} from "@/lib/documents/report-format";
import { hasRole } from "@/lib/org";
import { getErrorMessage } from "@/lib/types/database";
import { cn } from "@/lib/utils";

// Documents reports: processing of incoming documents per department and
// person (Tình hình giải quyết văn bản đến) and issued outgoing documents per
// month and type. Leaders, clerks and admins see the whole company; a
// department head only the departments they head (the RPC enforces it).

type Base = { org: MyOrg | null; departments: Department[] };

type Loaded<T> = { key: string; rows: T[] } | { key: string; error: string };

export default function DocumentReports({ userId }: { userId: string }) {
  const [base, setBase] = useState<Base | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    getMyOrg()
      .then(async (org) => {
        // departments are readable by active members only
        const departments = org && org.me.status === "active" ? await listDepartments() : [];
        if (!cancelled) setBase({ org, departments });
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(getErrorMessage(err));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (error) {
    return (
      <p className="text-sm text-destructive" role="alert">
        {error}
      </p>
    );
  }
  if (!base) return <Loading label="Loading reports…" />;

  const me = base.org?.me;
  const active = me?.status === "active";
  const seeAll = active && (hasRole(me, "leader") || hasRole(me, "org_admin") || hasRole(me, "clerk"));
  const isHead = active && hasRole(me, "dept_head");
  if (!base.org || (!seeAll && !isHead)) {
    return (
      <div className="max-w-xl rounded-xl border border-dashed p-6 text-sm text-muted-foreground" role="status">
        {base.org ? (
          "Reports are for leaders, clerks, admins and department heads."
        ) : (
          <>
            Join or create a company first.{" "}
            <Link href="/org" className="text-primary underline-offset-4 hover:underline">
              Go to Company
            </Link>
          </>
        )}
      </div>
    );
  }

  return (
    <ReportsView
      org={base.org}
      departments={base.departments}
      userId={userId}
      seeAll={seeAll}
    />
  );
}

function ReportsView({
  org,
  departments,
  userId,
  seeAll,
}: {
  org: MyOrg;
  departments: Department[];
  userId: string;
  seeAll: boolean;
}) {
  const month = monthRange(todayIn(org.org.timezone));
  const [from, setFrom] = useState(month?.from ?? "");
  const [to, setTo] = useState(month?.to ?? "");
  const [departmentId, setDepartmentId] = useState<string | null>(null);
  const [incoming, setIncoming] = useState<Loaded<IncomingReportRow> | null>(null);
  const [outgoing, setOutgoing] = useState<Loaded<OutgoingReportRow> | null>(null);

  const rangeError =
    !isIsoDay(from) || !isIsoDay(to) ? "Choose both dates" : from > to ? "The start date is after the end date" : null;

  // a department head may filter only by the departments they head
  const excludeIds = useMemo(
    () => (seeAll ? [] : departments.filter((d) => d.head_user_id !== userId).map((d) => d.id)),
    [departments, seeAll, userId]
  );

  const incomingKey = rangeError ? null : `${from}|${to}|${departmentId ?? ""}`;
  const outgoingKey = rangeError || !seeAll ? null : `${from}|${to}`;

  useEffect(() => {
    if (!incomingKey) return;
    let cancelled = false;
    reportIncoming(from, to, departmentId)
      .then((rows) => {
        if (!cancelled) setIncoming({ key: incomingKey, rows });
      })
      .catch((err: unknown) => {
        if (!cancelled) setIncoming({ key: incomingKey, error: getErrorMessage(err) });
      });
    return () => {
      cancelled = true;
    };
  }, [incomingKey, from, to, departmentId]);

  useEffect(() => {
    if (!outgoingKey) return;
    let cancelled = false;
    reportOutgoing(from, to)
      .then((rows) => {
        if (!cancelled) setOutgoing({ key: outgoingKey, rows });
      })
      .catch((err: unknown) => {
        if (!cancelled) setOutgoing({ key: outgoingKey, error: getErrorMessage(err) });
      });
    return () => {
      cancelled = true;
    };
  }, [outgoingKey, from, to]);

  const fileSuffix = `${from}_${to}`;

  return (
    <div className="max-w-6xl space-y-6">
      <div className="flex flex-wrap items-center gap-3">
        <BarChart3 className="size-7 shrink-0 text-primary" aria-hidden />
        <div className="min-w-0">
          <h2 className="text-2xl font-bold">Document reports</h2>
          <p className="text-sm text-muted-foreground">
            {seeAll
              ? "Whole company. Incoming documents count by arrival date; outgoing by issue date."
              : "The departments you head. Incoming documents count by arrival date."}
          </p>
        </div>
      </div>

      <div className="grid gap-3 rounded-xl border p-3 sm:grid-cols-3" role="group" aria-label="Report filters">
        <div className="space-y-1.5">
          <Label htmlFor="rep-from">From</Label>
          <Input id="rep-from" type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="rep-to">To</Label>
          <Input id="rep-to" type="date" value={to} onChange={(e) => setTo(e.target.value)} />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="rep-dept">Department</Label>
          <DepartmentSelect
            id="rep-dept"
            value={departmentId}
            onChange={setDepartmentId}
            excludeIds={excludeIds}
            allowNone
            placeholder={seeAll ? "All departments" : "All my departments"}
          />
        </div>
        {rangeError && (
          <p className="text-sm text-destructive sm:col-span-3" role="alert">
            {rangeError}
          </p>
        )}
      </div>

      <IncomingSection
        state={incoming}
        currentKey={incomingKey}
        onExport={(csv) => downloadCsv(`incoming-processing_${fileSuffix}.csv`, csv)}
      />

      {seeAll ? (
        <OutgoingSection
          state={outgoing}
          currentKey={outgoingKey}
          onExport={(csv) => downloadCsv(`outgoing-documents_${fileSuffix}.csv`, csv)}
        />
      ) : (
        <p className="text-sm text-muted-foreground">
          The outgoing documents report is for leaders, clerks and admins.
        </p>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- incoming

const INCOMING_COLUMNS: { key: Exclude<keyof ReportCounts, "avg_days">; label: string }[] = [
  { key: "received", label: "Received" },
  { key: "done_on_time", label: "Done on time" },
  { key: "done_late", label: "Done late" },
  { key: "open_on_time", label: "Open (on time)" },
  { key: "open_overdue", label: "Open (overdue)" },
];

function IncomingSection({
  state,
  currentKey,
  onExport,
}: {
  state: Loaded<IncomingReportRow> | null;
  currentKey: string | null;
  onExport: (csv: string) => void;
}) {
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const rows = state && "rows" in state ? state.rows : null;
  const groups = useMemo(() => (rows ? groupReportRows(rows) : null), [rows]);
  const departments = (groups ?? []).filter((g) => g.kind === "department");
  const loading = currentKey !== null && state?.key !== currentKey;
  const allOpen = departments.length > 0 && departments.every((g) => expanded.has(g.key));

  const toggle = (key: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  return (
    <Card>
      <CardHeader className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <CardTitle>Incoming processing (Tình hình giải quyết văn bản đến)</CardTitle>
          <CardDescription>
            Lead (chủ trì) assignments of incoming documents that arrived in the range. On time = done on time out
            of everything done or overdue.
          </CardDescription>
        </div>
        <div className="flex flex-wrap gap-2">
          {departments.length > 0 && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setExpanded(allOpen ? new Set() : new Set(departments.map((g) => g.key)))}
            >
              {allOpen ? "Collapse all" : "Expand all"}
            </Button>
          )}
          <Button
            variant="outline"
            size="sm"
            disabled={!groups || loading}
            onClick={() => groups && onExport(incomingReportCsv(groups))}
          >
            <Download aria-hidden />
            Export CSV
          </Button>
        </div>
      </CardHeader>
      <CardContent>
        {state && "error" in state && state.key === currentKey ? (
          <p className="text-sm text-destructive" role="alert">
            {state.error}
          </p>
        ) : !groups ? (
          currentKey ? <Loading label="Loading report…" /> : null
        ) : (
          <div className={cn("overflow-x-auto rounded-lg border", loading && "opacity-60")} aria-busy={loading}>
            <table className="w-full min-w-[44rem] text-sm">
              <thead>
                <tr className="border-b bg-muted/50">
                  <th scope="col" className="px-3 py-2 text-left font-medium">
                    Department / person
                  </th>
                  {INCOMING_COLUMNS.map((c) => (
                    <th key={c.key} scope="col" className="px-3 py-2 text-right font-medium whitespace-nowrap">
                      {c.label}
                    </th>
                  ))}
                  <th scope="col" className="px-3 py-2 text-right font-medium whitespace-nowrap">
                    Avg days
                  </th>
                  <th scope="col" className="px-3 py-2 text-right font-medium whitespace-nowrap">
                    On time
                  </th>
                </tr>
              </thead>
              <tbody>
                {departments.length === 0 && (
                  <tr className="border-b">
                    <td colSpan={INCOMING_COLUMNS.length + 3} className="px-3 py-6 text-center text-muted-foreground">
                      No assigned incoming documents in this range.
                    </td>
                  </tr>
                )}
                {(groups ?? []).map((g) => {
                  if (g.kind === "total") {
                    return (
                      <tr key={g.key} className="bg-muted/40 font-bold">
                        <th scope="row" className="px-3 py-2 text-left">
                          Total
                        </th>
                        <Numbers row={g} />
                      </tr>
                    );
                  }
                  const open = expanded.has(g.key);
                  const panelIds = g.people.map((p) => `rep-${p.key}`).join(" ");
                  return (
                    <Fragment key={g.key}>
                      <tr className="border-b font-medium">
                        <th scope="row" className="px-3 py-1.5 text-left font-medium">
                          <button
                            type="button"
                            onClick={() => toggle(g.key)}
                            aria-expanded={open}
                            aria-controls={open ? panelIds : undefined}
                            className="-mx-1 inline-flex items-center gap-1 rounded-md px-1 py-0.5 text-left hover:bg-muted focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none"
                          >
                            {open ? (
                              <ChevronDown className="size-4 shrink-0" aria-hidden />
                            ) : (
                              <ChevronRight className="size-4 shrink-0" aria-hidden />
                            )}
                            <span className="[overflow-wrap:anywhere]">{g.label}</span>
                            <span className="text-xs font-normal text-muted-foreground">({g.people.length})</span>
                          </button>
                        </th>
                        <Numbers row={g} />
                      </tr>
                      {open &&
                        g.people.map((p) => (
                          <tr key={p.key} id={`rep-${p.key}`} className="border-b text-muted-foreground">
                            <th scope="row" className="py-1.5 pr-3 pl-9 text-left font-normal">
                              <span className="[overflow-wrap:anywhere]">{p.label}</span>
                            </th>
                            <Numbers row={p} />
                          </tr>
                        ))}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function Numbers({ row }: { row: ReportCounts }) {
  return (
    <>
      {INCOMING_COLUMNS.map((c) => (
        <td
          key={c.key}
          className={cn(
            "px-3 py-1.5 text-right tabular-nums",
            c.key === "open_overdue" && row.open_overdue > 0 && "text-destructive"
          )}
        >
          {row[c.key]}
        </td>
      ))}
      <td className="px-3 py-1.5 text-right tabular-nums">{formatDays(row.avg_days)}</td>
      <td className="px-3 py-1.5 text-right tabular-nums">{onTimeRate(row)}</td>
    </>
  );
}

// ---------------------------------------------------------------- outgoing

function OutgoingSection({
  state,
  currentKey,
  onExport,
}: {
  state: Loaded<OutgoingReportRow> | null;
  currentKey: string | null;
  onExport: (csv: string) => void;
}) {
  const rows = state && "rows" in state ? state.rows : null;
  const table = useMemo(() => (rows ? pivotOutgoing(rows) : null), [rows]);
  const loading = currentKey !== null && state?.key !== currentKey;

  return (
    <Card>
      <CardHeader className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <CardTitle>Outgoing documents (Văn bản đi)</CardTitle>
          <CardDescription>
            Outgoing and internal documents issued in the range, by month and type. Approval time runs from the final
            submission to signing.
          </CardDescription>
        </div>
        <Button
          variant="outline"
          size="sm"
          disabled={!rows || loading}
          onClick={() => rows && onExport(outgoingReportCsv(rows))}
        >
          <Download aria-hidden />
          Export CSV
        </Button>
      </CardHeader>
      <CardContent>
        {state && "error" in state && state.key === currentKey ? (
          <p className="text-sm text-destructive" role="alert">
            {state.error}
          </p>
        ) : !table ? (
          currentKey ? <Loading label="Loading report…" /> : null
        ) : table.months.length === 0 ? (
          <p className={cn("rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground", loading && "opacity-60")}>
            No documents issued in this range.
          </p>
        ) : (
          <div className={cn("overflow-x-auto rounded-lg border", loading && "opacity-60")} aria-busy={loading}>
            <table className="w-full text-sm">
              <caption className="sr-only">
                Issued documents per month and type, with the average approval time under each count
              </caption>
              <thead>
                <tr className="border-b bg-muted/50">
                  <th scope="col" className="px-3 py-2 text-left font-medium">
                    Month
                  </th>
                  {table.types.map((t) => (
                    <th key={t} scope="col" className="min-w-28 px-3 py-2 text-right font-medium">
                      {t}
                    </th>
                  ))}
                  <th scope="col" className="min-w-28 px-3 py-2 text-right font-medium">
                    Total
                  </th>
                </tr>
              </thead>
              <tbody>
                {table.months.map((m) => (
                  <tr key={m.month} className="border-b">
                    <th scope="row" className="px-3 py-1.5 text-left font-medium tabular-nums">
                      {m.label}
                    </th>
                    {table.types.map((t) => (
                      <OutgoingCellView key={t} cell={m.cells[t]} />
                    ))}
                    <OutgoingCellView cell={m} />
                  </tr>
                ))}
                <tr className="bg-muted/40 font-bold">
                  <th scope="row" className="px-3 py-2 text-left">
                    Total
                  </th>
                  {table.types.map((t) => (
                    <OutgoingCellView key={t} cell={table.typeTotals[t]} />
                  ))}
                  <OutgoingCellView cell={table.total} />
                </tr>
              </tbody>
            </table>
            <p className="border-t px-3 py-2 text-xs text-muted-foreground">
              Each cell: issued count, then the average approval time (Avg approval time). Totals weight the averages by
              the number issued.
            </p>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function OutgoingCellView({ cell }: { cell: { issued: number; avg_approval_hours: number | null } | undefined }) {
  if (!cell) {
    return <td className="px-3 py-1.5 text-right text-muted-foreground">—</td>;
  }
  return (
    <td className="px-3 py-1.5 text-right tabular-nums">
      <span className="block">{cell.issued}</span>
      <span className="block text-xs font-normal text-muted-foreground">
        <span className="sr-only">Avg approval time </span>
        {formatDuration(cell.avg_approval_hours)}
      </span>
    </td>
  );
}

function Loading({ label }: { label: string }) {
  return (
    <div className="flex items-center gap-2 text-sm text-muted-foreground" role="status">
      <Loader2 className="size-4 animate-spin" aria-hidden />
      {label}
    </div>
  );
}
