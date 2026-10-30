import { createClient } from "@/lib/supabase/client";
import { getErrorMessage } from "@/lib/types/database";
import type { MemberStatus, OrgRole } from "@/lib/org";

// Company (organization) data. Reads of departments, positions and holidays go
// through RLS table selects; everything else is an RPC from
// 202608280034_organizations.sql.

export type Organization = {
  id: string;
  name: string;
  short_name: string | null;
  code: string;
  tax_code: string | null;
  address: string | null;
  timezone: string;
  created_by: string | null;
  created_at: string;
  updated_at: string;
};

export type MyMembership = {
  roles: OrgRole[];
  department_id: string | null;
  department_name: string | null;
  position_id: string | null;
  position_name: string | null;
  status: MemberStatus;
};

export type MyOrg = { org: Organization; me: MyMembership };

export type Department = {
  id: string;
  org_id: string;
  parent_id: string | null;
  name: string;
  code: string;
  head_user_id: string | null;
  sort_order: number;
  archived_at: string | null;
  created_at: string;
};

export type Position = {
  id: string;
  org_id: string;
  name: string;
  rank: number;
  can_sign: boolean;
};

export type OrgHoliday = { org_id: string; day: string; name: string };

export type OrgInvitation = {
  id: string;
  org_id: string;
  email: string;
  department_id: string | null;
  position_id: string | null;
  roles: OrgRole[];
  token: string;
  invited_by: string | null;
  created_at: string;
  expires_at: string;
  accepted_at: string | null;
  accepted_by: string | null;
  revoked_at: string | null;
};

export type InvitationStatus = "pending" | "expired" | "accepted" | "revoked";

export type InvitationInfo = {
  org_name: string;
  email: string;
  roles: OrgRole[];
  department_name: string | null;
  position_name: string | null;
  expires_at: string;
  status: InvitationStatus;
};

/** One person as list_org_members / search_directory return them. */
export type DirectoryPerson = {
  user_id: string;
  email: string;
  display_name: string | null;
  avatar_path: string | null;
  department_id: string | null;
  department_name: string | null;
  position_id: string | null;
  position_name: string | null;
  can_sign: boolean;
  roles: OrgRole[];
  title: string | null;
  status: MemberStatus;
  joined_at: string;
};

/** Omitted sortOrder keeps the stored value on edit (0 for a new department). */
export type DepartmentInput = {
  id?: string | null;
  name: string;
  code: string;
  parentId?: string | null;
  headUserId?: string | null;
  sortOrder?: number;
};

/** Omitted rank / canSign keep the stored values on edit (0 / false when new). */
export type PositionInput = {
  id?: string | null;
  name: string;
  rank?: number;
  canSign?: boolean;
};

export type OrganizationInput = {
  name: string;
  shortName?: string | null;
  code: string;
  taxCode?: string | null;
  address?: string | null;
  timezone: string;
};

export type InviteInput = {
  email: string;
  departmentId?: string | null;
  positionId?: string | null;
  roles: OrgRole[];
};

export type MemberInput = {
  departmentId?: string | null;
  positionId?: string | null;
  roles: OrgRole[];
  title?: string | null;
};

/** Explains a missing migration instead of showing PostgREST's raw error. */
function orgError(error: unknown): Error {
  const code = (error as { code?: string } | null)?.code;
  const message = getErrorMessage(error);
  if (
    code === "PGRST202" ||
    code === "PGRST205" ||
    /could not find the (function|table)/i.test(message)
  ) {
    return new Error(
      "Company features are not set up yet. Run migration 202608280034_organizations.sql."
    );
  }
  return new Error(message);
}

// ---------------------------------------------------------------- company

export async function createOrganization(
  name: string,
  code: string,
  shortName?: string | null
): Promise<Organization> {
  const { data, error } = await createClient()
    .rpc("create_organization", { p_name: name, p_code: code, p_short_name: shortName ?? null })
    .single();
  if (error) throw orgError(error);
  return data as Organization;
}

/** The caller's company and membership (active or suspended), or null. */
export async function getMyOrg(): Promise<MyOrg | null> {
  const { data, error } = await createClient().rpc("get_my_org");
  if (error) throw orgError(error);
  return (data ?? null) as MyOrg | null;
}

export async function updateOrganization(input: OrganizationInput): Promise<Organization> {
  const { data, error } = await createClient()
    .rpc("update_organization", {
      p_name: input.name,
      p_short_name: input.shortName ?? null,
      p_code: input.code,
      p_tax_code: input.taxCode ?? null,
      p_address: input.address ?? null,
      p_timezone: input.timezone,
    })
    .single();
  if (error) throw orgError(error);
  return data as Organization;
}

// ---------------------------------------------------------------- departments

/** Departments of the caller's company (RLS), archived ones included. */
export async function listDepartments(): Promise<Department[]> {
  const { data, error } = await createClient()
    .from("departments")
    .select("*")
    .order("sort_order")
    .order("name");
  if (error) throw orgError(error);
  return (data ?? []) as Department[];
}

