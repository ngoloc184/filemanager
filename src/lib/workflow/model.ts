// Workflow builder: the plan document and its scheduling rules.
// Pure functions only (no DOM, no network), so they run in node:test as well as in the browser.
//
// Time is wall-clock time without a zone ("2026-11-02T08:00"), handled as minutes since 1970 in UTC
// so a time zone never shifts it. A step's length is working time: "1 d" is one working day of the
// plan's working hours (default 08:00–17:00 with a 12:00–13:00 break = 8 h, Saturday and Sunday
// off), "1 h" is one working hour. Steps do not store dates: the first steps start at the plan's
// start, every other step starts when the last step before it ends, and extensions (gia hạn)
// add to a step's length.

export const ROLE_COLORS = ["violet", "sky", "emerald", "amber", "rose", "teal", "orange", "slate"] as const;
export type RoleColor = (typeof ROLE_COLORS)[number];

export const STEP_STATUSES = ["todo", "doing", "done", "blocked"] as const;
export type StepStatus = (typeof STEP_STATUSES)[number];

export type DurationUnit = "h" | "d";
export interface Duration {
  amount: number;
  unit: DurationUnit;
}

export interface WorkHours {
  skipWeekends: boolean;
  /** "HH:mm" */
  dayStart: string;
  dayEnd: string;
  /** an optional break inside the day, e.g. lunch */
  breakStart: string | null;
  breakEnd: string | null;
}

export interface WorkflowRole {
  id: string;
  name: string;
  color: RoleColor;
}

export interface WorkflowStep {
  id: string;
  title: string;
  note: string;
  /** roles in charge (PIC); a step may have several */
  picIds: string[];
  duration: Duration;
  status: StepStatus;
  position: { x: number; y: number };
  /** set when someone confirmed the timeline (chốt); after that only extensions change it, or an admin */
  confirmed: { at: string; by: string; role: string } | null;
}

export interface WorkflowEdge {
  id: string;
  source: string;
  target: string;
}

/** What is saved in workflows.doc. The name, id and revision live in their own columns. */
export interface WorkflowDoc {
  version: 2;
  description: string;
  /** when the first steps start, "YYYY-MM-DDTHH:mm" */
  start: string;
  hours: WorkHours;
  roles: WorkflowRole[];
  steps: WorkflowStep[];
  edges: WorkflowEdge[];
  /** set on a copy made with "Nhân bản": the source's name only (its id would open the source) */
  clonedFrom: { name: string } | null;
}

/** One row of a step's history (workflow_step_logs). */
export interface StepLog {
  id: string;
  stepId: string;
  kind: "extend" | "duration" | "confirm";
  amount: number;
  unit: DurationUnit;
  oldAmount: number | null;
  oldUnit: DurationUnit | null;
  reason: string | null;
  requesterName: string;
  requesterRole: string;
  /** the person was signed in */
  signedIn: boolean;
  createdAt: string;
  cancelledAt: string | null;
}

export const LIMITS = { steps: 200, roles: 40, edges: 600, title: 300, note: 4000, name: 120, roleName: 60, amount: 999, reason: 1000, person: 80 };

export const DEFAULT_HOURS: WorkHours = { skipWeekends: true, dayStart: "08:00", dayEnd: "17:00", breakStart: "12:00", breakEnd: "13:00" };

// ---------------------------------------------------------------- clock

const DAY = 1440;
const STAMP_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const HM_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

/** "YYYY-MM-DDTHH:mm" → minutes, or NaN. */
export function parseStamp(stamp: string): number {
  const m = STAMP_RE.exec(stamp);
  if (!m) return NaN;
  const t = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]) / 60_000;
  return Number.isFinite(t) && formatStamp(t) === stamp ? t : NaN; // rejects 2026-02-30 and 25:00
}

export function formatStamp(t: number): string {
  return new Date(t * 60_000).toISOString().slice(0, 16);
}

export function isStamp(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(parseStamp(value));
}

export function isDay(value: unknown): value is string {
  return typeof value === "string" && DAY_RE.test(value) && isStamp(`${value}T00:00`);
}

export function isHm(value: unknown): value is string {
  return typeof value === "string" && HM_RE.test(value);
}

function hm(value: string): number {
  return Number(value.slice(0, 2)) * 60 + Number(value.slice(3, 5));
}

