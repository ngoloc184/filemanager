import { createClient } from "@/lib/supabase/client";

export type ShareRoleInput = "viewer" | "editor" | "admin";

export type ShareEntry = {
  share_id: string;
  grantee_id: string;
  grantee_email: string;
  role: ShareRoleInput;
  created_at: string;
};

export type SharedItem = {
  item_type: "folder" | "file";
  id: string;
  name: string;
  role: ShareRoleInput;
  owner_email: string;
  shared_at: string;
  size: number | null;
  mime_type: string | null;
  current_version_id: string | null;
};

export type ShareLink = {
  link_id: string;
  token: string;
  role: "viewer" | "editor";
  has_password: boolean;
  allow_download: boolean;
  expires_at: string | null;
  disabled: boolean;
  created_at: string;
  view_count: number;
  last_used_at: string | null;
};

export type SharedFileAccess = {
  file_id: string;
  name: string;
  mime_type: string;
  size: number;
  current_version_id: string | null;
  allow_download: boolean;
};

export async function shareFile(
  fileId: string,
  email: string,
  role: ShareRoleInput
): Promise<void> {
  const supabase = createClient();
  const { error } = await supabase.rpc("share_file", {
    p_file_id: fileId,
    p_grantee_email: email,
    p_role: role,
  });
  if (error) throw error;
}

export async function shareFolder(
  folderId: string,
  email: string,
  role: ShareRoleInput
): Promise<void> {
  const supabase = createClient();
  const { error } = await supabase.rpc("share_folder", {
    p_folder_id: folderId,
    p_grantee_email: email,
    p_role: role,
  });
  if (error) throw error;
}

export async function listFileShares(fileId: string): Promise<ShareEntry[]> {
  const supabase = createClient();
  const { data, error } = await supabase.rpc("list_file_shares", {
    p_file_id: fileId,
  });
  if (error) throw error;
  return (data ?? []) as ShareEntry[];
}

export async function listFolderShares(folderId: string): Promise<ShareEntry[]> {
  const supabase = createClient();
  const { data, error } = await supabase.rpc("list_folder_shares", {
    p_folder_id: folderId,
  });
  if (error) throw error;
  return (data ?? []) as ShareEntry[];
}

export async function updateShareRole(
  kind: "file" | "folder",
  shareId: string,
  role: ShareRoleInput
): Promise<void> {
  const supabase = createClient();
  const { error } = await supabase.rpc(
    kind === "file" ? "update_file_share" : "update_folder_share",
    { p_share_id: shareId, p_role: role }
  );
  if (error) throw error;
}

export async function removeShare(
  kind: "file" | "folder",
  shareId: string
): Promise<void> {
  const supabase = createClient();
  const { error } = await supabase.rpc(
    kind === "file" ? "unshare_file" : "unshare_folder",
    { p_share_id: shareId }
  );
  if (error) throw error;
}

export async function listSharedWithMe(): Promise<SharedItem[]> {
  const supabase = createClient();
  const { data, error } = await supabase.rpc("list_shared_with_me");
  if (error) throw error;
  return (data ?? []) as SharedItem[];
}

export async function createShareLink(
  fileId: string,
  options: {
    role?: "viewer" | "editor";
    password?: string | null;
    allowDownload?: boolean;
    expiresAt?: string | null;
  }
): Promise<ShareLink> {
  const supabase = createClient();
  const { data, error } = await supabase
    .rpc("create_share_link", {
      p_file_id: fileId,
      p_role: options.role ?? "viewer",
      p_password: options.password ?? null,
      p_allow_download: options.allowDownload ?? true,
      p_expires_at: options.expiresAt ?? null,
    })
    .select()
    .single();
  if (error) throw error;
  const row = data as { token: string };
  const links = await listShareLinks(fileId);
  const created = links.find((link) => link.token === row.token);
  if (!created) throw new Error("Failed to load created link");
  return created;
}

export async function listShareLinks(fileId: string): Promise<ShareLink[]> {
  const supabase = createClient();
  const { data, error } = await supabase.rpc("list_share_links", {
    p_file_id: fileId,
  });
  if (error) throw error;
  return (data ?? []) as ShareLink[];
}

export async function setShareLinkDisabled(
  linkId: string,
  disabled: boolean
): Promise<void> {
  const supabase = createClient();
  const { error } = await supabase.rpc("set_share_link_disabled", {
    p_link_id: linkId,
    p_disabled: disabled,
  });
  if (error) throw error;
}

export async function deleteShareLink(linkId: string): Promise<void> {
  const supabase = createClient();
  const { error } = await supabase.rpc("delete_share_link", {
    p_link_id: linkId,
  });
  if (error) throw error;
}

export async function inspectShareLink(
  token: string
): Promise<{ file_name: string; requires_password: boolean; active: boolean } | null> {
  const supabase = createClient();
  const { data, error } = await supabase.rpc("inspect_share_link", {
    p_token: token,
  });
  if (error) throw error;
  const rows = (data ?? []) as Array<{
    file_name: string;
    requires_password: boolean;
    active: boolean;
  }>;
  return rows.length > 0 ? rows[0] : null;
}

export async function accessShareLink(
  token: string,
  password?: string
): Promise<SharedFileAccess> {
  const supabase = createClient();
  const { data, error } = await supabase.rpc("access_share_link", {
    p_token: token,
    p_password: password ?? null,
  });
  if (error) throw error;
  const rows = (data ?? []) as SharedFileAccess[];
  if (rows.length === 0) throw new Error("The shared file is no longer available");
  return rows[0];
}

export function shareLinkUrl(token: string): string {
  return `${window.location.origin}/share/${token}`;
}
