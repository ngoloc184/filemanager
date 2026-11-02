"use client";

import Link from "next/link";
import { useCallback, useEffect, useId, useMemo, useState } from "react";
import { Popover } from "@base-ui/react/popover";
import {
  BookOpen,
  CalendarPlus,
  ChevronLeft,
  ChevronRight,
  HelpCircle,
  Loader2,
  Lock,
  LockOpen,
  MoreHorizontal,
  Pencil,
  Plus,
  Printer,
  Trash2,
  Users,
} from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { nativeSelectClass } from "@/components/org/department-select";
import { PersonPicker } from "@/components/org/person-picker";
import { createClient } from "@/lib/supabase/client";
import { getMyOrg, type MyOrg } from "@/lib/services/org";
import { listDocTypes, listRegisters } from "@/lib/services/documents";
import {
  closeDocRegister,
  deleteDocRegister,
  listRegisterRoles,
  openNextYearRegisters,
  peekNextNumber,
  reopenDocRegister,
  setRegisterRole,
  upsertDocRegister,
  type RegisterRole,
  type RegisterRoleRow,
} from "@/lib/services/document-admin";
import { todayIn } from "@/lib/documents/deadlines";
import { DIRECTION_LABELS } from "@/lib/documents/labels";
import {
  DEFAULT_CONG_VAN_TEMPLATE,
  DEFAULT_NOTATION_TEMPLATE,
  padNumber,
  renderNotation,
} from "@/lib/documents/numbering";
import { DIRECTIONS, type Direction, type DocRegister, type DocType, type RegisterScope } from "@/lib/documents/types";
import { hasRole, memberLabel } from "@/lib/org";
import { getErrorMessage } from "@/lib/types/database";
import { cn } from "@/lib/utils";

// Register books (sổ văn bản) per year: admins create, edit, close, delete
// and staff them; clerks, managers and followers see them and print them.

const SCOPE_LABELS: Record<RegisterScope, string> = {
  register: "Per register",
  register_type: "Per register and type",
};

const SCOPE_HINTS: Record<RegisterScope, string> = {
  register: "One number sequence for the whole register (nhảy số theo sổ).",
  register_type: "A separate sequence for each document type (nhảy số theo sổ và loại).",
};

const ROLE_LABELS: Record<RegisterRole, string> = {
  manager: "Manager (Quản lý sổ)",
  follower: "Follower (Theo dõi)",
};

/** Sample values for the template previews. */
const SAMPLE_TYPE = "QĐ";
const SAMPLE_DEPT = "HCNS";

const TEMPLATE_TOKENS: { token: string; meaning: string }[] = [
  { token: "{n}", meaning: "The number, at least two digits (01, 02, … 123). Required." },
  { token: "{type}", meaning: "Document type abbreviation, e.g. QĐ, TB. Empty for công văn." },
  { token: "{org}", meaning: "Company code (from the company settings)." },
  { token: "{dept}", meaning: "Code of the drafting department." },
  { token: "{yyyy}", meaning: "The register year, e.g. 2026." },
];
const ALLOWED_TOKENS = new Set(TEMPLATE_TOKENS.map((t) => t.token));

/** Mirrors SQL doc_check_template: null when the template is usable. */
function templateProblem(template: string, label: string): string | null {
  const value = template.trim();
  if (value.length < 1 || value.length > 100) return `${label} must be 1 to 100 characters`;
  if (!value.includes("{n}")) return `${label} must contain {n} (the number)`;
  const bad = (value.match(/\{[^}]*\}/g) ?? []).find((token) => !ALLOWED_TOKENS.has(token));
  if (bad) return `${label} has an unknown token ${bad}; use {n}, {type}, {org}, {dept} or {yyyy}`;
  return null;
}

/** The registers this person holds a role in (any year). */
async function listMyRegisterRoles(userId: string): Promise<Map<string, RegisterRole>> {
  const { data, error } = await createClient()
    .from("doc_register_roles")
    .select("register_id, role")
    .eq("user_id", userId);
  if (error) throw new Error(getErrorMessage(error));
  return new Map(
    ((data ?? []) as { register_id: string; role: RegisterRole }[]).map((r) => [r.register_id, r.role])
  );
}

type Base = { org: MyOrg | null; myRoles: Map<string, RegisterRole> };

type YearData = {
  key: string;
  registers: DocRegister[];
  types: DocType[];
  /** next number per register; null when it cannot be previewed */
  next: Record<string, number | null>;
  /** an active 'QĐ' type exists: per-type registers preview its sequence */
  hasSampleType: boolean;
};

