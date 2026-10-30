"use client";

import { useEffect, useMemo, useState } from "react";
import { listDepartments, type Department } from "@/lib/services/org";
import { buildDepartmentTree, flattenTree } from "@/lib/org";
import { getErrorMessage } from "@/lib/types/database";
import { cn } from "@/lib/utils";

/** Native select styled like the Input primitive; shared by the org forms. */
export const nativeSelectClass =
  "h-8 w-full min-w-0 rounded-lg border border-input bg-background px-2 py-1 text-base text-foreground outline-none transition-colors focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50 md:text-sm dark:bg-input/30";

/**
 * Department picker for the caller's company, indented by depth. Archived
 * departments are hidden unless one is the current value.
 */
export function DepartmentSelect(props: {
  value: string | null;
  onChange: (id: string | null) => void;
  excludeIds?: string[];
  allowNone?: boolean;
  placeholder?: string;
  id?: string;
  disabled?: boolean;
  className?: string;
  "aria-label"?: string;
}) {
  const { value, onChange, excludeIds, allowNone = true, placeholder = "No department" } = props;
  const [departments, setDepartments] = useState<Department[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    listDepartments()
      .then((rows) => {
        if (!cancelled) setDepartments(rows);
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setError(getErrorMessage(err));
          setDepartments([]);
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const options = useMemo(() => {
    const excluded = new Set(excludeIds ?? []);
    const rows = (departments ?? []).filter((d) => !d.archived_at || d.id === value);
    return flattenTree(buildDepartmentTree(rows)).filter((d) => !excluded.has(d.id));
  }, [departments, excludeIds, value]);

  const loading = departments === null;

  return (
    <>
      <select
        id={props.id}
        aria-label={props["aria-label"]}
        className={cn(nativeSelectClass, props.className)}
        value={value ?? ""}
        disabled={props.disabled || loading}
        onChange={(e) => onChange(e.target.value || null)}
      >
        {(allowNone || !value) && (
          <option value="" disabled={!allowNone}>
            {loading ? "Loading…" : placeholder}
          </option>
        )}
        {options.map((d) => (
          <option key={d.id} value={d.id}>
            {`${"   ".repeat(d.depth)}${d.depth > 0 ? "└ " : ""}${d.name} (${d.code})${
              d.archived_at ? " (archived)" : ""
            }`}
          </option>
        ))}
      </select>
      {error && <p className="mt-1 text-xs text-destructive">{error}</p>}
    </>
  );
}