/** The viewer's wall-clock time now, as minutes. */
export function nowMinutes(now = new Date()): number {
  return Date.UTC(now.getFullYear(), now.getMonth(), now.getDate(), now.getHours(), now.getMinutes()) / 60_000;
}

export function todayDay(now = new Date()): string {
  return formatStamp(nowMinutes(now)).slice(0, 10);
}

/** 0 = Sunday … 6 = Saturday */
export function weekdayOf(t: number): number {
  return new Date(t * 60_000).getUTCDay();
}

// ---------------------------------------------------------------- working time

/** Working windows of one day as [from, to) minutes after midnight. */
function windows(day: number, hours: WorkHours): [number, number][] {
  const w = weekdayOf(day * DAY);
  if (hours.skipWeekends && (w === 0 || w === 6)) return [];
  const a = hm(hours.dayStart);
  const b = hm(hours.dayEnd);
  if (hours.breakStart && hours.breakEnd) {
    const bs = hm(hours.breakStart);
    const be = hm(hours.breakEnd);
    if (a < bs && bs < be && be < b) return [[a, bs], [be, b]];
  }
  return [[a, b]];
}

/** The working window of a day as a whole (first start, last end), for drawing. */
export function dayWindow(hours: WorkHours): [number, number] {
  return [hm(hours.dayStart), hm(hours.dayEnd)];
}

export function isOffDay(t: number, hours: WorkHours): boolean {
  return windows(Math.floor(t / DAY), hours).length === 0;
}

export function minutesPerDay(hours: WorkHours): number {
  return windows(1, { ...hours, skipWeekends: false }).reduce((sum, [a, b]) => sum + b - a, 0);
}

/** Working minutes of a duration. */
export function durationMinutes(d: Duration, hours: WorkHours): number {
  return d.unit === "h" ? d.amount * 60 : d.amount * minutesPerDay(hours);
}

const MAX_DAYS = 20_000; // ~55 years: enough for any plan, and a stop for broken input

/** The first working instant at or after t (the end of a window counts as outside it). */
export function normalizeStart(t: number, hours: WorkHours): number {
  let day = Math.floor(t / DAY);
  let pos = t - day * DAY;
  for (let i = 0; i < MAX_DAYS; i++, day++, pos = 0) {
    for (const [a, b] of windows(day, hours)) if (pos < b) return day * DAY + Math.max(a, pos);
  }
  return t;
}

/** The instant after `minutes` of work from t. */
export function addWork(t: number, minutes: number, hours: WorkHours): number {
  if (minutes <= 0) return t;
  let left = minutes;
  let day = Math.floor(t / DAY);
  let pos = t - day * DAY;
  for (let i = 0; i < MAX_DAYS; i++, day++, pos = 0) {
    for (const [a, b] of windows(day, hours)) {
      if (pos >= b) continue;
      const from = Math.max(a, pos);
      if (left <= b - from) return day * DAY + from + left;
      left -= b - from;
    }
  }
  return t + minutes;
}

/** Working minutes between two instants (0 when b is before a). */
export function workBetween(a: number, b: number, hours: WorkHours): number {
  if (b <= a) return 0;
  let sum = 0;
  for (let day = Math.floor(a / DAY), i = 0; day * DAY < b && i < MAX_DAYS; day++, i++) {
    for (const [wa, wb] of windows(day, hours)) {
      const from = Math.max(day * DAY + wa, a);
      const to = Math.min(day * DAY + wb, b);
      if (to > from) sum += to - from;
    }
  }
  return sum;
}

// ---------------------------------------------------------------- the schedule

export interface Slot {
  start: number;
  /** the end without extensions */
  baseEnd: number;
  /** the end with active extensions */
  end: number;
  baseMinutes: number;
  extraMinutes: number;
}

/** Active (not cancelled) extension minutes per step. */
export function extensionMinutes(logs: StepLog[], hours: WorkHours): Map<string, number> {
  const out = new Map<string, number>();
  for (const l of logs) {
    if (l.kind !== "extend" || l.cancelledAt) continue;
    out.set(l.stepId, (out.get(l.stepId) ?? 0) + durationMinutes({ amount: l.amount, unit: l.unit }, hours));
  }
  return out;
}

