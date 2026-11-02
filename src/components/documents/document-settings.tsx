"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Loader2, Pencil, Plus, Search, Settings2 } from "lucide-react";
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
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { getMyOrg, type MyOrg } from "@/lib/services/org";
import { listDocFields, listDocTypes, listExternalOrgs } from "@/lib/services/documents";
import { upsertDocField, upsertDocType, upsertExternalOrg } from "@/lib/services/document-admin";
import type { DocField, DocType, ExternalOrg } from "@/lib/documents/types";
import { hasRole } from "@/lib/org";
import { getErrorMessage } from "@/lib/types/database";
import { cn } from "@/lib/utils";

// Documents settings: document types (loại văn bản) and fields (lĩnh vực)
// for company admins; outside organizations for admins and clerks (Văn thư).

type TabId = "types" | "fields" | "external";

const TABS: { id: TabId; label: string; clerk: boolean }[] = [
  { id: "types", label: "Document types (Loại văn bản)", clerk: false },
  { id: "fields", label: "Fields (Lĩnh vực)", clerk: false },
  { id: "external", label: "External organisations (Cơ quan, đơn vị ngoài)", clerk: true },
];

/** Lower-case without Vietnamese diacritics, for the search box. */
function fold(s: string): string {
  return s.normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/đ/gi, "d").toLowerCase();
}