function currentYearOf(org: MyOrg): number {
  return Number(todayIn(org.org.timezone).slice(0, 4));
}

export default function RegistersClient({ userId }: { userId: string }) {
  const [base, setBase] = useState<Base | undefined>(undefined);
  const [baseError, setBaseError] = useState<string | null>(null);
  const [baseVersion, setBaseVersion] = useState(0);

  useEffect(() => {
    let cancelled = false;
    Promise.all([getMyOrg(), listMyRegisterRoles(userId)])
      .then(([org, myRoles]) => {
        if (cancelled) return;
        setBase({ org, myRoles });
        setBaseError(null);
      })
      .catch((err: unknown) => {
        if (!cancelled) setBaseError(getErrorMessage(err));
      });
    return () => {
      cancelled = true;
    };
  }, [userId, baseVersion]);

  if (baseError) {
    return (
      <div className="max-w-xl space-y-3">
        <p className="text-sm text-destructive" role="alert">
          {baseError}
        </p>
        <Button variant="outline" onClick={() => setBaseVersion((v) => v + 1)}>
          Try again
        </Button>
      </div>
    );
  }
  if (!base) return <Loading label="Loading registers…" />;
  if (!base.org) {
    return (
      <NoAccess>
        Join or create a company first.{" "}
        <Link href="/org" className="text-primary underline-offset-4 hover:underline">
          Go to Company
        </Link>
      </NoAccess>
    );
  }

  const { me } = base.org;
  const active = me.status === "active";
  const isAdmin = active && hasRole(me, "org_admin");
  const isClerk = active && hasRole(me, "clerk");
  if (!active || (!isAdmin && !isClerk && base.myRoles.size === 0)) {
    return <NoAccess>You do not have access to registers.</NoAccess>;
  }

  return (
    <RegistersView
      org={base.org}
      myRoles={base.myRoles}
      isAdmin={isAdmin}
      isClerk={isClerk}
      onRolesChanged={() => setBaseVersion((v) => v + 1)}
    />
  );
}

