"use client";

import { useEffect, useMemo, useState } from "react";
import { Search, X } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { nativeSelectClass } from "@/components/org/department-select";
import { listDocTypes, listRegisters } from "@/lib/services/documents";
import { hasActiveFilters, normalizeFilters, type DocumentFilters as Filters } from "@/lib/documents/filters";
import { DIRECTION_LABELS, URGENCY_LABELS, statusLabel } from "@/lib/documents/labels";
import {
  DIRECTIONS,
  INCOMING_STATUSES,
  OUTGOING_STATUSES,
  URGENCIES,
  statusesFor,
  type DocRegister,
  type DocType,
  type DocumentStatus,
} from "@/lib/documents/types";
import { getErrorMessage } from "@/lib/types/database";
import { cn } from "@/lib/utils";

// Inbox filters: free-text search (debounced), the profile selects and a date
// range. The parent owns the filters and writes them to the URL; every change
// here is normalized first, so a direction change also drops statuses and a
// register that do not belong to it.

const SEARCH_DEBOUNCE_MS = 300;
/** Years offered besides the ones registers exist for. */
const RECENT_YEARS = 6;

const ALL_STATUSES: readonly DocumentStatus[] = [
  ...new Set<DocumentStatus>([...INCOMING_STATUSES, ...OUTGOING_STATUSES]),
];

/** The search text as the server will see it (trimmed, spaces collapsed). */
function normalizedQuery(text: string): string {
  return normalizeFilters({ q: text }).q ?? "";
}

