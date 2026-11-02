"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { ArrowLeft, Download, Loader2, Printer } from "lucide-react";
import { Button, buttonVariants } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { getMyOrg, type MyOrg } from "@/lib/services/org";
import { listRegisters } from "@/lib/services/documents";
import { listRegisterEntries, type RegisterEntryFilter } from "@/lib/services/document-admin";
import { DEFAULT_ORG_TIME_ZONE } from "@/lib/documents/deadlines";
import { isIsoDay } from "@/lib/documents/filters";
import { padNumber } from "@/lib/documents/numbering";
import {
  formatRegisterDate,
  registerColumns,
  registerRows,
  registerTitle,
  toCsv,
  type RegisterColumn,
  type RegisterEntry,
} from "@/lib/documents/register-export";
import type { DocRegister } from "@/lib/documents/types";
import { getErrorMessage } from "@/lib/types/database";
import { cn } from "@/lib/utils";

// Printable register book (Decree 30 Phụ lục IV): filters, the header block,
// the table with an empty 'Ký nhận' column for pen signatures, Print (A4
// landscape) and Export CSV. Only the print area shows on paper.

/** Saves `text` as a UTF-8 CSV download. */
export function downloadCsv(filename: string, text: string) {
  const url = URL.createObjectURL(new Blob([text], { type: "text/csv;charset=utf-8" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // give the browser a moment to start the download before revoking
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// Everything but the print area is hidden on paper; the area is moved to the
// top-left corner of the first page.
const PRINT_CSS = `
@page { size: A4 landscape; margin: 10mm; }
@media print {
  body * { visibility: hidden !important; }
  .register-print-area, .register-print-area * { visibility: visible !important; }
  .register-print-area { position: absolute; inset: 0 auto auto 0; width: 100%; padding: 0 !important; border: 0 !important; color: #000 !important; background: #fff !important; opacity: 1 !important; }
  .register-print-area .register-print-scroll { overflow: visible !important; }
  .register-print-area table { font-size: 9pt; border-collapse: collapse; width: 100%; min-width: 0 !important; }
  .register-print-area th, .register-print-area td { border: 1px solid #000 !important; padding: 2pt 3pt; color: #000 !important; }
  .register-print-area thead { display: table-header-group; }
  .register-print-area tr { break-inside: avoid; }
}
`;

type Base = { org: MyOrg | null; register: DocRegister | null };

type Filters = { from: string; to: string; fromNumber: string; toNumber: string };
const EMPTY_FILTERS: Filters = { from: "", to: "", fromNumber: "", toNumber: "" };

function parseNumber(value: string): number | null {
  if (!value.trim()) return null;
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : Number.NaN;
}

function filterProblem(f: Filters): string | null {
  if ((f.from && !isIsoDay(f.from)) || (f.to && !isIsoDay(f.to))) return "Enter valid dates";
  if (f.from && f.to && f.from > f.to) return "The start date is after the end date";
  const a = parseNumber(f.fromNumber);
  const b = parseNumber(f.toNumber);
  if (Number.isNaN(a) || Number.isNaN(b)) return "Numbers must be whole numbers from 1";
  if (a !== null && b !== null && a > b) return "The first number is larger than the last";
  return null;
}

function toFilter(f: Filters): RegisterEntryFilter {
  return {
    from: f.from || null,
    to: f.to || null,
    fromNumber: parseNumber(f.fromNumber),
    toNumber: parseNumber(f.toNumber),
  };
}

const entryDay = (e: RegisterEntry) => ("arrival_number" in e ? e.arrival_date : e.issued_date);
const entryNumber = (e: RegisterEntry) => ("arrival_number" in e ? e.arrival_number : e.number);

export default function RegisterPrint({ registerId }: { registerId: string }) {
  const [base, setBase] = useState<Base | undefined>(undefined);
  const [baseError, setBaseError] = useState<string | null>(null);
  const [draft, setDraft] = useState<Filters>(EMPTY_FILTERS);
  const [applied, setApplied] = useState<Filters>(EMPTY_FILTERS);
  const [draftError, setDraftError] = useState<string | null>(null);
  const [version, setVersion] = useState(0);
  const [entries, setEntries] = useState<{ key: string; rows: RegisterEntry[] } | null>(null);
  const [entriesError, setEntriesError] = useState<{ key: string; message: string } | null>(null);

  useEffect(() => {
    let cancelled = false;
    Promise.all([getMyOrg(), listRegisters(null, null)])
      .then(([org, registers]) => {
        if (cancelled) return;
        setBase({ org, register: registers.find((r) => r.id === registerId) ?? null });
      })
      .catch((err: unknown) => {
        if (!cancelled) setBaseError(getErrorMessage(err));
      });
    return () => {
      cancelled = true;
    };
  }, [registerId]);

  const key = `${JSON.stringify(applied)}:${version}`;
  const ready = Boolean(base?.register);

  useEffect(() => {
    if (!ready) return;
    let cancelled = false;
    listRegisterEntries(registerId, toFilter(applied))
      .then((rows) => {
        if (!cancelled) setEntries({ key, rows });
      })
      .catch((err: unknown) => {
        if (!cancelled) setEntriesError({ key, message: getErrorMessage(err) });
      });
    return () => {
      cancelled = true;
    };
  }, [ready, registerId, applied, key]);

  const register = base?.register ?? null;
  const timeZone = base?.org?.org.timezone || DEFAULT_ORG_TIME_ZONE;
  const columns = useMemo<readonly RegisterColumn[]>(
    () => (register ? registerColumns(register.direction) : []),
    [register]
  );
  const loading = ready && entries?.key !== key && entriesError?.key !== key;
  const listError = entriesError?.key === key ? entriesError.message : null;
  const rowsShown = useMemo(() => (entries && entries.key === key ? entries.rows : []), [entries, key]);
  const printable = useMemo(
    () =>
      registerRows(rowsShown).map((row, i) => {
        const entry = rowsShown[i];
        // an unreadable outgoing row has no notation: print its bare number
        if (!("arrival_number" in entry) && !entry.notation && entry.number != null) {
          return { ...row, notation: padNumber(entry.number) };
        }
        return row;
      }),
    [rowsShown]
  );

  const range = useMemo(() => {
    const days = rowsShown.map(entryDay).filter((d): d is string => Boolean(d)).sort();
    const numbers = rowsShown.map(entryNumber).filter((n): n is number => n != null);
    const show = (day: string | null | undefined) => (day ? formatRegisterDate(day, timeZone) : "…");
    return {
      from: show(applied.from || days[0]),
      to: show(applied.to || days.at(-1)),
      fromNumber: applied.fromNumber || (numbers.length ? String(Math.min(...numbers)) : "…"),
      toNumber: applied.toNumber || (numbers.length ? String(Math.max(...numbers)) : "…"),
    };
  }, [rowsShown, applied, timeZone]);

  if (baseError) {
    return (
      <p className="text-sm text-destructive" role="alert">
        {baseError}
      </p>
    );
  }
  if (!base) {
    return (
      <div className="flex items-center gap-2 text-sm text-muted-foreground" role="status">
        <Loader2 className="size-4 animate-spin" aria-hidden />
        Loading register…
      </div>
    );
  }
  if (!base.org || !register) {
    return (
      <div className="max-w-xl space-y-3 rounded-xl border border-dashed p-6 text-sm text-muted-foreground" role="status">
        <p>Register not found, or you cannot see it.</p>
        <Link href="/documents/registers" className="text-primary underline-offset-4 hover:underline">
          Back to registers
        </Link>
      </div>
    );
  }

  const apply = (e: React.FormEvent) => {
    e.preventDefault();
    const problem = filterProblem(draft);
    setDraftError(problem);
    if (problem) return;
    if (JSON.stringify(draft) === JSON.stringify(applied)) setVersion((v) => v + 1);
    else setApplied(draft);
  };

  const exportCsv = () => {
    const csv = toCsv(columns, printable, timeZone);
    const parts = [register.direction, register.year, applied.from, applied.to].filter(Boolean);
    downloadCsv(`register-${parts.join("-")}.csv`, csv);
  };

  return (
    <div className="max-w-full space-y-4">
      <style>{PRINT_CSS}</style>

      <div className="flex flex-wrap items-center gap-2 print:hidden">
        <Link href="/documents/registers" className={buttonVariants({ variant: "ghost", size: "sm" })}>
          <ArrowLeft aria-hidden />
          Registers
        </Link>
        <h2 className="min-w-0 flex-1 text-xl font-bold [overflow-wrap:anywhere]">{register.name}</h2>
        <Button variant="outline" onClick={exportCsv} disabled={loading || Boolean(listError)}>
          <Download aria-hidden />
          Export CSV
        </Button>
        <Button onClick={() => window.print()} disabled={loading || Boolean(listError)}>
          <Printer aria-hidden />
          Print
        </Button>
      </div>

      <form
        onSubmit={apply}
        className="grid gap-3 rounded-xl border p-3 sm:grid-cols-2 lg:grid-cols-[repeat(4,minmax(0,1fr))_auto] lg:items-end print:hidden"
        noValidate
        aria-label="Filters"
      >
        <FilterField id="rp-from" label={register.direction === "incoming" ? "Arrival from" : "Issued from"}>
          <Input
            id="rp-from"
            type="date"
            value={draft.from}
            onChange={(e) => setDraft({ ...draft, from: e.target.value })}
          />
        </FilterField>
        <FilterField id="rp-to" label="to">
          <Input id="rp-to" type="date" value={draft.to} onChange={(e) => setDraft({ ...draft, to: e.target.value })} />
        </FilterField>
        <FilterField id="rp-from-n" label={register.direction === "incoming" ? "Arrival no. from" : "Number from"}>
          <Input
            id="rp-from-n"
            type="number"
            inputMode="numeric"
            min={1}
            step={1}
            value={draft.fromNumber}
            onChange={(e) => setDraft({ ...draft, fromNumber: e.target.value })}
          />
        </FilterField>
        <FilterField id="rp-to-n" label="to">
          <Input
            id="rp-to-n"
            type="number"
            inputMode="numeric"
            min={1}
            step={1}
            value={draft.toNumber}
            onChange={(e) => setDraft({ ...draft, toNumber: e.target.value })}
          />
        </FilterField>
        <div className="flex gap-2 sm:col-span-2 lg:col-span-1">
          <Button type="submit">Apply</Button>
          <Button
            type="button"
            variant="ghost"
            onClick={() => {
              setDraft(EMPTY_FILTERS);
              setDraftError(null);
              setApplied(EMPTY_FILTERS);
            }}
          >
            Clear
          </Button>
        </div>
        {draftError && (
          <p className="text-sm text-destructive sm:col-span-2 lg:col-span-5" role="alert">
            {draftError}
          </p>
        )}
      </form>

      {listError ? (
        <p className="text-sm text-destructive" role="alert">
          {listError}
        </p>
      ) : (
        <div className={cn("register-print-area space-y-4 rounded-xl border bg-card p-4", loading && "opacity-60")} aria-busy={loading}>
          <div className="space-y-1 text-center">
            <p className="text-sm font-semibold uppercase">{base.org.org.name}</p>
            <p className="text-lg font-bold">{registerTitle(register)}</p>
            <p className="text-sm">{register.name}</p>
            <p className="text-sm text-muted-foreground print:text-black">
              Từ ngày {range.from} đến ngày {range.to}, Từ số {range.fromNumber} đến số {range.toNumber}
            </p>
          </div>

          <div className="register-print-scroll overflow-x-auto">
            <table className="w-full min-w-[60rem] border-collapse text-xs">
              <thead>
                <tr>
                  {columns.map((c) => (
                    <th key={c.key} scope="col" className="border border-border bg-muted px-2 py-1.5 text-center font-semibold print:bg-transparent">
                      {c.header}
                    </th>
                  ))}
                </tr>
                <tr>
                  {columns.map((c, i) => (
                    <th key={c.key} scope="col" className="border border-border px-2 py-0.5 text-center font-normal text-muted-foreground print:text-black">
                      ({i + 1})
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {printable.length === 0 && !loading ? (
                  <tr>
                    <td colSpan={columns.length} className="border border-border px-2 py-6 text-center text-muted-foreground">
                      No numbered documents in this range.
                    </td>
                  </tr>
                ) : (
                  printable.map((row, i) => {
                    const entry = rowsShown[i];
                    return (
                      <tr key={entry.id} className="align-top">
                        {columns.map((c) => (
                          <td
                            key={c.key}
                            className={cn(
                              "border border-border px-2 py-1",
                              c.key === "type_subject" ? "min-w-64" : "whitespace-nowrap",
                              c.key === "signature" && "min-w-24",
                              !entry.readable && c.key === "type_subject" && "italic text-muted-foreground print:text-black"
                            )}
                          >
                            <Cell column={c} row={row} entry={entry} timeZone={timeZone} />
                          </td>
                        ))}
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>
          <p className="text-xs text-muted-foreground print:hidden">
            {printable.length} {printable.length === 1 ? "entry" : "entries"}. Rows you cannot read show
            &quot;Restricted document&quot;.
          </p>
        </div>
      )}
    </div>
  );
}

function Cell({
  column,
  row,
  entry,
  timeZone,
}: {
  column: RegisterColumn;
  row: Record<string, unknown>;
  entry: RegisterEntry;
  timeZone: string;
}) {
  const value = row[column.key];
  if (column.kind === "date") return <>{formatRegisterDate(value, timeZone)}</>;
  const text = value == null ? "" : String(value);
  // the subject links to the document on screen; on paper it is plain text
  if (column.key === "type_subject" && entry.readable) {
    return (
      <Link
        href={`/documents/${entry.id}`}
        className="text-primary underline-offset-4 hover:underline print:text-black print:no-underline"
      >
        {text}
      </Link>
    );
  }
  return <>{text}</>;
}

function FilterField({ id, label, children }: { id: string; label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id}>{label}</Label>
      {children}
    </div>
  );
}