/** Step ids in dependency order (Kahn); steps caught in a loop come last in their original order. */
export function topoOrder(steps: Pick<WorkflowStep, "id">[], edges: WorkflowEdge[]): string[] {
  const ids = steps.map((s) => s.id);
  const known = new Set(ids);
  const indeg = new Map(ids.map((id) => [id, 0]));
  const next = new Map<string, string[]>(ids.map((id) => [id, []]));
  for (const e of edges) {
    if (!known.has(e.source) || !known.has(e.target)) continue;
    indeg.set(e.target, indeg.get(e.target)! + 1);
    next.get(e.source)!.push(e.target);
  }
  const queue = ids.filter((id) => indeg.get(id) === 0);
  const out: string[] = [];
  while (queue.length) {
    const id = queue.shift()!;
    out.push(id);
    for (const t of next.get(id)!) {
      indeg.set(t, indeg.get(t)! - 1);
      if (indeg.get(t) === 0) queue.push(t);
    }
  }
  const placed = new Set(out);
  return [...out, ...ids.filter((id) => !placed.has(id))];
}

/** When each step starts and ends: right after its last predecessor, or at the plan start. */
export function schedule(doc: Pick<WorkflowDoc, "start" | "hours" | "steps" | "edges">, logs: StepLog[] = []): Map<string, Slot> {
  const byId = new Map(doc.steps.map((s) => [s.id, s]));
  const preds = new Map<string, string[]>();
  for (const e of doc.edges) if (byId.has(e.source) && byId.has(e.target)) preds.set(e.target, [...(preds.get(e.target) ?? []), e.source]);
  const extra = extensionMinutes(logs, doc.hours);
  const planStart = normalizeStart(parseStamp(doc.start), doc.hours);
  const out = new Map<string, Slot>();
  for (const id of topoOrder(doc.steps, doc.edges)) {
    let start = planStart;
    for (const p of preds.get(id) ?? []) {
      const end = out.get(p)?.end;
      if (end !== undefined && end > start) start = end;
    }
    start = normalizeStart(start, doc.hours);
    const baseMinutes = durationMinutes(byId.get(id)!.duration, doc.hours);
    const extraMinutes = extra.get(id) ?? 0;
    out.set(id, {
      start,
      baseEnd: addWork(start, baseMinutes, doc.hours),
      end: addWork(start, baseMinutes + extraMinutes, doc.hours),
      baseMinutes,
      extraMinutes,
    });
  }
  return out;
}

/** First start and last end of the plan, or null without steps. */
export function planRange(slots: Map<string, Slot>): { start: number; end: number } | null {
  let range: { start: number; end: number } | null = null;
  for (const s of slots.values()) {
    range = range ? { start: Math.min(range.start, s.start), end: Math.max(range.end, s.end) } : { start: s.start, end: s.end };
  }
  return range;
}

/** Working days from the plan start to t: the "2" of "T+2" (one decimal). */
export function dayMark(doc: Pick<WorkflowDoc, "start" | "hours">, t: number): number {
  const from = normalizeStart(parseStamp(doc.start), doc.hours);
  return Math.round((workBetween(from, t, doc.hours) / minutesPerDay(doc.hours)) * 10) / 10;
}

export function isOverdue(step: WorkflowStep, slot: Slot | undefined, now: number): boolean {
  return !!slot && step.status !== "done" && slot.end < now;
}

// ---------------------------------------------------------------- the graph

/** True when an arrow source → target would close a loop (or points at itself). */
export function wouldCreateCycle(edges: WorkflowEdge[], source: string, target: string): boolean {
  if (source === target) return true;
  const stack = [target];
  const seen = new Set<string>();
  while (stack.length) {
    const id = stack.pop()!;
    if (id === source) return true;
    if (seen.has(id)) continue;
    seen.add(id);
    for (const e of edges) if (e.source === id) stack.push(e.target);
  }
  return false;
}

export type ConnectResult = { ok: true; edges: WorkflowEdge[] } | { ok: false; reason: "same" | "duplicate" | "cycle" | "limit" };