export function DocumentFilters({
  filters,
  onChange,
  today,
  className,
}: {
  filters: Filters;
  onChange: (next: Filters) => void;
  /** yyyy-mm-dd in the company time zone (year options) */
  today: string;
  className?: string;
}) {
  const [docTypes, setDocTypes] = useState<DocType[]>([]);
  const [registers, setRegisters] = useState<DocRegister[]>([]);
  const [lookupError, setLookupError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    // inactive types and closed registers stay selectable: old documents use them
    Promise.all([listDocTypes(true), listRegisters()])
      .then(([types, regs]) => {
        if (cancelled) return;
        setDocTypes(types);
        setRegisters(regs);
      })
      .catch((err: unknown) => {
        if (!cancelled) setLookupError(getErrorMessage(err));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // ---- search text: local while typing, applied after a pause
  const appliedQuery = filters.q ?? "";
  const [text, setText] = useState(appliedQuery);
  const [syncedQuery, setSyncedQuery] = useState(appliedQuery);
  if (appliedQuery !== syncedQuery) {
    // changed from outside (Clear filters, URL): show it unless it is what we typed
    setSyncedQuery(appliedQuery);
    if (normalizedQuery(text) !== appliedQuery) setText(appliedQuery);
  }

  useEffect(() => {
    const next = normalizedQuery(text);
    if (next === (filters.q ?? "")) return;
    const timer = setTimeout(() => onChange(normalizeFilters({ ...filters, q: next })), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [text, filters, onChange]);

  const update = (patch: Partial<Filters>) => {
    onChange(normalizeFilters({ ...filters, ...patch }));
  };

  const applySearchNow = () => {
    const next = normalizedQuery(text);
    if (next !== (filters.q ?? "")) update({ q: next });
  };

  // ---- options
  const statusOptions = filters.direction ? statusesFor(filters.direction) : ALL_STATUSES;

  const registerOptions = useMemo(
    () =>
      registers.filter(
        (r) =>
          r.id === filters.register_id ||
          ((!filters.direction || r.direction === filters.direction) && (!filters.year || r.year === filters.year))
      ),
    [registers, filters.direction, filters.year, filters.register_id]
  );

  const yearOptions = useMemo(() => {
    const current = Number(today.slice(0, 4)) || new Date().getFullYear();
    const years = new Set<number>();
    for (let i = 0; i < RECENT_YEARS; i++) years.add(current - i);
    for (const r of registers) years.add(r.year);
    if (filters.year) years.add(filters.year);
    return [...years].sort((a, b) => b - a);
  }, [today, registers, filters.year]);

  const statusValue =
    filters.status?.length === 1 ? filters.status[0] : filters.status?.length ? "__several" : "";

  const onDirectionChange = (value: string) => {
    const direction = (DIRECTIONS as readonly string[]).includes(value)
      ? (value as Filters["direction"])
      : undefined;
    const register = registers.find((r) => r.id === filters.register_id);
    const keepRegister = !direction || !register || register.direction === direction;
    update({ direction, register_id: keepRegister ? filters.register_id : undefined });
  };

  const active = hasActiveFilters(filters);
  const field = "flex min-w-0 flex-col gap-1.5";
  const labelClass = "text-xs font-medium text-muted-foreground";

  return (
    <div className={cn("space-y-3", className)} role="search" aria-label="Filter documents">
      <div className="relative">
        <Search
          className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground"
          aria-hidden
        />
        <Input
          type="search"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              applySearchNow();
            }
          }}
          maxLength={200}
          placeholder="Search subject, number, issuer or content…"
          aria-label="Search documents"
          className="h-9 pr-9 pl-8"
        />
        {text && (
          <button
            type="button"
            onClick={() => {
              setText("");
              update({ q: "" });
            }}
            className="absolute top-1/2 right-1.5 inline-flex size-6 -translate-y-1/2 items-center justify-center rounded-md text-muted-foreground outline-none hover:bg-muted hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50"
            aria-label="Clear search"
          >
            <X className="size-3.5" aria-hidden />
          </button>
        )}
      </div>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        <div className={field}>
          <Label htmlFor="doc-filter-direction" className={labelClass}>
            Direction
          </Label>
          <select
            id="doc-filter-direction"
            className={nativeSelectClass}
            value={filters.direction ?? ""}
            onChange={(e) => onDirectionChange(e.target.value)}
          >
            <option value="">All directions</option>
            {DIRECTIONS.map((d) => (
              <option key={d} value={d}>
                {DIRECTION_LABELS[d]}
              </option>
            ))}
          </select>
        </div>

        <div className={field}>
          <Label htmlFor="doc-filter-type" className={labelClass}>
            Type
          </Label>
          <select
            id="doc-filter-type"
            className={nativeSelectClass}
            value={filters.doc_type_id ?? ""}
            onChange={(e) => update({ doc_type_id: e.target.value || undefined })}
          >
            <option value="">All types</option>
            {filters.doc_type_id && !docTypes.some((t) => t.id === filters.doc_type_id) && (
              <option value={filters.doc_type_id}>Selected type</option>
            )}
            {docTypes.map((t) => (
              <option key={t.id} value={t.id}>
                {t.active ? t.name : `${t.name} (inactive)`}
              </option>
            ))}
          </select>
        </div>

        <div className={field}>
          <Label htmlFor="doc-filter-urgency" className={labelClass}>
            Urgency
          </Label>
          <select
            id="doc-filter-urgency"
            className={nativeSelectClass}
            value={filters.urgency ?? ""}
            onChange={(e) => update({ urgency: (e.target.value || undefined) as Filters["urgency"] })}
          >
            <option value="">Any urgency</option>
            {URGENCIES.map((u) => (
              <option key={u} value={u}>
                {URGENCY_LABELS[u]}
              </option>
            ))}
          </select>
        </div>

        <div className={field}>
          <Label htmlFor="doc-filter-status" className={labelClass}>
            Status
          </Label>
          <select
            id="doc-filter-status"
            className={nativeSelectClass}
            value={statusValue}
            onChange={(e) =>
              update({ status: e.target.value ? [e.target.value as DocumentStatus] : undefined })
            }
          >
            <option value="">Any status</option>
            {statusValue === "__several" && (
              <option value="__several" disabled>
                {filters.status?.length} statuses
              </option>
            )}
            {statusOptions.map((s) => (
              <option key={s} value={s}>
                {statusLabel(s)}
              </option>
            ))}
          </select>
        </div>

        <div className={field}>
          <Label htmlFor="doc-filter-register" className={labelClass}>
            Register (Sổ)
          </Label>
          <select
            id="doc-filter-register"
            className={nativeSelectClass}
            value={filters.register_id ?? ""}
            onChange={(e) => update({ register_id: e.target.value || undefined })}
          >
            <option value="">All registers</option>
            {filters.register_id && !registers.some((r) => r.id === filters.register_id) && (
              <option value={filters.register_id}>Selected register</option>
            )}
            {registerOptions.map((r) => (
              <option key={r.id} value={r.id}>
                {r.name} ({r.year})
              </option>
            ))}
          </select>
        </div>

        <div className={field}>
          <Label htmlFor="doc-filter-year" className={labelClass}>
            Year
          </Label>
          <select
            id="doc-filter-year"
            className={nativeSelectClass}
            value={filters.year ? String(filters.year) : ""}
            onChange={(e) => update({ year: e.target.value ? Number(e.target.value) : undefined })}
          >
            <option value="">Any year</option>
            {yearOptions.map((y) => (
              <option key={y} value={y}>
                {y}
              </option>
            ))}
          </select>
        </div>
      </div>

      <div className="flex flex-wrap items-end gap-3">
        <div className={cn(field, "w-[calc(50%-0.375rem)] sm:w-44")}>
          <Label htmlFor="doc-filter-from" className={labelClass}>
            From
          </Label>
          <Input
            id="doc-filter-from"
            type="date"
            value={filters.date_from ?? ""}
            max={filters.date_to}
            onChange={(e) => update({ date_from: e.target.value || undefined })}
          />
        </div>
        <div className={cn(field, "w-[calc(50%-0.375rem)] sm:w-44")}>
          <Label htmlFor="doc-filter-to" className={labelClass}>
            To
          </Label>
          <Input
            id="doc-filter-to"
            type="date"
            value={filters.date_to ?? ""}
            min={filters.date_from}
            onChange={(e) => update({ date_to: e.target.value || undefined })}
          />
        </div>
        <p className="pb-2 text-xs text-muted-foreground">Document date, else arrival date.</p>
        {active && (
          <button
            type="button"
            onClick={() => {
              setText("");
              onChange({ view: filters.view });
            }}
            className="ml-auto pb-2 text-sm font-medium text-primary underline-offset-4 outline-none hover:underline focus-visible:underline"
          >
            Clear filters
          </button>
        )}
      </div>

      {lookupError && (
        <p className="text-xs text-destructive" role="alert">
          Could not load types and registers: {lookupError}
        </p>
      )}
    </div>
  );
}
