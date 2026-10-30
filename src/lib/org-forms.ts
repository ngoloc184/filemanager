// Form rules for the company (organization) admin screens. Pure: no React or
// Supabase imports, so they run in node:test. The server repeats every check
// (202608280034_organizations.sql); these only give fast feedback.

import {
  ORG_ROLES,
  isValidDepartmentCode,
  isValidOrgCode,
  type DepartmentNode,
  type DepartmentRow,
  type OrgRole,
} from "./org.ts";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Error text for the invitation form, or null when it can be sent. */
export function validateInviteForm(input: { email: string; roles: readonly string[] }): string | null {
  if (!EMAIL_RE.test(input.email.trim())) return "Enter a valid email address";
  if (input.roles.length === 0) return "Pick at least one role";
  return null;
}

/** Error text for the department dialog; `code` is checked as typed (normalise it first). */
export function validateDepartmentForm(input: { name: string; code: string }): string | null {
  const name = input.name.trim();
  if (!name) return "Enter a department name";
  if (name.length > 200) return "Department name must be at most 200 characters";
  if (!isValidDepartmentCode(input.code)) {
    return "Department code must be 1 to 20 letters, digits or dashes";
  }
  return null;
}

/** Error text for the company form (create and Overview); `code` is checked as typed. */
export function validateOrgForm(input: { name: string; code: string }): string | null {
  const name = input.name.trim();
  if (name.length < 2 || name.length > 200) return "Company name must be 2 to 200 characters";
  if (!isValidOrgCode(input.code)) return "Company code must be 2 to 15 letters or digits";
  return null;
}

/**
 * Ids of every department below `id` (not `id` itself), so a parent picker can
 * leave out the department and its whole subtree. Unknown id → [].
 */
export function descendantIds<T extends DepartmentRow>(
  tree: readonly DepartmentNode<T>[],
  id: string
): string[] {
  const find = (list: readonly DepartmentNode<T>[]): DepartmentNode<T> | null => {
    for (const node of list) {
      if (node.id === id) return node;
      const hit = find(node.children);
      if (hit) return hit;
    }
    return null;
  };
  const out: string[] = [];
  const collect = (list: readonly DepartmentNode<T>[]) => {
    for (const node of list) {
      out.push(node.id);
      collect(node.children);
    }
  };
  const root = find(tree);
  if (root) collect(root.children);
  return out;
}

/** Adds or removes `role`, keeping the canonical ORG_ROLES order. */
export function toggleRole(roles: readonly OrgRole[], role: OrgRole, on: boolean): OrgRole[] {
  return ORG_ROLES.filter((r) => (r === role ? on : roles.includes(r)));
}

/**
 * True when saving `next` would take org_admin away from the signed-in admin
 * themself. The UI blocks that ("Ask another admin"); the server keeps at
 * least one admin anyway.
 */
export function removesOwnAdmin(
  isSelf: boolean,
  current: readonly string[],
  next: readonly string[]
): boolean {
  return isSelf && current.includes("org_admin") && !next.includes("org_admin");
}

/** Used when the browser has no Intl.supportedValuesOf. */
export const FALLBACK_TIME_ZONES = [
  "Asia/Ho_Chi_Minh",
  "Asia/Bangkok",
  "Asia/Singapore",
  "Asia/Tokyo",
  "Asia/Seoul",
  "Asia/Shanghai",
  "Australia/Sydney",
  "Europe/London",
  "Europe/Paris",
  "America/New_York",
  "America/Los_Angeles",
  "UTC",
] as const;

/**
 * Time zones for the Overview select: the supported list (or the fallback),
 * plus `current` when the list lacks it, sorted and without duplicates.
 */
export function timeZoneOptions(supported: readonly string[] | null, current?: string | null): string[] {
  const list = new Set(supported && supported.length > 0 ? supported : FALLBACK_TIME_ZONES);
  if (current) list.add(current);
  return [...list].sort((a, b) => a.localeCompare(b));
}

/** Local calendar date as YYYY-MM-DD (no UTC shift). */
export function isoDay(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** Year of a YYYY-MM-DD string, or NaN. */
export function dayYear(day: string): number {
  return /^\d{4}-\d{2}-\d{2}$/.test(day) ? Number(day.slice(0, 4)) : NaN;
}