/** Loads with `load` on mount and whenever `reload` is called. */
function useList<T>(load: () => Promise<T[]>) {
  const [rows, setRows] = useState<T[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [version, setVersion] = useState(0);

  useEffect(() => {
    let cancelled = false;
    load()
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
  }, [load, version]);

  const reload = useCallback(() => setVersion((v) => v + 1), []);
  return { rows, error, reload };
}

export default function DocumentSettings() {
  const [org, setOrg] = useState<MyOrg | null | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<TabId | null>(null);

  useEffect(() => {
    let cancelled = false;
    getMyOrg()
      .then((result) => {
        if (!cancelled) setOrg(result);
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
  if (org === undefined) return <Loading label="Loading settings…" />;

  const active = org?.me.status === "active";
  const isAdmin = active && hasRole(org?.me, "org_admin");
  const isClerk = active && hasRole(org?.me, "clerk");
  if (!org || (!isAdmin && !isClerk)) {
    return (
      <div className="max-w-xl rounded-xl border border-dashed p-6 text-sm text-muted-foreground" role="status">
        {org ? (
          "You do not have access to document settings."
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

  const tabs = TABS.filter((t) => isAdmin || t.clerk);
  const activeTab = tabs.find((t) => t.id === tab)?.id ?? tabs[0].id;

  return (
    <div className="max-w-6xl space-y-6">
      <div className="flex flex-wrap items-center gap-3">
        <Settings2 className="size-7 shrink-0 text-primary" aria-hidden />
        <div className="min-w-0">
          <h2 className="text-2xl font-bold">Document settings</h2>
          <p className="text-sm text-muted-foreground">
            {isAdmin
              ? "Lookups used by every document of your company."
              : "As a clerk (Văn thư) you can manage outside organisations."}
          </p>
        </div>
      </div>

      <Tabs tabs={tabs} active={activeTab} onChange={setTab} />

      <div role="tabpanel" id={`ds-panel-${activeTab}`} aria-labelledby={`ds-tab-${activeTab}`}>
        {activeTab === "types" && <TypesPanel />}
        {activeTab === "fields" && <FieldsPanel />}
        {activeTab === "external" && <ExternalPanel />}
      </div>
    </div>
  );
}

function Tabs({
  tabs,
  active,
  onChange,
}: {
  tabs: { id: TabId; label: string }[];
  active: TabId;
  onChange: (id: TabId) => void;
}) {
  const refs = useRef<Record<string, HTMLButtonElement | null>>({});

  const onKeyDown = (e: React.KeyboardEvent) => {
    const index = tabs.findIndex((t) => t.id === active);
    let next = -1;
    if (e.key === "ArrowRight") next = (index + 1) % tabs.length;
    else if (e.key === "ArrowLeft") next = (index - 1 + tabs.length) % tabs.length;
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = tabs.length - 1;
    if (next < 0) return;
    e.preventDefault();
    onChange(tabs[next].id);
    refs.current[tabs[next].id]?.focus();
  };

  return (
    <div
      role="tablist"
      aria-label="Document settings sections"
      className="-mx-1 flex gap-1 overflow-x-auto border-b px-1"
      onKeyDown={onKeyDown}
    >
      {tabs.map((t) => {
        const selected = t.id === active;
        return (
          <button
            key={t.id}
            ref={(el) => {
              refs.current[t.id] = el;
            }}
            type="button"
            role="tab"
            id={`ds-tab-${t.id}`}
            aria-selected={selected}
            aria-controls={`ds-panel-${t.id}`}
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

// ---------------------------------------------------------------- document types

const loadTypes = () => listDocTypes(true);

function TypesPanel() {
  const { rows, error, reload } = useList(loadTypes);
  const [editing, setEditing] = useState<DocType | "new" | null>(null);

  return (
    <div className="space-y-4">
      <PanelBar
        text="Abbreviations appear in notations as {type}, e.g. 15/QĐ-ABC. Công văn types have no abbreviation in their notation."
        action="Add type"
        onAction={() => setEditing("new")}
      />
      <ListState rows={rows} error={error} empty="No document types yet." label="Loading document types…">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Name</TableHead>
              <TableHead>Abbreviation</TableHead>
              <TableHead>Công văn</TableHead>
              <TableHead>Active</TableHead>
              <TableHead className="text-right">Sort</TableHead>
              <TableHead className="w-10">
                <span className="sr-only">Actions</span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {(rows ?? []).map((t) => (
              <TableRow key={t.id} className={cn(!t.active && "text-muted-foreground")}>
                <TableCell className="font-medium whitespace-normal">{t.name}</TableCell>
                <TableCell className="font-mono">{t.abbreviation || "—"}</TableCell>
                <TableCell>{t.is_cong_van ? "Yes" : "No"}</TableCell>
                <TableCell>
                  <ActiveBadge active={t.active} />
                </TableCell>
                <TableCell className="text-right tabular-nums">{t.sort_order}</TableCell>
                <TableCell>
                  <EditButton label={`Edit ${t.name}`} onClick={() => setEditing(t)} />
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </ListState>
      {editing && (
        <TypeDialog
          type={editing === "new" ? null : editing}
          onOpenChange={(open) => !open && setEditing(null)}
          onSaved={reload}
        />
      )}
    </div>
  );
}

function TypeDialog({
  type,
  onOpenChange,
  onSaved,
}: {
  type: DocType | null;
  onOpenChange: (open: boolean) => void;
  onSaved: () => void;
}) {
  const [name, setName] = useState(type?.name ?? "");
  const [abbreviation, setAbbreviation] = useState(type?.abbreviation ?? "");
  const [isCongVan, setIsCongVan] = useState(type?.is_cong_van ?? false);
  const [active, setActive] = useState(type?.active ?? true);
  const [sortOrder, setSortOrder] = useState(String(type?.sort_order ?? 0));
  const [retention, setRetention] = useState(type?.default_retention_code ?? "");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const save = async () => {
    const order = Number(sortOrder);
    const abbr = abbreviation.trim();
    let problem: string | null = null;
    if (!name.trim() || name.trim().length > 100) problem = "Type name must be 1 to 100 characters";
    else if (abbr.length > 10) problem = "Abbreviation must be at most 10 characters";
    else if (/[\s/{}]/.test(abbr)) problem = "Abbreviation cannot contain spaces, slashes or braces";
    else if (!Number.isInteger(order) || Math.abs(order) > 100_000) problem = "Sort order must be a whole number from -100000 to 100000";
    else if (retention.trim().length > 50) problem = "Retention code must be at most 50 characters";
    if (problem) throw new Error(problem);
    await upsertDocType({
      id: type?.id ?? null,
      name: name.trim(),
      abbreviation: abbr,
      isCongVan,
      active,
      sortOrder: order,
      defaultRetentionCode: retention.trim(),
    });
    toast.success(type ? "Document type updated" : "Document type added");
    onSaved();
  };

  return (
    <EditDialog
      title={type ? "Edit document type" : "Add document type"}
      description="A type (loại văn bản) such as Quyết định (QĐ) or Thông báo (TB)."
      formId="doc-type-form"
      error={error}
      saving={saving}
      onOpenChange={onOpenChange}
      onSubmit={() => run(save, setSaving, setError, () => onOpenChange(false))}
    >
      <TextField id="dt-name" label="Name" value={name} onChange={setName} maxLength={100} autoFocus placeholder="e.g. Quyết định" />
      <div className="grid gap-4 sm:grid-cols-2">
        <TextField
          id="dt-abbr"
          label="Abbreviation"
          value={abbreviation}
          onChange={setAbbreviation}
          maxLength={10}
          placeholder="QĐ"
          className="font-mono"
        />
        <TextField
          id="dt-sort"
          label="Sort order"
          value={sortOrder}
          onChange={setSortOrder}
          type="number"
        />
      </div>
      <TextField
        id="dt-retention"
        label="Default retention code (optional)"
        value={retention}
        onChange={setRetention}
        maxLength={50}
        hint="Suggested retention (thời hạn bảo quản) for dossiers; leave blank for none."
      />
      <Check
        label="Công văn"
        hint="Numbered with the register's công văn template (no type abbreviation)."
        checked={isCongVan}
        onChange={setIsCongVan}
      />
      <Check label="Active" hint="Inactive types stay on old documents but cannot be picked." checked={active} onChange={setActive} />
    </EditDialog>
  );
}

// ---------------------------------------------------------------- fields

const loadFields = () => listDocFields(true);

function FieldsPanel() {
  const { rows, error, reload } = useList(loadFields);
  const [editing, setEditing] = useState<DocField | "new" | null>(null);

  return (
    <div className="space-y-4">
      <PanelBar
        text="Fields (lĩnh vực) group documents by subject area, e.g. Tài chính, Nhân sự."
        action="Add field"
        onAction={() => setEditing("new")}
      />
      <ListState rows={rows} error={error} empty="No fields yet." label="Loading fields…">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Name</TableHead>
              <TableHead>Active</TableHead>
              <TableHead className="w-10">
                <span className="sr-only">Actions</span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {(rows ?? []).map((f) => (
              <TableRow key={f.id} className={cn(!f.active && "text-muted-foreground")}>
                <TableCell className="font-medium whitespace-normal">{f.name}</TableCell>
                <TableCell>
                  <ActiveBadge active={f.active} />
                </TableCell>
                <TableCell>
                  <EditButton label={`Edit ${f.name}`} onClick={() => setEditing(f)} />
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </ListState>
      {editing && (
        <FieldDialog
          field={editing === "new" ? null : editing}
          onOpenChange={(open) => !open && setEditing(null)}
          onSaved={reload}
        />
      )}
    </div>
  );
}

function FieldDialog({
  field,
  onOpenChange,
  onSaved,
}: {
  field: DocField | null;
  onOpenChange: (open: boolean) => void;
  onSaved: () => void;
}) {
  const [name, setName] = useState(field?.name ?? "");
  const [active, setActive] = useState(field?.active ?? true);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const save = async () => {
    if (!name.trim() || name.trim().length > 200) throw new Error("Field name must be 1 to 200 characters");
    await upsertDocField({ id: field?.id ?? null, name: name.trim(), active });
    toast.success(field ? "Field updated" : "Field added");
    onSaved();
  };

  return (
    <EditDialog
      title={field ? "Edit field" : "Add field"}
      description="A subject area (lĩnh vực) documents can be filed under."
      formId="doc-field-form"
      error={error}
      saving={saving}
      onOpenChange={onOpenChange}
      onSubmit={() => run(save, setSaving, setError, () => onOpenChange(false))}
    >
      <TextField id="df-name" label="Name" value={name} onChange={setName} maxLength={200} autoFocus />
      <Check label="Active" checked={active} onChange={setActive} />
    </EditDialog>
  );
}

// ---------------------------------------------------------------- external organisations

const loadExternal = () => listExternalOrgs(true);

function ExternalPanel() {
  const { rows, error, reload } = useList(loadExternal);
  const [editing, setEditing] = useState<ExternalOrg | "new" | null>(null);
  const [query, setQuery] = useState("");

  const filtered = useMemo(() => {
    const q = fold(query.trim());
    if (!q) return rows;
    return (rows ?? []).filter((o) =>
      fold([o.name, o.code, o.email, o.address].filter(Boolean).join(" ")).includes(q)
    );
  }, [rows, query]);

  return (
    <div className="space-y-4">
      <PanelBar
        text="Senders of incoming documents and recipients of outgoing ones."
        action="Add organisation"
        onAction={() => setEditing("new")}
      />
      <div className="relative max-w-sm">
        <Search
          className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground"
          aria-hidden
        />
        <Input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search name, code, email or address"
          aria-label="Search external organisations"
          className="pl-8"
        />
      </div>
      <ListState
        rows={filtered}
        error={error}
        empty={query.trim() ? "No organisations match your search." : "No external organisations yet."}
        label="Loading organisations…"
      >
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Name</TableHead>
              <TableHead>Code</TableHead>
              <TableHead>Email</TableHead>
              <TableHead>Address</TableHead>
              <TableHead>Active</TableHead>
              <TableHead className="w-10">
                <span className="sr-only">Actions</span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {(filtered ?? []).map((o) => (
              <TableRow key={o.id} className={cn(!o.active && "text-muted-foreground")}>
                <TableCell className="min-w-48 font-medium whitespace-normal">{o.name}</TableCell>
                <TableCell className="font-mono">{o.code || "—"}</TableCell>
                <TableCell>{o.email || "—"}</TableCell>
                <TableCell className="min-w-48 whitespace-normal">{o.address || "—"}</TableCell>
                <TableCell>
                  <ActiveBadge active={o.active} />
                </TableCell>
                <TableCell>
                  <EditButton label={`Edit ${o.name}`} onClick={() => setEditing(o)} />
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </ListState>
      {editing && (
        <ExternalDialog
          org={editing === "new" ? null : editing}
          onOpenChange={(open) => !open && setEditing(null)}
          onSaved={reload}
        />
      )}
    </div>
  );
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function ExternalDialog({
  org,
  onOpenChange,
  onSaved,
}: {
  org: ExternalOrg | null;
  onOpenChange: (open: boolean) => void;
  onSaved: () => void;
}) {
  const [name, setName] = useState(org?.name ?? "");
  const [code, setCode] = useState(org?.code ?? "");
  const [email, setEmail] = useState(org?.email ?? "");
  const [address, setAddress] = useState(org?.address ?? "");
  const [active, setActive] = useState(org?.active ?? true);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const save = async () => {
    let problem: string | null = null;
    if (!name.trim() || name.trim().length > 200) problem = "Organization name must be 1 to 200 characters";
    else if (code.trim().length > 50) problem = "Code must be at most 50 characters";
    else if (email.trim() && !EMAIL_RE.test(email.trim())) problem = "Enter a valid email address";
    else if (address.trim().length > 500) problem = "Address must be at most 500 characters";
    if (problem) throw new Error(problem);
    // blank code / email / address clear them
    await upsertExternalOrg({
      id: org?.id ?? null,
      name: name.trim(),
      code: code.trim(),
      email: email.trim(),
      address: address.trim(),
      active,
    });
    toast.success(org ? "Organisation updated" : "Organisation added");
    onSaved();
  };

  return (
    <EditDialog
      title={org ? "Edit organisation" : "Add organisation"}
      description="An outside agency or company (cơ quan, đơn vị ngoài)."
      formId="external-org-form"
      error={error}
      saving={saving}
      onOpenChange={onOpenChange}
      onSubmit={() => run(save, setSaving, setError, () => onOpenChange(false))}
    >
      <TextField id="eo-name" label="Name" value={name} onChange={setName} maxLength={200} autoFocus />
      <div className="grid gap-4 sm:grid-cols-2">
        <TextField id="eo-code" label="Code" value={code} onChange={setCode} maxLength={50} className="font-mono" />
        <TextField id="eo-email" label="Email" value={email} onChange={setEmail} type="email" maxLength={320} />
      </div>
      <TextField id="eo-address" label="Address" value={address} onChange={setAddress} maxLength={500} />
      <Check label="Active" hint="Inactive organisations stay on old documents but cannot be picked." checked={active} onChange={setActive} />
    </EditDialog>
  );
}

// ---------------------------------------------------------------- shared bits

/** Runs a save with the busy flag and error message handled; `done` on success. */
async function run(
  action: () => Promise<void>,
  setBusy: (busy: boolean) => void,
  setError: (error: string | null) => void,
  done: () => void
) {
  setBusy(true);
  setError(null);
  try {
    await action();
    done();
  } catch (err) {
    setError(getErrorMessage(err));
  } finally {
    setBusy(false);
  }
}

function PanelBar({ text, action, onAction }: { text: string; action: string; onAction: () => void }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-2">
      <p className="min-w-0 flex-1 text-sm text-muted-foreground">{text}</p>
      <Button onClick={onAction}>
        <Plus aria-hidden />
        {action}
      </Button>
    </div>
  );
}

function ListState<T>({
  rows,
  error,
  empty,
  label,
  children,
}: {
  rows: T[] | null;
  error: string | null;
  empty: string;
  label: string;
  children: React.ReactNode;
}) {
  if (error) {
    return (
      <p className="text-sm text-destructive" role="alert">
        {error}
      </p>
    );
  }
  if (!rows) return <Loading label={label} />;
  if (rows.length === 0) {
    return (
      <p className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">{empty}</p>
    );
  }
  return <div className="rounded-xl border">{children}</div>;
}

function EditDialog({
  title,
  description,
  formId,
  error,
  saving,
  onOpenChange,
  onSubmit,
  children,
}: {
  title: string;
  description: string;
  formId: string;
  error: string | null;
  saving: boolean;
  onOpenChange: (open: boolean) => void;
  onSubmit: () => void;
  children: React.ReactNode;
}) {
  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        <form
          id={formId}
          className="space-y-4"
          noValidate
          onSubmit={(e) => {
            e.preventDefault();
            if (!saving) onSubmit();
          }}
        >
          {children}
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
          <button type="submit" form={formId} disabled={saving} className={buttonVariants()}>
            {saving ? "Saving…" : "Save"}
          </button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function TextField({
  id,
  label,
  value,
  onChange,
  hint,
  className,
  ...rest
}: {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  hint?: string;
  className?: string;
  type?: string;
  maxLength?: number;
  placeholder?: string;
  autoFocus?: boolean;
}) {
  return (
    <div className="space-y-2">
      <Label htmlFor={id}>{label}</Label>
      <Input
        id={id}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className={className}
        aria-describedby={hint ? `${id}-hint` : undefined}
        {...rest}
      />
      {hint && (
        <p id={`${id}-hint`} className="text-xs text-muted-foreground">
          {hint}
        </p>
      )}
    </div>
  );
}

function Check({
  label,
  hint,
  checked,
  onChange,
}: {
  label: string;
  hint?: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <label className="flex items-start gap-2 text-sm">
      <input
        type="checkbox"
        className="mt-0.5 size-4 accent-primary"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
      />
      <span>
        {label}
        {hint && <span className="block text-xs text-muted-foreground">{hint}</span>}
      </span>
    </label>
  );
}

function ActiveBadge({ active }: { active: boolean }) {
  return active ? <Badge variant="outline">Active</Badge> : <Badge variant="secondary">Inactive</Badge>;
}

function EditButton({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <Button variant="ghost" size="icon-sm" aria-label={label} onClick={onClick}>
      <Pencil aria-hidden />
    </Button>
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