export function connectSteps(edges: WorkflowEdge[], source: string, target: string): ConnectResult {
  if (source === target) return { ok: false, reason: "same" };
  if (edges.some((e) => e.source === source && e.target === target)) return { ok: false, reason: "duplicate" };
  if (wouldCreateCycle(edges, source, target)) return { ok: false, reason: "cycle" };
  if (edges.length >= LIMITS.edges) return { ok: false, reason: "limit" };
  return { ok: true, edges: [...edges, { id: newId("e"), source, target }] };
}

export function removeSteps(doc: WorkflowDoc, ids: Iterable<string>): WorkflowDoc {
  const gone = new Set(ids);
  return { ...doc, steps: doc.steps.filter((s) => !gone.has(s.id)), edges: doc.edges.filter((e) => !gone.has(e.source) && !gone.has(e.target)) };
}

export function updateStep(doc: WorkflowDoc, id: string, fields: Partial<Omit<WorkflowStep, "id">>): WorkflowDoc {
  return { ...doc, steps: doc.steps.map((s) => (s.id === id ? { ...s, ...fields } : s)) };
}

export function clampAmount(n: number): number {
  return Math.min(LIMITS.amount, Math.max(1, Math.round(Number.isFinite(n) ? n : 1)));
}

export function makeStep(position: { x: number; y: number }, picIds: string[] = []): WorkflowStep {
  return {
    id: newId("s"),
    title: "",
    note: "",
    picIds,
    duration: { amount: 1, unit: "d" },
    status: "todo",
    position: { x: Math.round(position.x), y: Math.round(position.y) },
    confirmed: null,
  };
}

// ---------------------------------------------------------------- layout

export const NODE_W = 288;
export const NODE_H = 200;
const GAP_X = 88;
const GAP_Y = 80;

/**
 * Places steps in layers by dependency depth, left to right. Long chains wrap into rows that
 * snake back and forth (row 1 → right, row 2 ← left …) so a 12-step plan fits on one screen.
 */
export function autoLayout(steps: WorkflowStep[], edges: WorkflowEdge[], perRow = 4): WorkflowStep[] {
  const order = topoOrder(steps, edges);
  const depth = new Map<string, number>();
  for (const id of order) {
    let d = 0;
    for (const e of edges) if (e.target === id && depth.has(e.source)) d = Math.max(d, depth.get(e.source)! + 1);
    depth.set(id, d);
  }
  const layers: string[][] = [];
  for (const id of order) (layers[depth.get(id)!] ??= []).push(id);
  const rows: string[][][] = [];
  for (let i = 0; i < layers.length; i += perRow) rows.push(layers.slice(i, i + perRow).filter(Boolean));

  const pos = new Map<string, { x: number; y: number }>();
  let y = 0;
  rows.forEach((row, r) => {
    const tallest = Math.max(...row.map((l) => l.length));
    row.forEach((layer, i) => {
      const col = r % 2 === 0 ? i : perRow - 1 - i;
      const offset = ((tallest - layer.length) * (NODE_H + GAP_Y)) / 2;
      layer.forEach((id, k) => pos.set(id, { x: col * (NODE_W + GAP_X), y: y + offset + k * (NODE_H + GAP_Y) }));
    });
    y += tallest * (NODE_H + GAP_Y) + GAP_Y;
  });
  return steps.map((s) => ({ ...s, position: pos.get(s.id) ?? s.position }));
}

// ---------------------------------------------------------------- new plans and copies

