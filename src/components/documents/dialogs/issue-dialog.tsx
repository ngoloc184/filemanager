"use client";

import { useEffect, useId, useMemo, useRef, useState } from "react";
import { Building2, Globe, Loader2, Plus, Stamp, User, X } from "lucide-react";
import { toast } from "sonner";

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
import { DepartmentSelect, nativeSelectClass } from "@/components/org/department-select";
import { PersonPicker } from "@/components/org/person-picker";
import { todayIn } from "@/lib/documents/deadlines";
import { RECIPIENT_METHOD_LABELS } from "@/lib/documents/labels";
import { renderNotation } from "@/lib/documents/numbering";
import type { IssueRecipientInput } from "@/lib/documents/outgoing";
import {
  RECIPIENT_METHODS,
  type DocRegister,
  type DocumentBundle,
  type ExternalOrg,
  type RecipientMethod,
} from "@/lib/documents/types";
import { memberLabel } from "@/lib/org";
import { peekNextNumber } from "@/lib/services/document-admin";
import { listExternalOrgs, listRegisters } from "@/lib/services/documents";
import { issueDocument } from "@/lib/services/documents-outgoing";
import { getMyOrg, listDepartments, type Department, type Organization } from "@/lib/services/org";
import { getErrorMessage } from "@/lib/types/database";
import { cn } from "@/lib/utils";

// Issue (Ban hành), clerk only: pick this year's register, preview the number
// and notation, choose recipients. issue_document numbers, freezes and
// distributes the signed document; internal recipients get an 'info'
// assignment on the same document, outside ones are recorded only.

type Props = {
  bundle: DocumentBundle;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onDone: () => void;
};

type RecipientItem = {
  key: string;
  input: IssueRecipientInput;
  label: string;
  detail: string | null;
};

type Tab = "people" | "departments" | "external";

const TAB_LABELS: Record<Tab, string> = {
  people: "People",
  departments: "Departments",
  external: "External",
};

const MAX_RECIPIENTS = 200;
const MAX_NUMBER = 1_000_000;
const MAX_EXTERNAL_NAME = 500;

/** Bumps when the dialog opens, so each opening starts from fresh state. */
function useOpenSession(open: boolean): number {
  const [session, setSession] = useState(0);
  const [wasOpen, setWasOpen] = useState(open);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) setSession((s) => s + 1);
  }
  return session;
}

export function IssueDialog(props: Props) {
  const session = useOpenSession(props.open);
  return <IssueDialogBody key={session} {...props} />;
}

/** '' → null (automatic); a whole number 1..1,000,000 → it; anything else → NaN. */
function parseManualNumber(raw: string): number | null {
  const s = raw.trim();
  if (!s) return null;
  if (!/^\d+$/.test(s)) return Number.NaN;
  const n = Number(s);
  return n >= 1 && n <= MAX_NUMBER ? n : Number.NaN;
}

