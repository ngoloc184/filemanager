"use client";

import { useEffect, useState } from "react";
import { Check, Loader2, Pencil, Plus, Trash2, X } from "lucide-react";
import { toast } from "sonner";
import { Button, buttonVariants } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import {
  deleteOrgHoliday,
  deletePosition,
  listHolidays,
  listPositions,
  setOrgHoliday,
  upsertPosition,
  type OrgHoliday,
  type Position,
} from "@/lib/services/org";
import { dayYear, isoDay } from "@/lib/org-forms";
import { getErrorMessage } from "@/lib/types/database";

/** Admin settings: positions (chức vụ) and company holidays for deadline maths. */
export function PositionsHolidaysPanel() {
  return (
    <div className="grid gap-6 xl:grid-cols-2">
      <PositionsCard />
      <HolidaysCard />
    </div>
  );
}

// ---------------------------------------------------------------- positions

type PositionDraft = { name: string; rank: string; canSign: boolean };

function parseRank(rank: string): number | null {
  const n = Number(rank.trim() || "0");
  return Number.isInteger(n) ? n : null;
}

function PositionsCard() {
  const [positions, setPositions] = useState<Position[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [version, setVersion] = useState(0);
  const [draft, setDraft] = useState<PositionDraft>({ name: "", rank: "0", canSign: false });
  const [editingId, setEditingId] = useState<string | null>(null);
  const [edit, setEdit] = useState<PositionDraft>({ name: "", rank: "0", canSign: false });
  const [busy, setBusy] = useState(false);
  const [deleting, setDeleting] = useState<Position | null>(null);

  useEffect(() => {
    let cancelled = false;
    listPositions()
      .then((rows) => {
        if (cancelled) return;
        setPositions(rows);
        setError(null);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setError(getErrorMessage(err));
        setPositions((prev) => prev ?? []);
      });
    return () => {
      cancelled = true;
    };
  }, [version]);

  const save = async (id: string | null, value: PositionDraft): Promise<boolean> => {
    const rank = parseRank(value.rank);
    if (!value.name.trim()) {
      toast.error("Enter a position name");
      return false;
    }
    if (rank === null) {
      toast.error("Rank must be a whole number");
      return false;
    }
    setBusy(true);
    try {
      await upsertPosition({ id, name: value.name.trim(), rank, canSign: value.canSign });
      toast.success(id ? "Position updated" : "Position added");
      setVersion((v) => v + 1);
      return true;
    } catch (err) {
      toast.error(getErrorMessage(err));
      return false;
    } finally {
      setBusy(false);
    }
  };

  const add = async (e: React.FormEvent) => {
    e.preventDefault();
    if (busy) return;
    if (await save(null, draft)) setDraft({ name: "", rank: "0", canSign: false });
  };

  const startEdit = (p: Position) => {
    setEditingId(p.id);
    setEdit({ name: p.name, rank: String(p.rank), canSign: p.can_sign });
  };

  const saveEdit = async () => {
    if (!editingId || busy) return;
    if (await save(editingId, edit)) setEditingId(null);
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Positions (Chức vụ)</CardTitle>
        <CardDescription>
          Higher rank sorts first. &quot;Can sign&quot; marks positions that may sign outgoing documents.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <form onSubmit={add} className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_5.5rem_auto_auto] sm:items-end" noValidate>
          <div className="space-y-1">
            <Label htmlFor="pos-new-name" className="text-xs">
              Name
            </Label>
            <Input
              id="pos-new-name"
              value={draft.name}
              onChange={(e) => setDraft({ ...draft, name: e.target.value })}
              placeholder="e.g. Giám đốc"
              maxLength={100}
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="pos-new-rank" className="text-xs">
              Rank
            </Label>
            <Input
              id="pos-new-rank"
              type="number"
              inputMode="numeric"
              step={1}
              value={draft.rank}
              onChange={(e) => setDraft({ ...draft, rank: e.target.value })}
            />
          </div>
          <label className="flex h-8 items-center gap-2 text-sm">
            <input
              type="checkbox"
              className="size-4 accent-primary"
              checked={draft.canSign}
              onChange={(e) => setDraft({ ...draft, canSign: e.target.checked })}
            />
            Can sign
          </label>
          <button type="submit" disabled={busy || !draft.name.trim()} className={buttonVariants()}>
            <Plus aria-hidden />
            Add
          </button>
        </form>

        {error && (
          <p className="text-sm text-destructive" role="alert">
            {error}
          </p>
        )}

        {positions === null ? (
          <Loading label="Loading positions…" />
        ) : positions.length === 0 ? (
          <p className="text-sm text-muted-foreground">No positions yet.</p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead className="w-24">Rank</TableHead>
                <TableHead className="w-24">Can sign</TableHead>
                <TableHead className="w-20">
                  <span className="sr-only">Actions</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {positions.map((p) =>
                editingId === p.id ? (
                  <TableRow key={p.id}>
                    <TableCell>
                      <Input
                        value={edit.name}
                        onChange={(e) => setEdit({ ...edit, name: e.target.value })}
                        aria-label="Position name"
                        maxLength={100}
                        autoFocus
                        onKeyDown={(e) => {
                          if (e.key === "Enter") void saveEdit();
                          if (e.key === "Escape") setEditingId(null);
                        }}
                      />
                    </TableCell>
                    <TableCell>
                      <Input
                        type="number"
                        inputMode="numeric"
                        step={1}
                        value={edit.rank}
                        onChange={(e) => setEdit({ ...edit, rank: e.target.value })}
                        aria-label="Rank"
                      />
                    </TableCell>
                    <TableCell>
                      <input
                        type="checkbox"
                        className="size-4 accent-primary"
                        checked={edit.canSign}
                        onChange={(e) => setEdit({ ...edit, canSign: e.target.checked })}
                        aria-label="Can sign"
                      />
                    </TableCell>
                    <TableCell>
                      <div className="flex gap-1">
                        <Button variant="ghost" size="icon-sm" onClick={() => void saveEdit()} disabled={busy} aria-label="Save position">
                          <Check />
                        </Button>
                        <Button variant="ghost" size="icon-sm" onClick={() => setEditingId(null)} aria-label="Cancel editing">
                          <X />
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                ) : (
                  <TableRow key={p.id}>
                    <TableCell className="font-medium whitespace-normal">{p.name}</TableCell>
                    <TableCell className="tabular-nums">{p.rank}</TableCell>
                    <TableCell>
                      <input
                        type="checkbox"
                        className="size-4 accent-primary"
                        checked={p.can_sign}
                        disabled={busy}
                        onChange={(e) =>
                          void save(p.id, { name: p.name, rank: String(p.rank), canSign: e.target.checked })
                        }
                        aria-label={`${p.name} can sign`}
                      />
                    </TableCell>
                    <TableCell>
                      <div className="flex gap-1">
                        <Button variant="ghost" size="icon-sm" onClick={() => startEdit(p)} aria-label={`Edit ${p.name}`}>
                          <Pencil />
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          className="text-destructive"
                          onClick={() => setDeleting(p)}
                          aria-label={`Delete ${p.name}`}
                        >
                          <Trash2 />
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                )
              )}
            </TableBody>
          </Table>
        )}
      </CardContent>

      {deleting && (
        <ConfirmDialog
          title="Delete position"
          description={`Delete "${deleting.name}"? People holding it keep their other details.`}
          action="Delete"
          onOpenChange={(open) => !open && setDeleting(null)}
          onConfirm={async () => {
            await deletePosition(deleting.id);
            toast.success("Position deleted");
            setVersion((v) => v + 1);
          }}
        />
      )}
    </Card>
  );
}