export function newId(prefix: string): string {
  const rand = globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`;
  return `${prefix}_${rand.replace(/-/g, "").slice(0, 12)}`;
}

/** The first working moment from the start of `day` (that day's 08:00 when it is a working day). */
export function defaultStart(day: string, hours: WorkHours = DEFAULT_HOURS): string {
  return formatStamp(normalizeStart(parseStamp(`${day}T00:00`), hours));
}

export function blankDoc(today: string): WorkflowDoc {
  return { version: 2, description: "", start: defaultStart(today), hours: { ...DEFAULT_HOURS }, roles: [], steps: [], edges: [], clonedFrom: null };
}

/** A copy for another feature: same steps, roles and lengths; statuses and confirmations start over. */
export function cloneDoc(doc: WorkflowDoc, source: { name: string }, start: string): WorkflowDoc {
  const copy = structuredClone(doc);
  return {
    ...copy,
    start: isStamp(start) ? start : doc.start,
    // a new feature: statuses start over and every timeline needs confirming again
    steps: copy.steps.map((s) => ({ ...s, status: "todo", confirmed: null })),
    clonedFrom: { name: source.name.slice(0, LIMITS.name) },
  };
}

// ---------------------------------------------------------------- merging concurrent edits

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** Three-way merge of records with ids: fields changed here win over the remote ones. */
function mergeById<T extends { id: string }>(base: T[], local: T[], remote: T[]): T[] {
  const b = new Map(base.map((x) => [x.id, x]));
  const l = new Map(local.map((x) => [x.id, x]));
  const out: T[] = [];
  for (const r of remote) {
    const was = b.get(r.id);
    const mine = l.get(r.id);
    if (was && !mine) continue; // deleted here
    if (!was || !mine) {
      out.push(r);
      continue;
    }
    const merged = { ...r };
    for (const key of Object.keys(mine) as (keyof T)[]) if (!same(mine[key], was[key])) merged[key] = mine[key];
    out.push(merged);
  }
  const remoteIds = new Set(remote.map((x) => x.id));
  for (const mine of local) if (!b.has(mine.id) && !remoteIds.has(mine.id)) out.push(mine); // added here
  return out;
}

/**
 * Merges this editor's unsaved changes (base → local) into the version someone else saved
 * (remote). Changed fields win over the remote ones; deletions on either side stick.
 */
export function mergeDocs(base: WorkflowDoc, local: WorkflowDoc, remote: WorkflowDoc): WorkflowDoc {
  const pick = <K extends keyof WorkflowDoc>(k: K) => (same(local[k], base[k]) ? remote[k] : local[k]);
  const roles = mergeById(base.roles, local.roles, remote.roles);
  const roleIds = new Set(roles.map((r) => r.id));
  const steps = mergeById(base.steps, local.steps, remote.steps).map((s) => ({ ...s, picIds: s.picIds.filter((id) => roleIds.has(id)) }));
  const stepIds = new Set(steps.map((s) => s.id));
  const edges: WorkflowEdge[] = [];
  for (const e of mergeById(base.edges, local.edges, remote.edges)) {
    if (!stepIds.has(e.source) || !stepIds.has(e.target)) continue;
    if (edges.some((x) => x.source === e.source && x.target === e.target) || wouldCreateCycle(edges, e.source, e.target)) continue;
    edges.push(e);
  }
  return { ...remote, description: pick("description"), start: pick("start"), hours: pick("hours"), clonedFrom: pick("clonedFrom"), roles, steps, edges };
}

// ---------------------------------------------------------------- validation

const str = (v: unknown, max: number, fallback = "") => (typeof v === "string" ? v.slice(0, max) : fallback);
const num = (v: unknown, fallback: number) => (typeof v === "number" && Number.isFinite(v) ? v : fallback);
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

export function isId(value: unknown): value is string {
  return typeof value === "string" && ID_RE.test(value);
}

export function parseDuration(v: unknown): Duration {
  const o = (v ?? {}) as Record<string, unknown>;
  return { amount: clampAmount(num(o.amount, 1)), unit: o.unit === "h" ? "h" : "d" };
}

export function parseHours(v: unknown): WorkHours {
  const o = (v ?? {}) as Record<string, unknown>;
  const hasBreak = isHm(o.breakStart) && isHm(o.breakEnd);
  const hours: WorkHours = {
    skipWeekends: o.skipWeekends !== false,
    dayStart: isHm(o.dayStart) ? o.dayStart : DEFAULT_HOURS.dayStart,
    dayEnd: isHm(o.dayEnd) ? o.dayEnd : DEFAULT_HOURS.dayEnd,
    breakStart: hasBreak ? (o.breakStart as string) : null,
    breakEnd: hasBreak ? (o.breakEnd as string) : null,
  };
  // at least one working hour a day, else the defaults
  return hm(hours.dayEnd) > hm(hours.dayStart) && minutesPerDay(hours) >= 60 ? hours : { ...DEFAULT_HOURS };
}

function parseConfirmed(v: unknown): WorkflowStep["confirmed"] {
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  return { at: str(o.at, 40), by: str(o.by, LIMITS.person), role: str(o.role, LIMITS.person) };
}

export function isConfirmed(step: Pick<WorkflowStep, "confirmed">): boolean {
  return step.confirmed !== null;
}

/** Turns an untrusted document into a valid one, dropping what does not fit; null when it is not a plan. */
export function parseDoc(input: unknown, today: string): WorkflowDoc | null {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const raw = input as Record<string, unknown>;
  if (!Array.isArray(raw.steps)) return null;

  const roles: WorkflowRole[] = [];
  for (const r of Array.isArray(raw.roles) ? raw.roles.slice(0, LIMITS.roles) : []) {
    const o = (r ?? {}) as Record<string, unknown>;
    const name = str(o.name, LIMITS.roleName).trim();
    if (!isId(o.id) || !name || roles.some((x) => x.id === o.id)) continue;
    roles.push({ id: o.id, name, color: ROLE_COLORS.includes(o.color as RoleColor) ? (o.color as RoleColor) : ROLE_COLORS[roles.length % ROLE_COLORS.length] });
  }
  const roleIds = new Set(roles.map((r) => r.id));

  const steps: WorkflowStep[] = [];
  for (const s of raw.steps.slice(0, LIMITS.steps)) {
    const o = (s ?? {}) as Record<string, unknown>;
    if (!isId(o.id) || steps.some((x) => x.id === o.id)) continue;
    const p = (o.position ?? {}) as Record<string, unknown>;
    steps.push({
      id: o.id,
      title: str(o.title, LIMITS.title),
      note: str(o.note, LIMITS.note),
      picIds: Array.isArray(o.picIds) ? [...new Set(o.picIds.filter((x): x is string => typeof x === "string" && roleIds.has(x)))] : [],
      duration: parseDuration(o.duration),
      status: STEP_STATUSES.includes(o.status as StepStatus) ? (o.status as StepStatus) : "todo",
      position: { x: Math.round(num(p.x, 0)), y: Math.round(num(p.y, 0)) },
      confirmed: parseConfirmed(o.confirmed),
    });
  }
  const stepIds = new Set(steps.map((s) => s.id));

  const edges: WorkflowEdge[] = [];
  for (const e of Array.isArray(raw.edges) ? raw.edges.slice(0, LIMITS.edges) : []) {
    const o = (e ?? {}) as Record<string, unknown>;
    const source = str(o.source, 64);
    const target = str(o.target, 64);
    if (!stepIds.has(source) || !stepIds.has(target)) continue;
    if (edges.some((x) => x.source === source && x.target === target) || wouldCreateCycle(edges, source, target)) continue;
    edges.push({ id: isId(o.id) && !edges.some((x) => x.id === o.id) ? o.id : newId("e"), source, target });
  }

  const hours = parseHours(raw.hours);
  const cf = (raw.clonedFrom ?? null) as Record<string, unknown> | null;
  return {
    version: 2,
    description: str(raw.description, LIMITS.note),
    start: isStamp(raw.start) ? raw.start : defaultStart(today, hours),
    hours,
    roles,
    steps,
    edges,
    clonedFrom: cf && typeof cf.name === "string" ? { name: cf.name.slice(0, LIMITS.name) } : null,
  };
}

/** A row of workflow_step_logs as the API returns it, or null when malformed. */
export function parseLog(input: unknown): StepLog | null {
  const o = (input ?? {}) as Record<string, unknown>;
  if (typeof o.id !== "string" || !isId(o.step_id) || (o.kind !== "extend" && o.kind !== "duration" && o.kind !== "confirm")) return null;
  const unit = (v: unknown): DurationUnit | null => (v === "h" || v === "d" ? v : null);
  if (!unit(o.unit) || typeof o.amount !== "number") return null;
  return {
    id: o.id,
    stepId: o.step_id,
    kind: o.kind,
    amount: o.amount,
    unit: unit(o.unit)!,
    oldAmount: typeof o.old_amount === "number" ? o.old_amount : null,
    oldUnit: unit(o.old_unit),
    reason: typeof o.reason === "string" ? o.reason : null,
    requesterName: str(o.requester_name, LIMITS.person),
    requesterRole: str(o.requester_role, LIMITS.person),
    signedIn: o.signed_in === true,
    createdAt: str(o.created_at, 40),
    cancelledAt: typeof o.cancelled_at === "string" ? o.cancelled_at : null,
  };
}
