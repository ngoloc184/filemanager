"use client";

import { useEffect, useId, useMemo, useState } from "react";
import { BookUser, Building, Check, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { listExternalOrgs } from "@/lib/services/documents";
import { upsertExternalOrg } from "@/lib/services/document-admin";
import { findExternalOrgByName, matchExternalOrgs } from "@/lib/documents/form";
import type { ExternalOrg } from "@/lib/documents/types";
import { getErrorMessage } from "@/lib/types/database";
import { cn } from "@/lib/utils";

/**
 * Issuing organisation (cơ quan ban hành): free text with autocomplete over the
 * company's outside organizations. Picking one (or typing its exact name) sets
 * externalOrgId; any other text clears it. Clerks and admins can save a new
 * name as a contact.
 */
export function ExternalOrgInput(props: {
  value: string;
  externalOrgId: string | null;
  onChange: (name: string, externalOrgId: string | null) => void;
  /** clerks and admins may add contacts (upsert_external_org) */
  canSave?: boolean;
  id?: string;
  disabled?: boolean;
  invalid?: boolean;
  required?: boolean;
  "aria-describedby"?: string;
  className?: string;
}) {
  const { value, externalOrgId, onChange, canSave = false, disabled } = props;
  const listId = useId();
  const [orgs, setOrgs] = useState<ExternalOrg[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let cancelled = false;
    listExternalOrgs()
      .then((rows) => {
        if (!cancelled) setOrgs(rows);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setLoadError(getErrorMessage(err));
        setOrgs([]);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const options = useMemo(() => matchExternalOrgs(orgs ?? [], value), [orgs, value]);
  const activeIndex = Math.min(active, Math.max(options.length - 1, 0));
  const picked = externalOrgId ? (orgs ?? []).find((o) => o.id === externalOrgId) ?? null : null;
  const showList = open && !disabled && options.length > 0;

  const type = (text: string) => {
    // an exact name links the contact without picking it from the list
    const exact = orgs ? findExternalOrgByName(orgs, text) : null;
    onChange(text, exact?.id ?? null);
    setActive(0);
    setOpen(true);
  };

  const pick = (org: ExternalOrg) => {
    onChange(org.name, org.id);
    setOpen(false);
  };

  const save = async () => {
    const name = value.trim();
    if (!name) return;
    setSaving(true);
    try {
      const org = await upsertExternalOrg({ name });
      setOrgs((rows) =>
        [...(rows ?? []).filter((o) => o.id !== org.id), org].sort((a, b) => a.name.localeCompare(b.name, "vi"))
      );
      onChange(org.name, org.id);
      toast.success(`Saved "${org.name}" as a contact`);
    } catch (err) {
      toast.error(getErrorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      if (!open) setOpen(true);
      else setActive(Math.min(activeIndex + 1, options.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive(Math.max(activeIndex - 1, 0));
    } else if (e.key === "Enter") {
      if (showList && options[activeIndex]) {
        e.preventDefault();
        pick(options[activeIndex]);
      }
    } else if (e.key === "Escape") {
      if (open) {
        e.preventDefault();
        e.stopPropagation();
        setOpen(false);
      }
    }
  };

  const optionId = (i: number) => `${listId}-option-${i}`;
  const canSaveContact = canSave && !externalOrgId && value.trim().length > 0 && orgs !== null;

  return (
    <div className={cn("relative", props.className)}>
      <div className="relative">
        <Building
          className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground"
          aria-hidden
        />
        <input
          id={props.id}
          type="text"
          role="combobox"
          aria-expanded={showList}
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={showList ? optionId(activeIndex) : undefined}
          aria-invalid={props.invalid || undefined}
          aria-required={props.required || undefined}
          aria-describedby={props["aria-describedby"]}
          autoComplete="off"
          maxLength={500}
          disabled={disabled}
          placeholder="e.g. UBND tỉnh Đồng Nai"
          value={value}
          onChange={(e) => type(e.target.value)}
          onFocus={() => setOpen(true)}
          onBlur={() => setOpen(false)}
          onKeyDown={onKeyDown}
          className="h-8 w-full min-w-0 rounded-lg border border-input bg-transparent py-1 pr-8 pl-8 text-base outline-none transition-colors placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20 md:text-sm dark:bg-input/30"
        />
        {externalOrgId && (
          <Check
            className="pointer-events-none absolute top-1/2 right-2.5 size-4 -translate-y-1/2 text-success"
            aria-label="Saved contact"
          />
        )}
      </div>

      <div className="mt-1 flex min-h-4 flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
        {picked?.code && <span>Code: {picked.code}</span>}
        {externalOrgId && !picked?.code && <span>Saved contact</span>}
        {canSaveContact && (
          <button
            type="button"
            onClick={() => void save()}
            disabled={saving || disabled}
            className="inline-flex items-center gap-1 rounded text-primary underline-offset-3 hover:underline focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none disabled:opacity-50"
          >
            {saving ? (
              <Loader2 className="size-3 animate-spin" aria-hidden />
            ) : (
              <BookUser className="size-3" aria-hidden />
            )}
            Save as a contact
          </button>
        )}
        {loadError && <span className="text-destructive">{loadError}</span>}
      </div>

      {open && (
        <ul
          id={listId}
          role="listbox"
          aria-label="Saved organisations"
          hidden={!showList}
          className="absolute top-9 z-50 max-h-64 w-full overflow-y-auto rounded-lg bg-popover p-1 text-popover-foreground shadow-md ring-1 ring-foreground/10"
        >
          {options.map((org, i) => (
            <li
              key={org.id}
              id={optionId(i)}
              role="option"
              aria-selected={i === activeIndex}
              // pick before the input blurs and closes the list
              onMouseDown={(e) => {
                e.preventDefault();
                pick(org);
              }}
              onMouseEnter={() => setActive(i)}
              className={cn(
                "cursor-default rounded-md px-2 py-1.5 text-sm",
                i === activeIndex && "bg-accent text-accent-foreground"
              )}
            >
              <span className="block truncate font-medium">{org.name}</span>
              {org.code && <span className="block truncate text-xs text-muted-foreground">{org.code}</span>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