function IssueDialogBody({ bundle, open, onOpenChange, onDone }: Props) {
  const ids = useId();
  const doc = bundle.document;
  const isOutgoing = doc.direction === "outgoing";
  const tabs: Tab[] = isOutgoing ? ["people", "departments", "external"] : ["people", "departments"];

  const [org, setOrg] = useState<Organization | null>(null);
  const [registers, setRegisters] = useState<DocRegister[] | null>(null);
  const [departments, setDepartments] = useState<Department[]>([]);
  const [externalOrgs, setExternalOrgs] = useState<ExternalOrg[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [registerId, setRegisterId] = useState("");
  const [peek, setPeek] = useState<{ registerId: string; next: number | null; error: string | null } | null>(null);
  const [manual, setManual] = useState("");
  const [recipients, setRecipients] = useState<RecipientItem[]>([]);
  const [tab, setTab] = useState<Tab>("people");
  const [externalId, setExternalId] = useState("");
  const [externalName, setExternalName] = useState("");
  const [method, setMethod] = useState<RecipientMethod>("post");
  const [attempted, setAttempted] = useState(false);
  const [busy, setBusy] = useState(false);
  const tabRefs = useRef<Partial<Record<Tab, HTMLButtonElement | null>>>({});

  // company code and timezone first: the register year is the company's year
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    (async () => {
      try {
        const mine = await getMyOrg();
        if (!mine) throw new Error("You are not a member of a company");
        const year = Number(todayIn(mine.org.timezone).slice(0, 4));
        const [regs, depts, outside] = await Promise.all([
          listRegisters(doc.direction, year),
          listDepartments(),
          isOutgoing ? listExternalOrgs() : Promise.resolve([] as ExternalOrg[]),
        ]);
        if (cancelled) return;
        setOrg(mine.org);
        setRegisters(regs);
        setDepartments(depts);
        setExternalOrgs(outside);
      } catch (err) {
        if (cancelled) return;
        setLoadError(getErrorMessage(err));
        setRegisters([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, doc.direction, isOutgoing]);

  // open registers that take this document type
  const eligible = useMemo(
    () =>
      (registers ?? []).filter(
        (r) =>
          !r.closed_at &&
          (r.allowed_type_ids.length === 0 || (!!doc.doc_type_id && r.allowed_type_ids.includes(doc.doc_type_id)))
      ),
    [registers, doc.doc_type_id]
  );
  const register = eligible.find((r) => r.id === registerId) ?? eligible[0] ?? null;
  const activeRegisterId = register?.id ?? "";

  useEffect(() => {
    if (!activeRegisterId) return;
    let cancelled = false;
    peekNextNumber(activeRegisterId, doc.doc_type_id)
      .then((next) => {
        if (!cancelled) setPeek({ registerId: activeRegisterId, next, error: null });
      })
      .catch((err: unknown) => {
        if (!cancelled) setPeek({ registerId: activeRegisterId, next: null, error: getErrorMessage(err) });
      });
    return () => {
      cancelled = true;
    };
  }, [activeRegisterId, doc.doc_type_id]);

  const currentPeek = peek && peek.registerId === activeRegisterId ? peek : null;
  const manualNumber = parseManualNumber(manual);
  const manualInvalid = Number.isNaN(manualNumber);
  const number = manualNumber != null && !manualInvalid ? manualNumber : (currentPeek?.next ?? null);

  const preview =
    register && org && number != null
      ? renderNotation(doc.is_cong_van ? register.cong_van_template : register.notation_template, {
          n: number,
          type: doc.type_abbreviation,
          org: org.code,
          dept: doc.drafting_department_code,
          year: register.year,
        })
      : null;

  const internalCount = recipients.filter((r) => r.input.kind !== "external").length;
  const recipientProblem = isOutgoing
    ? recipients.length === 0
      ? "Add at least one recipient"
      : null
    : internalCount === 0
      ? "Send it to at least one person or department"
      : null;
  const problem = !register
    ? "Pick a register"
    : manualInvalid
      ? `The number must be a whole number from 1 to ${MAX_NUMBER.toLocaleString("en-US")}`
      : recipientProblem;

  const memberIds = recipients.flatMap((r) => (r.input.kind === "member" ? [r.input.user_id] : []));
  const departmentIds = recipients.flatMap((r) => (r.input.kind === "department" ? [r.input.department_id] : []));
  const full = recipients.length >= MAX_RECIPIENTS;

  const add = (item: RecipientItem) => {
    setRecipients((prev) =>
      prev.length >= MAX_RECIPIENTS || prev.some((r) => r.key === item.key) ? prev : [...prev, item]
    );
  };

  const addDepartment = (id: string | null) => {
    if (!id) return;
    const d = departments.find((x) => x.id === id);
    add({
      key: `d:${id}`,
      input: { kind: "department", department_id: id },
      label: d ? d.name : "Department",
      detail: d ? d.code : null,
    });
  };

  const externalOrg = externalOrgs.find((e) => e.id === externalId) ?? null;
  const typedName = externalName.trim();
  const canAddExternal = !full && (!!externalOrg || (typedName.length > 0 && typedName.length <= MAX_EXTERNAL_NAME));

  const addExternal = () => {
    if (!canAddExternal) return;
    if (externalOrg) {
      add({
        key: `e:${externalOrg.id}`,
        input: { kind: "external", external_org_id: externalOrg.id, method },
        label: externalOrg.name,
        detail: RECIPIENT_METHOD_LABELS[method],
      });
    } else {
      add({
        key: `x:${typedName.toLocaleLowerCase("vi")}`,
        input: { kind: "external", name: typedName, method },
        label: typedName,
        detail: RECIPIENT_METHOD_LABELS[method],
      });
    }
    setExternalId("");
    setExternalName("");
  };

  const onTabKeyDown = (e: React.KeyboardEvent) => {
    const index = tabs.indexOf(tab);
    let next = -1;
    if (e.key === "ArrowRight") next = (index + 1) % tabs.length;
    else if (e.key === "ArrowLeft") next = (index - 1 + tabs.length) % tabs.length;
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = tabs.length - 1;
    if (next < 0) return;
    e.preventDefault();
    setTab(tabs[next]);
    tabRefs.current[tabs[next]]?.focus();
  };

  const issue = async (e: React.FormEvent) => {
    e.preventDefault();
    if (busy) return;
    setAttempted(true);
    if (problem || !register) return;
    setBusy(true);
    try {
      const result = await issueDocument(
        doc.id,
        register.id,
        recipients.map((r) => r.input),
        manualNumber != null && !manualInvalid ? manualNumber : null
      );
      toast.success(`Issued as ${result.notation}`);
      onDone();
      onOpenChange(false);
    } catch (err) {
      toast.error(getErrorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const loading = registers === null;
  const tabId = (t: Tab) => `${ids}-tab-${t}`;
  const panelId = (t: Tab) => `${ids}-panel-${t}`;

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next && busy) return;
        onOpenChange(next);
      }}
    >
      <DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-2xl">
        <form onSubmit={(e) => void issue(e)} className="grid gap-4">
          <DialogHeader>
            <DialogTitle>Issue (Ban hành)</DialogTitle>
            <DialogDescription>
              Issuing gives the next number in the register, locks the files and sends the document to its
              recipients.
            </DialogDescription>
          </DialogHeader>

          {loadError && (
            <p className="text-sm text-destructive" role="alert">
              {loadError}
            </p>
          )}

          <section className="grid gap-3 sm:grid-cols-2" aria-label="Number">
            <div className="space-y-1.5">
              <Label htmlFor={`${ids}-register`}>Register (Sổ văn bản)</Label>
              <select
                id={`${ids}-register`}
                className={nativeSelectClass}
                value={activeRegisterId}
                onChange={(e) => setRegisterId(e.target.value)}
                disabled={busy || loading || eligible.length === 0}
              >
                {loading && <option value="">Loading…</option>}
                {!loading && eligible.length === 0 && <option value="">No open register</option>}
                {eligible.map((r) => (
                  <option key={r.id} value={r.id}>
                    {`${r.name} (${r.year})`}
                  </option>
                ))}
              </select>
              {!loading && eligible.length === 0 && !loadError && (
                <p className="text-xs text-muted-foreground">
                  There is no open {doc.direction} register for this year that takes this document type. Ask a
                  company admin to open one.
                </p>
              )}
            </div>
            <div className="space-y-1.5">
              <Label htmlFor={`${ids}-number`}>Use a specific number (optional)</Label>
              <Input
                id={`${ids}-number`}
                inputMode="numeric"
                value={manual}
                onChange={(e) => setManual(e.target.value)}
                placeholder={currentPeek?.next != null ? `Next: ${currentPeek.next}` : "Automatic"}
                disabled={busy}
                aria-invalid={manualInvalid || undefined}
                aria-describedby={`${ids}-preview`}
              />
            </div>
            <p id={`${ids}-preview`} className="text-sm sm:col-span-2" aria-live="polite">
              {currentPeek?.error ? (
                <span className="text-destructive">{currentPeek.error}</span>
              ) : preview ? (
                <>
                  Will be issued as <span className="font-semibold">{preview}</span>
                  {manualNumber != null && !manualInvalid && (
                    <span className="text-muted-foreground"> (specific number, recorded in the history)</span>
                  )}
                </>
              ) : register ? (
                <span className="text-muted-foreground">Working out the next number…</span>
              ) : null}
            </p>
          </section>

          <section className="space-y-2" aria-labelledby={`${ids}-recipients`}>
            <h3 id={`${ids}-recipients`} className="text-sm font-medium">
              Recipients (Nơi nhận){" "}
              <span className="font-normal text-muted-foreground">
                {isOutgoing ? "· at least one" : "· at least one person or department"}
              </span>
            </h3>

            <div
              role="tablist"
              aria-label="Recipient type"
              className="-mx-1 flex gap-1 overflow-x-auto border-b px-1"
              onKeyDown={onTabKeyDown}
            >
              {tabs.map((t) => {
                const selected = t === tab;
                return (
                  <button
                    key={t}
                    ref={(el) => {
                      tabRefs.current[t] = el;
                    }}
                    type="button"
                    role="tab"
                    id={tabId(t)}
                    aria-selected={selected}
                    aria-controls={panelId(t)}
                    tabIndex={selected ? 0 : -1}
                    onClick={() => setTab(t)}
                    className={cn(
                      "-mb-px shrink-0 border-b-2 px-3 py-1.5 text-sm font-medium whitespace-nowrap transition-colors outline-none focus-visible:ring-3 focus-visible:ring-ring/50",
                      selected
                        ? "border-primary text-foreground"
                        : "border-transparent text-muted-foreground hover:text-foreground"
                    )}
                  >
                    {TAB_LABELS[t]}
                  </button>
                );
              })}
            </div>

            <div
              role="tabpanel"
              id={panelId(tab)}
              aria-labelledby={tabId(tab)}
              className="space-y-2"
              // Enter in a recipient search box must never issue the document
              onKeyDown={(e) => {
                if (e.key === "Enter" && e.target instanceof HTMLInputElement) e.preventDefault();
              }}
            >
              {tab === "people" && (
                <PersonPicker
                  value={null}
                  onChange={(userId, person) => {
                    if (!userId || !person) return;
                    add({
                      key: `m:${userId}`,
                      input: { kind: "member", user_id: userId },
                      label: memberLabel(person),
                      detail: person.department_name,
                    });
                  }}
                  excludeIds={memberIds}
                  placeholder="Add a person…"
                  aria-label="Add a person"
                  disabled={busy || full}
                />
              )}
              {tab === "departments" && (
                <DepartmentSelect
                  value={null}
                  onChange={addDepartment}
                  excludeIds={departmentIds}
                  placeholder="Add a department…"
                  aria-label="Add a department"
                  disabled={busy || full}
                />
              )}
              {tab === "external" && (
                <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_10rem_auto] sm:items-end">
                  <div className="min-w-0 space-y-1.5">
                    <Label htmlFor={`${ids}-ext-org`}>Organization</Label>
                    <select
                      id={`${ids}-ext-org`}
                      className={nativeSelectClass}
                      value={externalId}
                      onChange={(e) => setExternalId(e.target.value)}
                      disabled={busy}
                    >
                      <option value="">Type a name instead…</option>
                      {externalOrgs.map((o) => (
                        <option key={o.id} value={o.id}>
                          {o.code ? `${o.name} (${o.code})` : o.name}
                        </option>
                      ))}
                    </select>
                    {!externalOrg && (
                      <Input
                        value={externalName}
                        onChange={(e) => setExternalName(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") {
                            e.preventDefault();
                            addExternal();
                          }
                        }}
                        maxLength={MAX_EXTERNAL_NAME}
                        placeholder="Name of the outside recipient"
                        aria-label="Name of the outside recipient"
                        disabled={busy}
                      />
                    )}
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor={`${ids}-method`}>Sent by</Label>
                    <select
                      id={`${ids}-method`}
                      className={nativeSelectClass}
                      value={method}
                      onChange={(e) => setMethod(e.target.value as RecipientMethod)}
                      disabled={busy}
                    >
                      {RECIPIENT_METHODS.map((m) => (
                        <option key={m} value={m}>
                          {RECIPIENT_METHOD_LABELS[m]}
                        </option>
                      ))}
                    </select>
                  </div>
                  <Button type="button" variant="outline" onClick={addExternal} disabled={busy || !canAddExternal}>
                    <Plus aria-hidden />
                    Add
                  </Button>
                </div>
              )}
            </div>

            {recipients.length === 0 ? (
              <p className="text-sm text-muted-foreground">No recipients yet.</p>
            ) : (
              <ul className="divide-y rounded-lg border" aria-label="Chosen recipients">
                {recipients.map((r) => {
                  const Icon = r.input.kind === "member" ? User : r.input.kind === "department" ? Building2 : Globe;
                  return (
                    <li key={r.key} className="flex items-center gap-2 px-3 py-2">
                      <Icon className="size-4 shrink-0 text-muted-foreground" aria-hidden />
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm font-medium">{r.label}</p>
                        {r.detail && <p className="truncate text-xs text-muted-foreground">{r.detail}</p>}
                      </div>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon-sm"
                        onClick={() => setRecipients((prev) => prev.filter((x) => x.key !== r.key))}
                        disabled={busy}
                        aria-label={`Remove ${r.label}`}
                      >
                        <X aria-hidden />
                      </Button>
                    </li>
                  );
                })}
              </ul>
            )}
            {full && <p className="text-xs text-muted-foreground">At most {MAX_RECIPIENTS} recipients.</p>}
          </section>

          {attempted && problem && (
            <p className="text-sm text-destructive" role="alert">
              {problem}
            </p>
          )}

          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>
              Cancel
            </Button>
            <Button type="submit" disabled={busy || loading || !register}>
              {busy ? <Loader2 className="animate-spin" aria-hidden /> : <Stamp aria-hidden />}
              {busy ? "Issuing…" : "Issue"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