function RegistersView({
  org,
  myRoles,
  isAdmin,
  isClerk,
  onRolesChanged,
}: {
  org: MyOrg;
  myRoles: Map<string, RegisterRole>;
  isAdmin: boolean;
  isClerk: boolean;
  onRolesChanged: () => void;
}) {
  const currentYear = currentYearOf(org);
  const isDecember = todayIn(org.org.timezone).slice(5, 7) === "12";
  const [year, setYear] = useState(currentYear);
  const [version, setVersion] = useState(0);
  const [data, setData] = useState<YearData | null>(null);
  const [error, setError] = useState<{ key: string; message: string } | null>(null);
  const [editing, setEditing] = useState<DocRegister | { direction: Direction } | null>(null);
  const [people, setPeople] = useState<DocRegister | null>(null);
  const [confirm, setConfirm] = useState<{ kind: "close" | "delete"; register: DocRegister } | null>(null);
  const [opening, setOpening] = useState(false);

  const key = `${year}:${version}`;
  const seeAll = isAdmin || isClerk;

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const [registers, types] = await Promise.all([listRegisters(null, year), listDocTypes(true)]);
      const sampleType = types.find((t) => t.active && t.abbreviation === SAMPLE_TYPE) ?? null;
      const canPeek = (r: DocRegister) => isAdmin || isClerk || myRoles.get(r.id) === "manager";
      const peeks = await Promise.allSettled(
        registers.map((r) =>
          canPeek(r)
            ? peekNextNumber(r.id, r.scope === "register_type" ? (sampleType?.id ?? null) : null)
            : Promise.reject(new Error("no preview"))
        )
      );
      const next: Record<string, number | null> = {};
      registers.forEach((r, i) => {
        const result = peeks[i];
        next[r.id] = result.status === "fulfilled" && Number.isFinite(result.value) ? result.value : null;
      });
      return { key, registers, types, next, hasSampleType: sampleType !== null };
    })()
      .then((result) => {
        if (!cancelled) setData(result);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError({ key, message: getErrorMessage(err) });
      });
    return () => {
      cancelled = true;
    };
  }, [key, year, isAdmin, isClerk, myRoles]);

  const reload = useCallback(() => setVersion((v) => v + 1), []);
  const loading = data?.key !== key && error?.key !== key;
  const currentError = error?.key === key ? error.message : null;
  // keep the previous year's rows on screen while the next one loads
  const shown = data && (data.key === key || loading) ? data : null;

  const visible = useMemo(
    () => (shown?.registers ?? []).filter((r) => seeAll || myRoles.has(r.id)),
    [shown, seeAll, myRoles]
  );
  const yearHasRegisters = shown?.key === key && shown.registers.length > 0;
  const bannerYear = shown?.key === key && !yearHasRegisters ? year : year + 1;
  const showBanner =
    isAdmin && shown?.key === key && (!yearHasRegisters || (isDecember && year === currentYear));

  const years = useMemo(() => {
    const list: number[] = [];
    for (let y = currentYear + 1; y >= currentYear - 10; y--) list.push(y);
    if (!list.includes(year)) list.push(year);
    return list.sort((a, b) => b - a);
  }, [currentYear, year]);

  const openYear = async () => {
    if (opening) return;
    setOpening(true);
    try {
      const count = await openNextYearRegisters(bannerYear);
      if (count === 0) {
        toast.info(`Nothing to copy: ${bannerYear - 1} has no open registers. Use New register instead.`);
      } else {
        toast.success(`${count} register${count === 1 ? "" : "s"} opened for ${bannerYear}`);
        setYear(bannerYear);
      }
      reload();
    } catch (err) {
      toast.error(getErrorMessage(err));
    } finally {
      setOpening(false);
    }
  };

  const toggleClosed = async (register: DocRegister) => {
    try {
      if (register.closed_at) {
        await reopenDocRegister(register.id);
        toast.success(`${register.name} reopened`);
      } else {
        await closeDocRegister(register.id);
        toast.success(`${register.name} closed`);
      }
      reload();
    } catch (err) {
      toast.error(getErrorMessage(err));
    }
  };

  return (
    <div className="max-w-6xl space-y-6">
      <div className="flex flex-wrap items-center gap-3">
        <BookOpen className="size-7 shrink-0 text-primary" aria-hidden />
        <div className="min-w-0 flex-1">
          <h2 className="text-2xl font-bold">Registers (Sổ văn bản)</h2>
          <p className="text-sm text-muted-foreground">
            Each register numbers its documents from its start number, every year anew.
          </p>
        </div>
        <YearSwitcher year={year} years={years} onChange={setYear} />
      </div>

      {showBanner && (
        <div
          className="flex flex-wrap items-center gap-3 rounded-xl border border-primary/30 bg-primary/5 px-4 py-3"
          role="region"
          aria-label={`Open registers for ${bannerYear}`}
        >
          <CalendarPlus className="size-5 shrink-0 text-primary" aria-hidden />
          <p className="min-w-0 flex-1 text-sm">
            {yearHasRegisters
              ? `The year ends soon. Copy the open registers of ${year} (settings and people) into ${bannerYear}.`
              : `There are no registers for ${year}. Copy the open registers of ${year - 1} (settings and people).`}
          </p>
          <Button onClick={() => void openYear()} disabled={opening}>
            {opening && <Loader2 className="animate-spin" aria-hidden />}
            Open registers for {bannerYear}
          </Button>
        </div>
      )}

      {currentError && (
        <div className="flex flex-wrap items-center gap-3">
          <p className="text-sm text-destructive" role="alert">
            {currentError}
          </p>
          <Button variant="outline" size="sm" onClick={reload}>
            Try again
          </Button>
        </div>
      )}

      {!shown && !currentError ? (
        <Loading label="Loading registers…" />
      ) : (
        shown && (
          <div className={cn("space-y-8", loading && "opacity-60")} aria-busy={loading}>
            {DIRECTIONS.map((direction) => (
              <RegisterGroup
                key={direction}
                direction={direction}
                registers={visible.filter((r) => r.direction === direction)}
                next={shown.next}
                typeNote={shown.hasSampleType ? `for ${SAMPLE_TYPE}` : "for documents without a type"}
                orgCode={org.org.code}
                isAdmin={isAdmin}
                myRoles={myRoles}
                onNew={() => setEditing({ direction })}
                onEdit={(r) => setEditing(r)}
                onPeople={(r) => setPeople(r)}
                onToggleClosed={(r) => (r.closed_at ? void toggleClosed(r) : setConfirm({ kind: "close", register: r }))}
                onDelete={(r) => setConfirm({ kind: "delete", register: r })}
              />
            ))}
          </div>
        )
      )}

      {editing && shown && (
        <RegisterDialog
          register={"id" in editing ? editing : null}
          defaultDirection={editing.direction}
          defaultYear={year}
          nextNumber={"id" in editing ? (shown.next[editing.id] ?? null) : null}
          orgCode={org.org.code}
          types={shown.types}
          onOpenChange={(open) => !open && setEditing(null)}
          onSaved={(saved) => {
            if (saved.year !== year) setYear(saved.year);
            reload();
          }}
        />
      )}
      {people && (
        <PeopleDialog
          register={people}
          onOpenChange={(open) => !open && setPeople(null)}
          onChanged={onRolesChanged}
        />
      )}
      {confirm && (
        <ConfirmDialog
          title={confirm.kind === "close" ? "Close register" : "Delete register"}
          description={
            confirm.kind === "close"
              ? `Close "${confirm.register.name}"? It hands out no more numbers until it is reopened. Its documents stay.`
              : `Delete "${confirm.register.name}"? Only a register no document uses can be deleted; close it otherwise.`
          }
          action={confirm.kind === "close" ? "Close register" : "Delete"}
          destructive={confirm.kind === "delete"}
          onOpenChange={(open) => !open && setConfirm(null)}
          onConfirm={async () => {
            if (confirm.kind === "close") {
              await closeDocRegister(confirm.register.id);
              toast.success(`${confirm.register.name} closed`);
            } else {
              await deleteDocRegister(confirm.register.id);
              toast.success(`${confirm.register.name} deleted`);
            }
            reload();
          }}
        />
      )}
    </div>
  );
}

