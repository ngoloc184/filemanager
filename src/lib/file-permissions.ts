/**
 * What the signed-in user may do with a file or folder, by their role on it.
 * Mirrors the database: has_file_access / has_folder_access and the RPCs that
 * check them (rename and versions need editor, share and delete need admin,
 * the public link toggle is owner-only). The database stays the authority;
 * this only decides which actions the UI offers.
 */

export type ItemRole = "owner" | "admin" | "editor" | "viewer";

export type ItemAction =
  | "download"
  | "comment"
  | "rename"
  | "move"
  | "edit_text"
  | "upload_version"
  | "restore_version"
  | "edit_tags"
  | "share"
  | "delete"
  | "toggle_public"
  | "details";

const VIEWER_ACTIONS: readonly ItemAction[] = ["download", "comment", "details"];

const EDITOR_ACTIONS: readonly ItemAction[] = [
  ...VIEWER_ACTIONS,
  "rename",
  "move",
  "edit_text",
  "upload_version",
  "restore_version",
  "edit_tags",
];

const ADMIN_ACTIONS: readonly ItemAction[] = [...EDITOR_ACTIONS, "share", "delete"];

const OWNER_ACTIONS: readonly ItemAction[] = [...ADMIN_ACTIONS, "toggle_public"];

const ACTIONS_BY_ROLE: Record<ItemRole, ReadonlySet<ItemAction>> = {
  viewer: new Set(VIEWER_ACTIONS),
  editor: new Set(EDITOR_ACTIONS),
  admin: new Set(ADMIN_ACTIONS),
  owner: new Set(OWNER_ACTIONS),
};

/** Whether `role` allows `action`; no role (no access) allows nothing. */
export function can(role: ItemRole | null | undefined, action: ItemAction): boolean {
  if (!role) return false;
  return ACTIONS_BY_ROLE[role]?.has(action) ?? false;
}

/**
 * The caller's role on an item: the my_role the listing RPC returned, or
 * 'owner' when the item is theirs (rows loaded without my_role, e.g. by
 * getFile or the fallback queries). Unknown roles on others' items are null.
 */
export function roleOf(
  item: { owner_id: string; my_role?: ItemRole | null },
  userId: string
): ItemRole | null {
  if (item.owner_id === userId) return "owner";
  return item.my_role ?? null;
}
