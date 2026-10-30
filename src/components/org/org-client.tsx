"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Building2, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { OrgCreateForm } from "@/components/org/org-create-form";
import { DepartmentsPanel } from "@/components/org/departments-panel";
import { MembersPanel } from "@/components/org/members-panel";
import { InvitationsPanel } from "@/components/org/invitations-panel";
import { PositionsHolidaysPanel } from "@/components/org/positions-holidays-panel";
import { nativeSelectClass } from "@/components/org/department-select";
import { getMyOrg, updateOrganization, type MyOrg } from "@/lib/services/org";
import { hasRole, isValidOrgCode, normalizeCode, roleLabels } from "@/lib/org";
import { timeZoneOptions, validateOrgForm } from "@/lib/org-forms";
import { getErrorMessage } from "@/lib/types/database";
import type { SessionUser } from "@/lib/auth";
import { cn } from "@/lib/utils";

type TabId = "overview" | "departments" | "people" | "invitations" | "settings";

const TABS: { id: TabId; label: string; adminOnly: boolean }[] = [
  { id: "overview", label: "Overview", adminOnly: false },
  { id: "departments", label: "Departments", adminOnly: false },
  { id: "people", label: "People", adminOnly: false },
  { id: "invitations", label: "Invitations", adminOnly: true },
  { id: "settings", label: "Positions & holidays", adminOnly: true },
];

function supportedTimeZones(): string[] | null {
  try {
    const intl = Intl as typeof Intl & { supportedValuesOf?: (key: string) => string[] };
    return intl.supportedValuesOf?.("timeZone") ?? null;
  } catch {
    return null;
  }
}