function YearSwitcher({
  year,
  years,
  onChange,
}: {
  year: number;
  years: number[];
  onChange: (year: number) => void;
}) {
  return (
    <div className="flex items-center gap-1" role="group" aria-label="Register year">
      <Button
        variant="outline"
        size="icon"
        aria-label={`Previous year (${year - 1})`}
        onClick={() => onChange(year - 1)}
        disabled={year <= 2000}
      >
        <ChevronLeft aria-hidden />
      </Button>
      <select
        aria-label="Year"
        className={cn(nativeSelectClass, "w-24")}
        value={year}
        onChange={(e) => onChange(Number(e.target.value))}
      >
        {years.map((y) => (
          <option key={y} value={y}>
            {y}
          </option>
        ))}
      </select>
      <Button
        variant="outline"
        size="icon"
        aria-label={`Next year (${year + 1})`}
        onClick={() => onChange(year + 1)}
        disabled={year >= 2100}
      >
        <ChevronRight aria-hidden />
      </Button>
    </div>
  );
}

function RegisterGroup({
  direction,
  registers,
  next,
  typeNote,
  orgCode,
  isAdmin,
  myRoles,
  onNew,
  onEdit,
  onPeople,
  onToggleClosed,
  onDelete,
}: {
  direction: Direction;
  registers: DocRegister[];
  next: Record<string, number | null>;
  /** which sequence a per-type register's next number belongs to */
  typeNote: string;
  orgCode: string;
  isAdmin: boolean;
  myRoles: Map<string, RegisterRole>;
  onNew: () => void;
  onEdit: (r: DocRegister) => void;
  onPeople: (r: DocRegister) => void;
  onToggleClosed: (r: DocRegister) => void;
  onDelete: (r: DocRegister) => void;
}) {
  const headingId = useId();
  return (
    <section aria-labelledby={headingId} className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 id={headingId} className="text-lg font-semibold">
          {DIRECTION_LABELS[direction]}
        </h3>
        {isAdmin && (
          <Button variant="outline" size="sm" onClick={onNew}>
            <Plus aria-hidden />
            New register
          </Button>
        )}
      </div>
      {registers.length === 0 ? (
        <p className="rounded-lg border border-dashed p-4 text-center text-sm text-muted-foreground">
          No registers for this year.
        </p>
      ) : (
        <div className="rounded-xl border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>Numbering</TableHead>
                <TableHead>Template</TableHead>
                <TableHead className="text-right">Next number</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {registers.map((r) => {
                const n = next[r.id] ?? null;
                const example = renderNotation(r.notation_template, {
                  n: n ?? r.start_number,
                  type: SAMPLE_TYPE,
                  org: orgCode,
                  dept: SAMPLE_DEPT,
                  year: r.year,
                });
                const role = myRoles.get(r.id);
                return (
                  <TableRow key={r.id}>
                    <TableCell className="whitespace-normal">
                      <div className="flex min-w-40 flex-wrap items-center gap-1.5">
                        <span className="font-medium [overflow-wrap:anywhere]">{r.name}</span>
                        {r.is_confidential && <Badge variant="outline">Confidential</Badge>}
                        {role && (
                          <Badge variant="secondary">{role === "manager" ? "You manage" : "You follow"}</Badge>
                        )}
                      </div>
                    </TableCell>
                    <TableCell>{SCOPE_LABELS[r.scope]}</TableCell>
                    <TableCell>
                      {direction === "incoming" ? (
                        <span className="text-muted-foreground">Arrival number (Số đến) only</span>
                      ) : (
                        <span className="block">
                          <span className="font-mono">{example}</span>
                          <span className="block text-xs text-muted-foreground">{r.notation_template}</span>
                        </span>
                      )}
                    </TableCell>
                    <TableCell className="text-right font-mono tabular-nums">
                      {n === null ? (
                        <span className="text-muted-foreground" title="Only clerks, admins and managers see it">
                          —
                        </span>
                      ) : (
                        <>
                          {padNumber(n)}
                          {r.scope === "register_type" && (
                            <span className="block font-sans text-xs text-muted-foreground">{typeNote}</span>
                          )}
                        </>
                      )}
                    </TableCell>
                    <TableCell>
                      {r.closed_at ? (
                        <Badge variant="secondary">Closed</Badge>
                      ) : (
                        <Badge variant="outline" className="border-success/40 text-success">
                          Open
                        </Badge>
                      )}
                    </TableCell>
                    <TableCell className="text-right">
                      <div className="flex items-center justify-end gap-1">
                        <Link
                          href={`/documents/registers/${r.id}/print`}
                          className={buttonVariants({ variant: "ghost", size: "sm" })}
                        >
                          <Printer aria-hidden />
                          Print / export
                        </Link>
                        {isAdmin && (
                          <DropdownMenu>
                            <DropdownMenuTrigger
                              render={
                                <button
                                  className="inline-flex size-8 items-center justify-center rounded-md hover:bg-muted hover:text-foreground"
                                  aria-label={`More actions for ${r.name}`}
                                />
                              }
                            >
                              <MoreHorizontal className="size-4" />
                            </DropdownMenuTrigger>
                            <DropdownMenuContent align="end">
                              <DropdownMenuItem onClick={() => onEdit(r)}>
                                <Pencil aria-hidden />
                                Edit
                              </DropdownMenuItem>
                              <DropdownMenuItem onClick={() => onPeople(r)}>
                                <Users aria-hidden />
                                People…
                              </DropdownMenuItem>
                              <DropdownMenuItem onClick={() => onToggleClosed(r)}>
                                {r.closed_at ? <LockOpen aria-hidden /> : <Lock aria-hidden />}
                                {r.closed_at ? "Reopen" : "Close"}
                              </DropdownMenuItem>
                              <DropdownMenuSeparator />
                              <DropdownMenuItem variant="destructive" onClick={() => onDelete(r)}>
                                <Trash2 aria-hidden />
                                Delete
                              </DropdownMenuItem>
                            </DropdownMenuContent>
                          </DropdownMenu>
                        )}
                      </div>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>
      )}
    </section>
  );
}

// ---------------------------------------------------------------- register dialog

function RegisterDialog({
  register,
  defaultDirection,
  defaultYear,
  nextNumber,
  orgCode,
  types,
  onOpenChange,
  onSaved,
}: {
  register: DocRegister | null;
  defaultDirection: Direction;
  defaultYear: number;
  nextNumber: number | null;
  orgCode: string;
  types: DocType[];
  onOpenChange: (open: boolean) => void;
  onSaved: (register: DocRegister) => void;
}) {
  const [name, setName] = useState(register?.name ?? "");
  const [direction, setDirection] = useState<Direction>(register?.direction ?? defaultDirection);
  const [year, setYear] = useState(String(register?.year ?? defaultYear));
  const [start, setStart] = useState(String(register?.start_number ?? 1));
  const [scope, setScope] = useState<RegisterScope>(register?.scope ?? "register");
  const [template, setTemplate] = useState(register?.notation_template ?? DEFAULT_NOTATION_TEMPLATE);
  const [cvTemplate, setCvTemplate] = useState(register?.cong_van_template ?? DEFAULT_CONG_VAN_TEMPLATE);
  const [confidential, setConfidential] = useState(register?.is_confidential ?? false);
  const [allowed, setAllowed] = useState<string[]>(register?.allowed_type_ids ?? []);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const numbered = direction !== "incoming";
  const yearNo = Number(year);
  const startNo = Number(start);
  const sampleN =
    register && nextNumber !== null ? nextNumber : Number.isInteger(startNo) && startNo > 0 ? startNo : 1;
  const sampleYear = Number.isInteger(yearNo) ? yearNo : defaultYear;
  const templateError = numbered ? templateProblem(template, "Notation template") : null;
  const cvError = numbered ? templateProblem(cvTemplate, "Công văn template") : null;
  const visibleTypes = types.filter((t) => t.active || allowed.includes(t.id));

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    if (saving) return;
    let problem: string | null = null;
    if (!name.trim() || name.trim().length > 200) problem = "Register name must be 1 to 200 characters";
    else if (!Number.isInteger(yearNo) || yearNo < 2000 || yearNo > 2100) problem = "Year must be between 2000 and 2100";
    else if (!Number.isInteger(startNo) || startNo < 1 || startNo > 1_000_000)
      problem = "Start number must be between 1 and 1000000";
    else problem = templateError ?? cvError;
    if (problem) {
      setError(problem);
      return;
    }
    setError(null);
    setSaving(true);
    try {
      const saved = await upsertDocRegister({
        id: register?.id ?? null,
        direction,
        name: name.trim(),
        year: yearNo,
        startNumber: startNo,
        scope,
        // incoming registers count arrival numbers only: keep what is stored
        notationTemplate: numbered ? template.trim() : null,
        congVanTemplate: numbered ? cvTemplate.trim() : null,
        isConfidential: confidential,
        allowedTypeIds: allowed,
      });
      toast.success(register ? "Register updated" : "Register created");
      onSaved(saved);
      onOpenChange(false);
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{register ? "Edit register" : "New register"}</DialogTitle>
          <DialogDescription>
            Direction, year, numbering and start number cannot change once the register has handed out a number.
          </DialogDescription>
        </DialogHeader>
        <form id="register-form" onSubmit={save} className="space-y-4" noValidate>
          <div className="space-y-2">
            <Label htmlFor="reg-name">Name</Label>
            <Input
              id="reg-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Sổ văn bản đi"
              maxLength={200}
              autoFocus
            />
          </div>
          <div className="grid gap-4 sm:grid-cols-3">
            <div className="space-y-2">
              <Label htmlFor="reg-direction">Direction</Label>
              <select
                id="reg-direction"
                className={nativeSelectClass}
                value={direction}
                onChange={(e) => setDirection(e.target.value as Direction)}
              >
                {DIRECTIONS.map((d) => (
                  <option key={d} value={d}>
                    {DIRECTION_LABELS[d]}
                  </option>
                ))}
              </select>
            </div>
            <div className="space-y-2">
              <Label htmlFor="reg-year">Year</Label>
              <Input
                id="reg-year"
                type="number"
                inputMode="numeric"
                min={2000}
                max={2100}
                step={1}
                value={year}
                onChange={(e) => setYear(e.target.value)}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="reg-start">Start number</Label>
              <Input
                id="reg-start"
                type="number"
                inputMode="numeric"
                min={1}
                step={1}
                value={start}
                onChange={(e) => setStart(e.target.value)}
              />
            </div>
          </div>
          <div className="space-y-2">
            <Label htmlFor="reg-scope">Numbering</Label>
            <select
              id="reg-scope"
              className={nativeSelectClass}
              value={scope}
              onChange={(e) => setScope(e.target.value as RegisterScope)}
              aria-describedby="reg-scope-hint"
            >
              {(Object.keys(SCOPE_LABELS) as RegisterScope[]).map((s) => (
                <option key={s} value={s}>
                  {SCOPE_LABELS[s]}
                </option>
              ))}
            </select>
            <p id="reg-scope-hint" className="text-xs text-muted-foreground">
              {SCOPE_HINTS[scope]}
            </p>
          </div>

          {numbered ? (
            <>
              <TemplateField
                id="reg-template"
                label="Notation template (Ký hiệu)"
                value={template}
                onChange={setTemplate}
                problem={templateError}
                example={renderNotation(template, {
                  n: sampleN,
                  type: SAMPLE_TYPE,
                  org: orgCode,
                  dept: SAMPLE_DEPT,
                  year: sampleYear,
                })}
              />
              <TemplateField
                id="reg-cv-template"
                label="Công văn template"
                value={cvTemplate}
                onChange={setCvTemplate}
                problem={cvError}
                example={renderNotation(cvTemplate, {
                  n: sampleN,
                  type: "",
                  org: orgCode,
                  dept: SAMPLE_DEPT,
                  year: sampleYear,
                })}
              />
            </>
          ) : (
            <p className="rounded-lg bg-muted px-3 py-2 text-xs text-muted-foreground">
              Incoming documents keep the sender&apos;s number and notation; this register only counts arrival
              numbers (số đến).
            </p>
          )}

          <label className="flex items-start gap-2 text-sm">
            <input
              type="checkbox"
              className="mt-0.5 size-4 accent-primary"
              checked={confidential}
              onChange={(e) => setConfidential(e.target.checked)}
            />
            <span>
              Confidential series
              <span className="block text-xs text-muted-foreground">
                For documents of the company&apos;s confidential level. Keep state secrets (MẬT) out of the system.
              </span>
            </span>
          </label>

          <fieldset className="space-y-2">
            <legend className="text-sm font-medium">Allowed document types</legend>
            <p className="text-xs text-muted-foreground">None ticked: every type is allowed.</p>
            {visibleTypes.length === 0 ? (
              <p className="text-xs text-muted-foreground">No document types yet.</p>
            ) : (
              <div className="grid max-h-44 gap-1.5 overflow-y-auto rounded-lg border p-2 sm:grid-cols-2">
                {visibleTypes.map((t) => (
                  <label key={t.id} className="flex items-center gap-2 text-sm">
                    <input
                      type="checkbox"
                      className="size-4 accent-primary"
                      checked={allowed.includes(t.id)}
                      onChange={(e) =>
                        setAllowed((prev) =>
                          e.target.checked ? [...prev, t.id] : prev.filter((id) => id !== t.id)
                        )
                      }
                    />
                    <span className="min-w-0 truncate">
                      {t.name}
                      {t.abbreviation && <span className="text-muted-foreground"> ({t.abbreviation})</span>}
                      {!t.active && <span className="text-muted-foreground"> · inactive</span>}
                    </span>
                  </label>
                ))}
              </div>
            )}
          </fieldset>

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
          <button type="submit" form="register-form" disabled={saving} className={buttonVariants()}>
            {saving ? "Saving…" : "Save"}
          </button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function TemplateField({
  id,
  label,
  value,
  onChange,
  problem,
  example,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  problem: string | null;
  example: string;
}) {
  return (
    <div className="space-y-2">
      <div className="flex items-center gap-1">
        <Label htmlFor={id}>{label}</Label>
        <TokenHelp />
      </div>
      <Input
        id={id}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        maxLength={100}
        className="font-mono"
        aria-invalid={problem ? true : undefined}
        aria-describedby={`${id}-preview`}
        spellCheck={false}
        autoComplete="off"
      />
      <p id={`${id}-preview`} className="text-xs" aria-live="polite">
        {problem ? (
          <span className="text-destructive">{problem}</span>
        ) : (
          <span className="text-muted-foreground">
            Example: <span className="font-mono text-foreground">{example}</span>
          </span>
        )}
      </p>
    </div>
  );
}

function TokenHelp() {
  return (
    <Popover.Root>
      <Popover.Trigger
        className="inline-flex size-6 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none"
        aria-label="Template tokens"
      >
        <HelpCircle className="size-4" aria-hidden />
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Positioner side="bottom" align="start" sideOffset={6} className="isolate z-50 outline-none">
          <Popover.Popup className="w-72 max-w-[calc(100vw-2rem)] rounded-lg bg-popover p-3 text-sm text-popover-foreground shadow-md ring-1 ring-foreground/10 outline-none">
            <Popover.Title className="mb-2 font-medium">Template tokens</Popover.Title>
            <dl className="space-y-1.5">
              {TEMPLATE_TOKENS.map((t) => (
                <div key={t.token} className="grid grid-cols-[4rem_1fr] gap-2">
                  <dt className="font-mono text-xs">{t.token}</dt>
                  <dd className="text-xs text-muted-foreground">{t.meaning}</dd>
                </div>
              ))}
            </dl>
            <p className="mt-2 text-xs text-muted-foreground">
              Separators left by an empty token are removed: {"{n}/{type}-{org}"} with no type gives 01/ABC.
            </p>
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}

// ---------------------------------------------------------------- people dialog

function PeopleDialog({
  register,
  onOpenChange,
  onChanged,
}: {
  register: DocRegister;
  onOpenChange: (open: boolean) => void;
  onChanged: () => void;
}) {
  const [rows, setRows] = useState<RegisterRoleRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [version, setVersion] = useState(0);
  const [personId, setPersonId] = useState<string | null>(null);
  const [role, setRole] = useState<RegisterRole>("manager");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    listRegisterRoles(register.id)
      .then((result) => {
        if (cancelled) return;
        setRows(result);
        setError(null);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(getErrorMessage(err));
      });
    return () => {
      cancelled = true;
    };
  }, [register.id, version]);

  const apply = async (userId: string, next: RegisterRole | null, message: string) => {
    if (busy) return;
    setBusy(true);
    try {
      await setRegisterRole(register.id, userId, next);
      toast.success(message);
      setVersion((v) => v + 1);
      onChanged();
      return true;
    } catch (err) {
      toast.error(getErrorMessage(err));
      return false;
    } finally {
      setBusy(false);
    }
  };

  const add = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!personId) return;
    if (await apply(personId, role, "Person added")) setPersonId(null);
  };

  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>People of {register.name}</DialogTitle>
          <DialogDescription>
            Managers can number and register documents in this register; followers can view and print it.
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={add} className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_auto_auto] sm:items-start">
          <PersonPicker
            value={personId}
            onChange={(id) => setPersonId(id)}
            excludeIds={(rows ?? []).map((r) => r.user_id)}
            placeholder="Search active members"
            aria-label="Person to add"
          />
          <select
            aria-label="Role"
            className={cn(nativeSelectClass, "sm:w-36")}
            value={role}
            onChange={(e) => setRole(e.target.value as RegisterRole)}
          >
            {(Object.keys(ROLE_LABELS) as RegisterRole[]).map((r) => (
              <option key={r} value={r}>
                {ROLE_LABELS[r]}
              </option>
            ))}
          </select>
          <Button type="submit" disabled={!personId || busy}>
            <Plus aria-hidden />
            Add
          </Button>
        </form>

        {error && (
          <p className="text-sm text-destructive" role="alert">
            {error}
          </p>
        )}
        {!rows && !error ? (
          <Loading label="Loading people…" />
        ) : rows && rows.length === 0 ? (
          <p className="rounded-lg border border-dashed p-4 text-center text-sm text-muted-foreground">
            No managers or followers yet. Clerks and admins can always use the register.
          </p>
        ) : (
          <ul className="divide-y rounded-lg border">
            {(rows ?? []).map((r) => {
              const label = memberLabel(r) || "Unknown member";
              return (
                <li key={r.user_id} className="flex flex-wrap items-center gap-2 px-3 py-2">
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium">{label}</p>
                    {r.display_name && r.email && (
                      <p className="truncate text-xs text-muted-foreground">{r.email}</p>
                    )}
                  </div>
                  <select
                    aria-label={`Role of ${label}`}
                    className={cn(nativeSelectClass, "w-auto")}
                    value={r.role}
                    disabled={busy}
                    onChange={(e) => void apply(r.user_id, e.target.value as RegisterRole, "Role changed")}
                  >
                    {(Object.keys(ROLE_LABELS) as RegisterRole[]).map((value) => (
                      <option key={value} value={value}>
                        {ROLE_LABELS[value]}
                      </option>
                    ))}
                  </select>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label={`Remove ${label}`}
                    disabled={busy}
                    onClick={() => void apply(r.user_id, null, `${label} removed`)}
                  >
                    <Trash2 aria-hidden />
                  </Button>
                </li>
              );
            })}
          </ul>
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

// ---------------------------------------------------------------- shared bits

function ConfirmDialog({
  title,
  description,
  action,
  destructive,
  onOpenChange,
  onConfirm,
}: {
  title: string;
  description: string;
  action: string;
  destructive?: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: () => Promise<void>;
}) {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const run = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await onConfirm();
      onOpenChange(false);
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
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
          <Button variant={destructive ? "destructive" : "default"} onClick={() => void run()} disabled={busy}>
            {busy ? "Working…" : action}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
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

function NoAccess({ children }: { children: React.ReactNode }) {
  return (
    <div className="max-w-xl rounded-xl border border-dashed p-6 text-sm text-muted-foreground" role="status">
      {children}
    </div>
  );
}
