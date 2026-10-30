"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Archive, Loader2, MoreHorizontal, Pencil, Plus } from "lucide-react";
import { toast } from "sonner";
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
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { DepartmentSelect } from "@/components/org/department-select";
import { PersonPicker } from "@/components/org/person-picker";
import {
  archiveDepartment,
  listDepartments,
  listOrgMembers,
  upsertDepartment,
  type Department,
  type DirectoryPerson,
} from "@/lib/services/org";
import { buildDepartmentTree, flattenTree, memberLabel, normalizeCode } from "@/lib/org";
import { descendantIds, validateDepartmentForm } from "@/lib/org-forms";
import { getErrorMessage } from "@/lib/types/database";

type Loaded = { departments: Department[]; people: DirectoryPerson[] };

async function loadAll(): Promise<Loaded> {
  const [departments, people] = await Promise.all([listDepartments(), listOrgMembers(null, true)]);
  return { departments, people };
}

/** Department tree with head and member count; admins add, edit and archive. */
export function DepartmentsPanel({ isAdmin }: { isAdmin: boolean }) {
  const [data, setData] = useState<Loaded | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<Department | "new" | null>(null);
  const [archiving, setArchiving] = useState<Department | null>(null);

  const reload = useCallback(async () => {
    try {
      setData(await loadAll());
      setError(null);
    } catch (err) {
      setError(getErrorMessage(err));
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    loadAll()
      .then((result) => {
        if (!cancelled) setData(result);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(getErrorMessage(err));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const tree = useMemo(
    () => buildDepartmentTree((data?.departments ?? []).filter((d) => !d.archived_at)),
    [data]
  );
  const rows = useMemo(() => flattenTree(tree), [tree]);
  const people = useMemo(() => new Map((data?.people ?? []).map((p) => [p.user_id, p])), [data]);
  const counts = useMemo(() => {
    const map = new Map<string, number>();
    for (const p of data?.people ?? []) {
      if (p.status === "active" && p.department_id) {
        map.set(p.department_id, (map.get(p.department_id) ?? 0) + 1);
      }
    }
    return map;
  }, [data]);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-muted-foreground">
          {isAdmin
            ? "Departments route incoming documents to their head (Trưởng phòng)."
            : "Departments of your company. Only admins can change them."}
        </p>
        {isAdmin && (
          <Button onClick={() => setEditing("new")}>
            <Plus aria-hidden />
            Add department
          </Button>
        )}
      </div>

      {error && (
        <p className="text-sm text-destructive" role="alert">
          {error}
        </p>
      )}

      {!data && !error ? (
        <div className="flex items-center gap-2 text-sm text-muted-foreground" role="status">
          <Loader2 className="size-4 animate-spin" aria-hidden />
          Loading departments…
        </div>
      ) : rows.length === 0 ? (
        <p className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">
          No departments yet.
        </p>
      ) : (
        <div className="rounded-xl border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>Code</TableHead>
                <TableHead>Head</TableHead>
                <TableHead className="text-right">Members</TableHead>
                {isAdmin && (
                  <TableHead className="w-10">
                    <span className="sr-only">Actions</span>
                  </TableHead>
                )}
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((d) => {
                const head = d.head_user_id ? people.get(d.head_user_id) : undefined;
                return (
                  <TableRow key={d.id}>
                    <TableCell>
                      <span
                        className="block font-medium whitespace-normal"
                        style={{ paddingLeft: `${d.depth * 1.25}rem` }}
                      >
                        {d.depth > 0 && (
                          <span className="mr-1 text-muted-foreground" aria-hidden>
                            └
                          </span>
                        )}
                        {d.name}
                      </span>
                    </TableCell>
                    <TableCell className="font-mono text-xs">{d.code}</TableCell>
                    <TableCell>{head ? memberLabel(head) : <span className="text-muted-foreground">—</span>}</TableCell>
                    <TableCell className="text-right tabular-nums">{counts.get(d.id) ?? 0}</TableCell>
                    {isAdmin && (
                      <TableCell>
                        <DropdownMenu>
                          <DropdownMenuTrigger
                            render={
                              <button
                                className="inline-flex size-8 items-center justify-center rounded-md hover:bg-muted hover:text-foreground"
                                aria-label={`Actions for ${d.name}`}
                              />
                            }
                          >
                            <MoreHorizontal className="size-4" />
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end">
                            <DropdownMenuItem onClick={() => setEditing(d)}>
                              <Pencil aria-hidden />
                              Edit
                            </DropdownMenuItem>
                            <DropdownMenuItem variant="destructive" onClick={() => setArchiving(d)}>
                              <Archive aria-hidden />
                              Archive
                            </DropdownMenuItem>
                          </DropdownMenuContent>
                        </DropdownMenu>
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
        <DepartmentDialog
          department={editing === "new" ? null : editing}
          excludeIds={editing === "new" ? [] : [editing.id, ...descendantIds(tree, editing.id)]}
          onOpenChange={(open) => !open && setEditing(null)}
          onSaved={() => void reload()}
        />
      )}
      {archiving && (
        <ArchiveDialog
          department={archiving}
          onOpenChange={(open) => !open && setArchiving(null)}
          onArchived={() => void reload()}
        />
      )}
    </div>
  );
}

function DepartmentDialog({
  department,
  excludeIds,
  onOpenChange,
  onSaved,
}: {
  department: Department | null;
  excludeIds: string[];
  onOpenChange: (open: boolean) => void;
  onSaved: () => void;
}) {
  const [name, setName] = useState(department?.name ?? "");
  const [code, setCode] = useState(department?.code ?? "");
  const [parentId, setParentId] = useState<string | null>(department?.parent_id ?? null);
  const [headId, setHeadId] = useState<string | null>(department?.head_user_id ?? null);
  const [sortOrder, setSortOrder] = useState(String(department?.sort_order ?? 0));
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    if (saving) return;
    const problem = validateDepartmentForm({ name, code });
    const order = Number(sortOrder);
    if (problem || !Number.isInteger(order)) {
      setError(problem ?? "Sort order must be a whole number");
      return;
    }
    setError(null);
    setSaving(true);
    try {
      await upsertDepartment({
        id: department?.id ?? null,
        name: name.trim(),
        code,
        parentId,
        headUserId: headId,
        sortOrder: order,
      });
      toast.success(department ? "Department updated" : "Department added");
      onSaved();
      onOpenChange(false);
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{department ? "Edit department" : "Add department"}</DialogTitle>
          <DialogDescription>A department (phòng ban) can sit inside another one.</DialogDescription>
        </DialogHeader>
        <form id="department-form" onSubmit={save} className="space-y-4" noValidate>
          <div className="space-y-2">
            <Label htmlFor="dept-name">Name</Label>
            <Input
              id="dept-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Phòng Hành chính"
              maxLength={200}
              autoFocus
            />
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="dept-code">Code</Label>
              <Input
                id="dept-code"
                value={code}
                onChange={(e) => setCode(normalizeCode(e.target.value))}
                placeholder="HC"
                maxLength={20}
                aria-describedby="dept-code-hint"
              />
              <p id="dept-code-hint" className="text-xs text-muted-foreground">
                Letters, digits or dashes; used as {"{dept}"} in notations.
              </p>
            </div>
            <div className="space-y-2">
              <Label htmlFor="dept-order">Sort order</Label>
              <Input
                id="dept-order"
                type="number"
                inputMode="numeric"
                step={1}
                value={sortOrder}
                onChange={(e) => setSortOrder(e.target.value)}
              />
            </div>
          </div>
          <div className="space-y-2">
            <Label htmlFor="dept-parent">Parent department</Label>
            <DepartmentSelect
              id="dept-parent"
              value={parentId}
              onChange={setParentId}
              excludeIds={excludeIds}
              allowNone
              placeholder="None (top level)"
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="dept-head">Head (Trưởng phòng)</Label>
            <PersonPicker
              id="dept-head"
              value={headId}
              onChange={(id) => setHeadId(id)}
              placeholder="Search active members"
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
          <button type="submit" form="department-form" disabled={saving} className={buttonVariants()}>
            {saving ? "Saving…" : "Save"}
          </button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ArchiveDialog({
  department,
  onOpenChange,
  onArchived,
}: {
  department: Department;
  onOpenChange: (open: boolean) => void;
  onArchived: () => void;
}) {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const confirm = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await archiveDepartment(department.id);
      toast.success(`${department.name} archived`);
      onArchived();
      onOpenChange(false);
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Archive department</DialogTitle>
          <DialogDescription>
            Archive &quot;{department.name}&quot;? It disappears from pickers; its documents keep their history.
          </DialogDescription>
        </DialogHeader>
        {error && (
          <p className="text-sm text-destructive" role="alert">
            {error}
          </p>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>
            Cancel
          </Button>
          <Button variant="destructive" onClick={() => void confirm()} disabled={busy}>
            {busy ? "Archiving…" : "Archive"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