/** Company page: the create form for newcomers, the tabbed admin view for members. */
export default function OrgClient({ user }: { user: SessionUser }) {
  const [data, setData] = useState<MyOrg | null | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<TabId>("overview");

  const load = useCallback(async () => {
    try {
      const result = await getMyOrg();
      setData(result);
      setError(null);
    } catch (err) {
      setError(getErrorMessage(err));
      setData(null);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    getMyOrg()
      .then((result) => {
        if (!cancelled) setData(result);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setError(getErrorMessage(err));
        setData(null);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (data === undefined) {
    return (
      <div className="flex items-center gap-2 text-sm text-muted-foreground" role="status">
        <Loader2 className="size-4 animate-spin" aria-hidden />
        Loading company…
      </div>
    );
  }

  if (error) {
    return (
      <Card className="max-w-xl">
        <CardHeader>
          <CardTitle>Could not load your company</CardTitle>
          <CardDescription className="text-destructive">{error}</CardDescription>
        </CardHeader>
        <CardContent>
          <Button variant="outline" onClick={() => void load()}>
            Try again
          </Button>
        </CardContent>
      </Card>
    );
  }

  if (!data) return <OrgCreateForm onCreated={() => void load()} />;

  const { org, me } = data;
  const isAdmin = hasRole(me, "org_admin") && me.status === "active";
  // company data is readable by active members only (RLS), so a suspended
  // member gets the Overview and the notice, not empty lists
  const tabs = TABS.filter(
    (t) => (isAdmin || !t.adminOnly) && (me.status === "active" || t.id === "overview")
  );
  const activeTab = tabs.some((t) => t.id === tab) ? tab : "overview";

  return (
    <div className="max-w-6xl space-y-6">
      <div className="flex flex-wrap items-center gap-3">
        <Building2 className="size-7 shrink-0 text-primary" aria-hidden />
        <h2 className="min-w-0 text-2xl font-bold [overflow-wrap:anywhere]">{org.name}</h2>
        <Badge variant="secondary" className="font-mono" title="Company code">
          {org.code}
        </Badge>
      </div>

      {me.status === "suspended" && (
        <p className="rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive" role="status">
          Your membership is suspended. Ask a company admin to reactivate it.
        </p>
      )}

      <Tabs tabs={tabs} active={activeTab} onChange={setTab} />

      <div role="tabpanel" id={`org-panel-${activeTab}`} aria-labelledby={`org-tab-${activeTab}`}>
        {activeTab === "overview" && (
          <OverviewPanel
            data={data}
            isAdmin={isAdmin}
            onSaved={(updated) => setData({ org: updated, me })}
          />
        )}
        {activeTab === "departments" && <DepartmentsPanel isAdmin={isAdmin} />}
        {activeTab === "people" && (
          <MembersPanel isAdmin={isAdmin} currentUserId={user.id} onChanged={() => void load()} />
        )}
        {activeTab === "invitations" && isAdmin && <InvitationsPanel />}
        {activeTab === "settings" && isAdmin && <PositionsHolidaysPanel />}
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
      aria-label="Company sections"
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
            id={`org-tab-${t.id}`}
            aria-selected={selected}
            aria-controls={`org-panel-${t.id}`}
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

function OverviewPanel({
  data,
  isAdmin,
  onSaved,
}: {
  data: MyOrg;
  isAdmin: boolean;
  onSaved: (org: MyOrg["org"]) => void;
}) {
  const { org, me } = data;
  const [name, setName] = useState(org.name);
  const [code, setCode] = useState(org.code);
  const [shortName, setShortName] = useState(org.short_name ?? "");
  const [taxCode, setTaxCode] = useState(org.tax_code ?? "");
  const [address, setAddress] = useState(org.address ?? "");
  const [timezone, setTimezone] = useState(org.timezone);
  const [zones] = useState(() => timeZoneOptions(supportedTimeZones(), org.timezone));
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const dirty =
    name !== org.name ||
    code !== org.code ||
    shortName !== (org.short_name ?? "") ||
    taxCode !== (org.tax_code ?? "") ||
    address !== (org.address ?? "") ||
    timezone !== org.timezone;
  const codeInvalid = code.length > 0 && !isValidOrgCode(code);

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    if (saving || !dirty) return;
    const problem = validateOrgForm({ name, code });
    if (problem) {
      setError(problem);
      return;
    }
    setError(null);
    setSaving(true);
    try {
      const updated = await updateOrganization({
        name: name.trim(),
        code,
        shortName: shortName.trim() || null,
        taxCode: taxCode.trim() || null,
        address: address.trim() || null,
        timezone,
      });
      // the server trims and blanks optional fields; show what it stored so
      // the form is clean again
      setName(updated.name);
      setCode(updated.code);
      setShortName(updated.short_name ?? "");
      setTaxCode(updated.tax_code ?? "");
      setAddress(updated.address ?? "");
      setTimezone(updated.timezone);
      onSaved(updated);
      toast.success("Company details saved");
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  const myRoles = roleLabels(me.roles);

  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
      <Card>
        <CardHeader>
          <CardTitle>Company details</CardTitle>
          <CardDescription>
            {isAdmin
              ? "The code appears in document numbers. The time zone decides the document year and deadlines."
              : "Only company admins can change these details."}
          </CardDescription>
        </CardHeader>
        <CardContent>
          {isAdmin ? (
            <form onSubmit={save} className="grid gap-4 sm:grid-cols-2" noValidate>
              <Field id="ov-name" label="Company name" className="sm:col-span-2">
                <Input id="ov-name" value={name} onChange={(e) => setName(e.target.value)} maxLength={200} />
              </Field>
              <Field id="ov-code" label="Company code">
                <Input
                  id="ov-code"
                  value={code}
                  onChange={(e) => setCode(normalizeCode(e.target.value))}
                  maxLength={15}
                  aria-invalid={codeInvalid || undefined}
                  aria-describedby="ov-code-hint"
                />
                <p id="ov-code-hint" className="text-xs text-muted-foreground">
                  Used in document numbers, e.g. 15/QĐ-{code || "ABC"}
                </p>
              </Field>
              <Field id="ov-short" label="Short name">
                <Input id="ov-short" value={shortName} onChange={(e) => setShortName(e.target.value)} maxLength={50} />
              </Field>
              <Field id="ov-tax" label="Tax code (Mã số thuế)">
                <Input id="ov-tax" value={taxCode} onChange={(e) => setTaxCode(e.target.value)} maxLength={30} />
              </Field>
              <Field id="ov-tz" label="Time zone">
                <select
                  id="ov-tz"
                  className={nativeSelectClass}
                  value={timezone}
                  onChange={(e) => setTimezone(e.target.value)}
                >
                  {zones.map((z) => (
                    <option key={z} value={z}>
                      {z}
                    </option>
                  ))}
                </select>
              </Field>
              <Field id="ov-address" label="Address" className="sm:col-span-2">
                <Input id="ov-address" value={address} onChange={(e) => setAddress(e.target.value)} maxLength={500} />
              </Field>
              {error && (
                <p className="text-sm text-destructive sm:col-span-2" role="alert">
                  {error}
                </p>
              )}
              <div className="sm:col-span-2">
                <button type="submit" disabled={!dirty || saving} className={buttonVariants()}>
                  {saving ? "Saving…" : "Save changes"}
                </button>
              </div>
            </form>
          ) : (
            <dl className="grid gap-x-6 gap-y-3 sm:grid-cols-2">
              <ReadOnly label="Company name" value={org.name} />
              <ReadOnly label="Company code" value={org.code} />
              <ReadOnly label="Short name" value={org.short_name} />
              <ReadOnly label="Tax code (Mã số thuế)" value={org.tax_code} />
              <ReadOnly label="Address" value={org.address} />
              <ReadOnly label="Time zone" value={org.timezone} />
            </dl>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>You</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-2">
            <p className="text-sm font-medium">Your roles</p>
            {myRoles.length > 0 ? (
              <div className="flex flex-wrap gap-1.5">
                {myRoles.map((label) => (
                  <Badge key={label} variant="outline">
                    {label}
                  </Badge>
                ))}
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">No roles yet.</p>
            )}
          </div>
          <dl className="grid gap-3">
            <ReadOnly label="Department" value={me.department_name} />
            <ReadOnly label="Position" value={me.position_name} />
          </dl>
        </CardContent>
      </Card>
    </div>
  );
}

function Field({
  id,
  label,
  className,
  children,
}: {
  id: string;
  label: string;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <div className={cn("space-y-2", className)}>
      <Label htmlFor={id}>{label}</Label>
      {children}
    </div>
  );
}

function ReadOnly({ label, value }: { label: string; value: string | null | undefined }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="text-sm [overflow-wrap:anywhere]">{value || "—"}</dd>
    </div>
  );
}