// ---------------------------------------------------------------- holidays

const dayFormat = new Intl.DateTimeFormat("en-GB", {
  weekday: "short",
  day: "2-digit",
  month: "short",
  year: "numeric",
});

function formatDay(day: string): string {
  const [y, m, d] = day.split("-").map(Number);
  return dayFormat.format(new Date(y, m - 1, d));
}

function HolidaysCard() {
  const [holidays, setHolidays] = useState<OrgHoliday[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [version, setVersion] = useState(0);
  const [year, setYear] = useState(() => new Date().getFullYear());
  const [day, setDay] = useState("");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [deleting, setDeleting] = useState<OrgHoliday | null>(null);

  useEffect(() => {
    let cancelled = false;
    listHolidays()
      .then((rows) => {
        if (cancelled) return;
        setHolidays(rows);
        setError(null);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setError(getErrorMessage(err));
        setHolidays((prev) => prev ?? []);
      });
    return () => {
      cancelled = true;
    };
  }, [version]);

  const thisYear = new Date().getFullYear();
  const years = [thisYear, thisYear + 1];
  const shown = (holidays ?? []).filter((h) => dayYear(h.day) === year);

  const add = async (e: React.FormEvent) => {
    e.preventDefault();
    if (busy) return;
    if (dayYear(day) !== year) {
      toast.error(`Pick a day in ${year}`);
      return;
    }
    if (!name.trim()) {
      toast.error("Enter a holiday name");
      return;
    }
    setBusy(true);
    try {
      await setOrgHoliday(day, name.trim());
      toast.success("Holiday saved");
      setDay("");
      setName("");
      setVersion((v) => v + 1);
    } catch (err) {
      toast.error(getErrorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Holidays (Ngày nghỉ)</CardTitle>
        <CardDescription>
          Deadlines count working days, Monday to Friday, minus these days.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div role="group" aria-label="Year" className="inline-flex rounded-lg border p-0.5">
          {years.map((y) => (
            <button
              key={y}
              type="button"
              aria-pressed={y === year}
              onClick={() => {
                setYear(y);
                setDay("");
              }}
              className={
                y === year
                  ? "rounded-md bg-primary px-3 py-1 text-sm font-medium text-primary-foreground"
                  : "rounded-md px-3 py-1 text-sm text-muted-foreground hover:text-foreground"
              }
            >
              {y}
            </button>
          ))}
        </div>

        <form onSubmit={add} className="grid gap-2 sm:grid-cols-[10rem_minmax(0,1fr)_auto] sm:items-end" noValidate>
          <div className="space-y-1">
            <Label htmlFor="holiday-day" className="text-xs">
              Date
            </Label>
            <Input
              id="holiday-day"
              type="date"
              value={day}
              min={isoDay(new Date(year, 0, 1))}
              max={isoDay(new Date(year, 11, 31))}
              onChange={(e) => setDay(e.target.value)}
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="holiday-name" className="text-xs">
              Name
            </Label>
            <Input
              id="holiday-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Tết Nguyên Đán"
              maxLength={200}
            />
          </div>
          <button type="submit" disabled={busy || !day || !name.trim()} className={buttonVariants()}>
            <Plus aria-hidden />
            Add
          </button>
        </form>

        {error && (
          <p className="text-sm text-destructive" role="alert">
            {error}
          </p>
        )}

        {holidays === null ? (
          <Loading label="Loading holidays…" />
        ) : shown.length === 0 ? (
          <p className="text-sm text-muted-foreground">No holidays in {year} yet.</p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-40">Date</TableHead>
                <TableHead>Name</TableHead>
                <TableHead className="w-12">
                  <span className="sr-only">Actions</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {shown.map((h) => (
                <TableRow key={h.day}>
                  <TableCell className="tabular-nums">
                    <time dateTime={h.day}>{formatDay(h.day)}</time>
                  </TableCell>
                  <TableCell className="whitespace-normal">{h.name}</TableCell>
                  <TableCell>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      className="text-destructive"
                      onClick={() => setDeleting(h)}
                      aria-label={`Delete ${h.name}`}
                    >
                      <Trash2 />
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>

      {deleting && (
        <ConfirmDialog
          title="Delete holiday"
          description={`Delete "${deleting.name}" (${formatDay(deleting.day)})? Deadlines will count it as a working day.`}
          action="Delete"
          onOpenChange={(open) => !open && setDeleting(null)}
          onConfirm={async () => {
            await deleteOrgHoliday(deleting.day);
            toast.success("Holiday deleted");
            setVersion((v) => v + 1);
          }}
        />
      )}
    </Card>
  );
}

// ---------------------------------------------------------------- shared

function Loading({ label }: { label: string }) {
  return (
    <div className="flex items-center gap-2 text-sm text-muted-foreground" role="status">
      <Loader2 className="size-4 animate-spin" aria-hidden />
      {label}
    </div>
  );
}

function ConfirmDialog({
  title,
  description,
  action,
  onOpenChange,
  onConfirm,
}: {
  title: string;
  description: string;
  action: string;
  onOpenChange: (open: boolean) => void;
  onConfirm: () => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const confirm = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await onConfirm();
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
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
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
            {busy ? "Working…" : action}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
