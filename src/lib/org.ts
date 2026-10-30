// Company (organization) model helpers. Pure: no Supabase imports, so the
// same rules run in tests, server code and client components.
// The regexes mirror the checks in 202608280034_organizations.sql.

export const ORG_ROLES = ["org_admin", "clerk", "leader", "dept_head", "staff"] as const;

export type OrgRole = (typeof ORG_ROLES)[number];

export const ROLE_LABELS: Record<OrgRole, string> = {
  org_admin: "Admin",
  clerk: "Records clerk (Văn thư)",
  leader: "Leader (Lãnh đạo)",
  dept_head: "Department head (Trưởng phòng)",
  staff: "Staff (Chuyên viên)",
};

export const MEMBER_STATUSES = ["active", "suspended", "left"] as const;

export type MemberStatus = (typeof MEMBER_STATUSES)[number];

const ORG_CODE_RE = /^[A-ZĐ0-9]{2,15}$/;
const DEPARTMENT_CODE_RE = /^[A-ZĐ0-9-]{1,20}$/;

export function isOrgRole(value: unknown): value is OrgRole {
  return typeof value === "string" && (ORG_ROLES as readonly string[]).includes(value);
}

/** True when `me` (anything with a roles list, e.g. get_my_org().me) holds `role`. */
export function hasRole(
  me: { roles?: readonly string[] | null } | null | undefined,
  role: OrgRole
): boolean {
  return !!me?.roles?.includes(role);
}

/** Upper-cases, trims and removes all whitespace: " abc d " → "ABCD". */
export function normalizeCode(s: string): string {
  return s.trim().toUpperCase().replace(/\s+/g, "");
}

export function isValidOrgCode(code: string): boolean {
  return ORG_CODE_RE.test(code);
}

export function isValidDepartmentCode(code: string): boolean {
  return DEPARTMENT_CODE_RE.test(code);
}

/** Labels for a roles list in the canonical order; unknown roles are skipped. */
export function roleLabels(roles: readonly string[] | null | undefined): string[] {
  return ORG_ROLES.filter((r) => roles?.includes(r)).map((r) => ROLE_LABELS[r]);
}

/** Name shown for a person: display name, else e-mail. */
export function memberLabel(m: { display_name?: string | null; email?: string | null }): string {
  return m.display_name?.trim() || m.email || "";
}

export type DepartmentRow = {
  id: string;
  parent_id: string | null;
  name: string;
  sort_order: number;
};

export type DepartmentNode<T extends DepartmentRow = DepartmentRow> = T & {
  children: DepartmentNode<T>[];
};

export type FlatDepartment<T extends DepartmentRow = DepartmentRow> = T & { depth: number };

function compareDepartments(a: DepartmentRow, b: DepartmentRow): number {
  return a.sort_order - b.sort_order || a.name.localeCompare(b.name, "vi");
}

/**
 * Nests departments under their parents, sorted by sort_order then name.
 * A department whose parent is missing is a root. Rows caught in a parent
 * cycle (bad data) are cut loose at the member that sorts first, so every row
 * appears exactly once and the walk always ends.
 */
export function buildDepartmentTree<T extends DepartmentRow>(rows: readonly T[]): DepartmentNode<T>[] {
  const nodes = new Map<string, DepartmentNode<T>>();
  for (const row of rows) if (!nodes.has(row.id)) nodes.set(row.id, { ...row, children: [] });

  const childrenOf = new Map<string, DepartmentNode<T>[]>();
  for (const node of nodes.values()) {
    if (!node.parent_id || !nodes.has(node.parent_id)) continue;
    const list = childrenOf.get(node.parent_id) ?? [];
    list.push(node);
    childrenOf.set(node.parent_id, list);
  }

  const visited = new Set<string>();
  const attach = (node: DepartmentNode<T>) => {
    visited.add(node.id);
    for (const child of childrenOf.get(node.id) ?? []) {
      if (visited.has(child.id)) continue;
      node.children.push(child);
      attach(child);
    }
  };

  const roots: DepartmentNode<T>[] = [];
  for (const node of nodes.values()) {
    if (!node.parent_id || !nodes.has(node.parent_id)) {
      roots.push(node);
      attach(node);
    }
  }
  // Whatever is left hangs off a cycle: promote one row at a time.
  const leftover = [...nodes.values()]
    .filter((n) => !visited.has(n.id))
    .sort((a, b) => compareDepartments(a, b) || a.id.localeCompare(b.id));
  for (const node of leftover) {
    if (visited.has(node.id)) continue;
    roots.push(node);
    attach(node);
  }

  const sortAll = (list: DepartmentNode<T>[]) => {
    list.sort(compareDepartments);
    for (const n of list) sortAll(n.children);
  };
  sortAll(roots);
  return roots;
}

/** Depth-first list with depth, e.g. for an indented <select>. */
export function flattenTree<T extends DepartmentRow>(tree: readonly DepartmentNode<T>[]): FlatDepartment<T>[] {
  const out: FlatDepartment<T>[] = [];
  const walk = (list: readonly DepartmentNode<T>[], depth: number) => {
    for (const node of list) {
      const { children, ...row } = node;
      out.push({ ...(row as unknown as T), depth });
      walk(children, depth + 1);
    }
  };
  walk(tree, 0);
  return out;
}
