"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { Loader2, MoreHorizontal, Pause, Pencil, Play, Search, UserMinus } from "lucide-react";
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
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { DepartmentSelect, nativeSelectClass } from "@/components/org/department-select";
import {
  listOrgMembers,
  listPositions,
  setMemberStatus,
  updateMember,
  type DirectoryPerson,
  type Position,
} from "@/lib/services/org";
import { ORG_ROLES, ROLE_LABELS, memberLabel, roleLabels, type MemberStatus, type OrgRole } from "@/lib/org";
import { removesOwnAdmin, toggleRole } from "@/lib/org-forms";
import { getErrorMessage } from "@/lib/types/database";
import { cn } from "@/lib/utils";

const STATUS_LABELS: Record<MemberStatus, string> = {
  active: "Active",
  suspended: "Suspended",
  left: "Left",
};

/** People directory; admins edit roles and placement, suspend and offboard. */
export function MembersPanel({
  isAdmin,
  currentUserId,
  onChanged,
}: {
  isAdmin: boolean;
  currentUserId: string;
  onChanged?: () => void;
}) {
  const [query, setQuery] = useState("");
  const [showFormer, setShowFormer] = useState(false);
  const [members, setMembers] = useState<DirectoryPerson[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [version, setVersion] = useState(0);
  const [editing, setEditing] = useState<DirectoryPerson | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  // debounced search; `version` forces a reload after a change
  useEffect(() => {
    let cancelled = false;
    const timer = window.setTimeout(() => {
      listOrgMembers(query, showFormer)
        .then((rows) => {
          if (cancelled) return;
          setMembers(rows);
          setError(null);
        })
        .catch((err: unknown) => {
          if (!cancelled) setError(getErrorMessage(err));
        });
    }, 250);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [query, showFormer, version]);

  const refresh = useCallback(() => {
    setVersion((v) => v + 1);
    onChanged?.();
  }, [onChanged]);

  const changeStatus = async (person: DirectoryPerson, status: MemberStatus) => {
    setBusyId(person.user_id);
    try {
      await setMemberStatus(person.user_id, status);
      toast.success(status === "active" ? `${memberLabel(person)} reactivated` : `${memberLabel(person)} suspended`);
      refresh();
    } catch (err) {
      toast.error(getErrorMessage(err));
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="relative w-full sm:max-w-xs">
          <Search
            className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground"
            aria-hidden
          />
          <Input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search name, email or department"
            aria-label="Search people"
            className="pl-8"
          />
        </div>
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            className="size-4 accent-primary"
            checked={showFormer}
            onChange={(e) => setShowFormer(e.target.checked)}
          />
          Show former members
          <span className="text-xs text-muted-foreground">(and suspended)</span>
        </label>
      </div>

      {error && (
        <p className="text-sm text-destructive" role="alert">
          {error}
        </p>
      )}

      {members === null && !error ? (
        <div className="flex items-center gap-2 text-sm text-muted-foreground" role="status">
          <Loader2 className="size-4 animate-spin" aria-hidden />
          Loading people…
        </div>
      ) : (members ?? []).length === 0 ? (
        <p className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">
          {query.trim() ? "Nobody matches your search." : "No people yet."}
        </p>
      ) : (
        <div className="rounded-xl border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name / email</TableHead>
                <TableHead>Department</TableHead>
                <TableHead>Position</TableHead>
                <TableHead>Roles</TableHead>
                <TableHead>Status</TableHead>
                {isAdmin && (
                  <TableHead className="w-10">
                    <span className="sr-only">Actions</span>
                  </TableHead>
                )}
              </TableRow>
            </TableHeader>
            <TableBody>
              {(members ?? []).map((m) => {
                const isSelf = m.user_id === currentUserId;
                return (
                  <TableRow key={m.user_id} className={cn(m.status !== "active" && "text-muted-foreground")}>
                    <TableCell>
                      <div className="max-w-56 min-w-0">
                        <div className="truncate font-medium">
                          {memberLabel(m)}
                          {isSelf && <span className="ml-1 text-xs font-normal text-muted-foreground">(you)</span>}
                        </div>
                        <div className="truncate text-xs text-muted-foreground">{m.email}</div>
                        {m.title && <div className="truncate text-xs text-muted-foreground">{m.title}</div>}
                      </div>
                    </TableCell>
                    <TableCell>{m.department_name ?? "—"}</TableCell>
                    <TableCell>{m.position_name ?? "—"}</TableCell>
                    <TableCell>
                      <div className="flex max-w-72 flex-wrap gap-1">
                        {roleLabels(m.roles).map((label) => (
                          <Badge key={label} variant="outline">
                            {label}
                          </Badge>
                        ))}
                      </div>
                    </TableCell>
                    <TableCell>
                      <Badge
                        variant={m.status === "active" ? "secondary" : m.status === "suspended" ? "destructive" : "outline"}
                      >
                        {STATUS_LABELS[m.status]}
                      </Badge>
                    </TableCell>
                    {isAdmin && (
                      <TableCell>
                        {m.status !== "left" && (
                          <DropdownMenu>
                            <DropdownMenuTrigger
                              disabled={busyId === m.user_id}
                              render={
                                <button
                                  className="inline-flex size-8 items-center justify-center rounded-md hover:bg-muted hover:text-foreground disabled:opacity-50"
                                  aria-label={`Actions for ${memberLabel(m)}`}
                                />
                              }
                            >
                              {busyId === m.user_id ? (
                                <Loader2 className="size-4 animate-spin" />
                              ) : (
                                <MoreHorizontal className="size-4" />
                              )}
                            </DropdownMenuTrigger>
                            <DropdownMenuContent align="end" className="min-w-40">
                              <DropdownMenuItem onClick={() => setEditing(m)}>
                                <Pencil aria-hidden />
                                Edit
                              </DropdownMenuItem>
                              {!isSelf &&
                                (m.status === "active" ? (
                                  <DropdownMenuItem onClick={() => void changeStatus(m, "suspended")}>
                                    <Pause aria-hidden />
                                    Suspend
                                  </DropdownMenuItem>
                                ) : (
                                  <DropdownMenuItem onClick={() => void changeStatus(m, "active")}>
                                    <Play aria-hidden />
                                    Reactivate
                                  </DropdownMenuItem>
                                ))}
                              {!isSelf && (
                                <>
                                  <DropdownMenuSeparator />
                                  <DropdownMenuItem
                                    variant="destructive"
                                    render={<Link href={`/org/offboarding?user=${encodeURIComponent(m.user_id)}`} />}
                                  >
                                    <UserMinus aria-hidden />
                                    Offboard…
                                  </DropdownMenuItem>
                                </>
                              )}
                            </DropdownMenuContent>
                          </DropdownMenu>
                        )}
                      </TableCell>
                    )}
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>
      )}

      {editing && (
        <MemberDialog
          person={editing}
          isSelf={editing.user_id === currentUserId}
          onOpenChange={(open) => !open && setEditing(null)}
          onSaved={refresh}
        />
      )}
    </div>
  );
}

function MemberDialog({
  person,
  isSelf,
  onOpenChange,
  onSaved,
}: {
  person: DirectoryPerson;
  isSelf: boolean;
  onOpenChange: (open: boolean) => void;
  onSaved: () => void;
}) {
  const [departmentId, setDepartmentId] = useState<string | null>(person.department_id);
  const [positionId, setPositionId] = useState<string | null>(person.position_id);
  const [roles, setRoles] = useState<OrgRole[]>(ORG_ROLES.filter((r) => person.roles.includes(r)));
  const [title, setTitle] = useState(person.title ?? "");
  const [positions, setPositions] = useState<Position[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let cancelled = false;
    listPositions()
      .then((rows) => {
        if (!cancelled) setPositions(rows);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setPositions([]);
        setError(getErrorMessage(err));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    if (saving) return;
    if (roles.length === 0) {
      setError("Pick at least one role");
      return;
    }
    if (removesOwnAdmin(isSelf, person.roles, roles)) {
      setError("You cannot remove your own admin role. Ask another admin.");
      return;
    }
    setError(null);
    setSaving(true);
    try {
      await updateMember(person.user_id, {
        departmentId,
        positionId,
        roles,
        title: title.trim() || null,
      });
      toast.success(`${memberLabel(person)} updated`);
      onSaved();
      onOpenChange(false);
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  const lockAdmin = isSelf && person.roles.includes("org_admin");

  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Edit {memberLabel(person)}</DialogTitle>
          <DialogDescription>{person.email}</DialogDescription>
        </DialogHeader>
        <form id="member-form" onSubmit={save} className="space-y-4" noValidate>
          <div className="space-y-2">
            <Label htmlFor="member-dept">Department</Label>
            <DepartmentSelect id="member-dept" value={departmentId} onChange={setDepartmentId} allowNone />
          </div>
          <div className="space-y-2">
            <Label htmlFor="member-position">Position</Label>
            <select
              id="member-position"
              className={nativeSelectClass}
              value={positionId ?? ""}
              disabled={positions === null}
              onChange={(e) => setPositionId(e.target.value || null)}
            >
              <option value="">{positions === null ? "Loading…" : "No position"}</option>
              {(positions ?? []).map((p) => (
                <option key={p.id} value={p.id}>
                  {p.can_sign ? `${p.name} (can sign)` : p.name}
                </option>
              ))}
            </select>
          </div>
          <fieldset className="space-y-2">
            <legend className="text-sm font-medium">Roles</legend>
            <div className="grid gap-2">
              {ORG_ROLES.map((role) => {
                const locked = role === "org_admin" && lockAdmin;
                return (
                  <label key={role} className="flex items-start gap-2 text-sm">
                    <input
                      type="checkbox"
                      className="mt-0.5 size-4 accent-primary"
                      checked={roles.includes(role)}
                      disabled={locked}
                      aria-describedby={locked ? "member-admin-hint" : undefined}
                      onChange={(e) => setRoles((prev) => toggleRole(prev, role, e.target.checked))}
                    />
                    <span>
                      {ROLE_LABELS[role]}
                      {locked && (
                        <span id="member-admin-hint" className="block text-xs text-muted-foreground">
                          Ask another admin to remove your admin role.
                        </span>
                      )}
                    </span>
                  </label>
                );
              })}
            </div>
          </fieldset>
          <div className="space-y-2">
            <Label htmlFor="member-title">Title</Label>
            <Input
              id="member-title"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="e.g. Deputy head of HR"
              maxLength={100}
            />
          </div>
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
          <button type="submit" form="member-form" disabled={saving} className={buttonVariants()}>
            {saving ? "Saving…" : "Save"}
          </button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