export async function upsertDepartment(input: DepartmentInput): Promise<Department> {
  const { data, error } = await createClient()
    .rpc("upsert_department", {
      p_id: input.id ?? null,
      p_name: input.name,
      p_code: input.code,
      p_parent_id: input.parentId ?? null,
      p_head_user_id: input.headUserId ?? null,
      p_sort_order: input.sortOrder ?? null,
    })
    .single();
  if (error) throw orgError(error);
  return data as Department;
}

export async function archiveDepartment(id: string): Promise<void> {
  const { error } = await createClient().rpc("archive_department", { p_id: id });
  if (error) throw orgError(error);
}

// ---------------------------------------------------------------- positions

export async function listPositions(): Promise<Position[]> {
  const { data, error } = await createClient()
    .from("positions")
    .select("*")
    .order("rank", { ascending: false })
    .order("name");
  if (error) throw orgError(error);
  return (data ?? []) as Position[];
}

export async function upsertPosition(input: PositionInput): Promise<Position> {
  const { data, error } = await createClient()
    .rpc("upsert_position", {
      p_id: input.id ?? null,
      p_name: input.name,
      p_rank: input.rank ?? null,
      p_can_sign: input.canSign ?? null,
    })
    .single();
  if (error) throw orgError(error);
  return data as Position;
}

export async function deletePosition(id: string): Promise<void> {
  const { error } = await createClient().rpc("delete_position", { p_id: id });
  if (error) throw orgError(error);
}

// ---------------------------------------------------------------- invitations

export async function inviteMember(input: InviteInput): Promise<OrgInvitation> {
  const { data, error } = await createClient()
    .rpc("invite_member", {
      p_email: input.email,
      p_department_id: input.departmentId ?? null,
      p_position_id: input.positionId ?? null,
      p_roles: input.roles,
    })
    .single();
  if (error) throw orgError(error);
  return data as OrgInvitation;
}

/** All invitations of the caller's company, pending first (admins only). */
export async function listOrgInvitations(): Promise<OrgInvitation[]> {
  const { data, error } = await createClient().rpc("list_org_invitations");
  if (error) throw orgError(error);
  return (data ?? []) as OrgInvitation[];
}

export async function revokeInvitation(id: string): Promise<void> {
  const { error } = await createClient().rpc("revoke_invitation", { p_id: id });
  if (error) throw orgError(error);
}

/** The invitation behind a link; fails unless it was sent to the caller's e-mail. */
export async function getInvitation(token: string): Promise<InvitationInfo> {
  const { data, error } = await createClient().rpc("get_invitation", { p_token: token });
  if (error) throw orgError(error);
  return data as InvitationInfo;
}

/** Joins the company; returns its id. */
export async function acceptInvitation(token: string): Promise<string> {
  const { data, error } = await createClient().rpc("accept_invitation", { p_token: token });
  if (error) throw orgError(error);
  return data as string;
}

// ---------------------------------------------------------------- members

export async function listOrgMembers(
  query?: string | null,
  includeInactive = false
): Promise<DirectoryPerson[]> {
  const { data, error } = await createClient().rpc("list_org_members", {
    p_query: query?.trim() || null,
    p_include_inactive: includeInactive,
  });
  if (error) throw orgError(error);
  return (data ?? []) as DirectoryPerson[];
}

/** Person picker: active members of the caller's company (limit 1..50). */
export async function searchDirectory(q: string, limit = 20): Promise<DirectoryPerson[]> {
  const { data, error } = await createClient().rpc("search_directory", {
    p_q: q.trim() || null,
    p_limit: limit,
  });
  if (error) throw orgError(error);
  return (data ?? []) as DirectoryPerson[];
}

export async function updateMember(userId: string, input: MemberInput): Promise<void> {
  const { error } = await createClient().rpc("update_member", {
    p_user_id: userId,
    p_department_id: input.departmentId ?? null,
    p_position_id: input.positionId ?? null,
    p_roles: input.roles,
    p_title: input.title ?? null,
  });
  if (error) throw orgError(error);
}

export async function setMemberStatus(userId: string, status: MemberStatus): Promise<void> {
  const { error } = await createClient().rpc("set_member_status", {
    p_user_id: userId,
    p_status: status,
  });
  if (error) throw orgError(error);
}

// ---------------------------------------------------------------- holidays

export async function listHolidays(): Promise<OrgHoliday[]> {
  const { data, error } = await createClient().from("org_holidays").select("*").order("day");
  if (error) throw orgError(error);
  return (data ?? []) as OrgHoliday[];
}

/** Adds or renames the holiday on `day` (YYYY-MM-DD). */
export async function setOrgHoliday(day: string, name: string): Promise<void> {
  const { error } = await createClient().rpc("set_org_holiday", { p_day: day, p_name: name });
  if (error) throw orgError(error);
}

export async function deleteOrgHoliday(day: string): Promise<void> {
  const { error } = await createClient().rpc("delete_org_holiday", { p_day: day });
  if (error) throw orgError(error);
}
