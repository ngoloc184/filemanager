"use client";

import { useCallback, useEffect, useLayoutEffect, useReducer, useRef, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { mergeDocs, type DurationUnit, type WorkflowDoc } from "@/lib/workflow/model";
import { readPayload, type Loaded, type Payload } from "@/lib/workflow/payload";

// Editors save the whole document with the revision they started from. When someone else saved
// in between (another editor, or a length change from the public page) the save changes nothing;
// the hook then loads their version, merges this editor's unsaved changes into it and saves again.
// Viewers never write the document; their extensions and length changes go through the API.

const SAVE_DELAY_MS = 800;
const POLL_MS = 15_000;
const HISTORY_MAX = 100;
/** Edits with the same key inside this window become one undo step (typing, dragging). */
const COALESCE_MS = 900;

export type SaveStatus = "saved" | "pending" | "saving" | "error";

interface Snapshot {
  name: string;
  doc: WorkflowDoc;
}

interface State extends Snapshot {
  past: Snapshot[];
  future: Snapshot[];
  lastKey: string | null;
  lastAt: number;
}

type Action =
  | { type: "edit"; fn: (s: Snapshot) => Snapshot; key: string | null; at: number }
  | { type: "replace"; snap: Snapshot; keepHistory: boolean }
  | { type: "undo" }
  | { type: "redo" };

function reducer(state: State, action: Action): State {
  const current = { name: state.name, doc: state.doc };
  switch (action.type) {
    case "edit": {
      const next = action.fn(current);
      if (next.name === state.name && next.doc === state.doc) return state;
      const merge = action.key !== null && action.key === state.lastKey && action.at - state.lastAt < COALESCE_MS;
      return { ...next, past: merge ? state.past : [...state.past, current].slice(-HISTORY_MAX), future: [], lastKey: action.key, lastAt: action.at };
    }
    case "replace":
      return action.keepHistory ? { ...state, ...action.snap, lastKey: null } : { ...action.snap, past: [], future: [], lastKey: null, lastAt: 0 };
    case "undo": {
      const prev = state.past.at(-1);
      return prev ? { ...prev, past: state.past.slice(0, -1), future: [current, ...state.future], lastKey: null, lastAt: 0 } : state;
    }
    case "redo": {
      const next = state.future[0];
      return next ? { ...next, past: [...state.past, current], future: state.future.slice(1), lastKey: null, lastAt: 0 } : state;
    }
  }
}

export interface ChangeInput {
  kind: "extend" | "duration";
  stepId: string;
  amount: number;
  unit: DurationUnit;
  reason: string;
  name: string;
  role: string;
  /** a field people leave empty (bots fill it) */
  website?: string;
}

async function fetchPayload(id: string): Promise<Payload | null> {
  const res = await fetch(`/api/workflows/${id}`, { cache: "no-store" });
  return res.ok ? ((await res.json()) as Payload) : null;
}

export function useWorkflowSync(id: string, initial: Loaded, canEdit: boolean) {
  const [state, dispatch] = useReducer(reducer, { ...initial.snap, past: [], future: [], lastKey: null, lastAt: 0 });
  const [logs, setLogs] = useState(initial.logs);
  const [status, setStatus] = useState<SaveStatus>("saved");
  const [gone, setGone] = useState(false);
  const revision = useRef(initial.revision);
  // the last version known to be on the server: a ref for the save loop, state for rendering
  const base = useRef<Snapshot>(initial.snap);
  const [saved, setSaved] = useState<Snapshot>(initial.snap);
  const setBase = useCallback((snap: Snapshot) => {
    base.current = snap;
    setSaved(snap);
  }, []);
  const latest = useRef<Snapshot>(initial.snap);
  const saving = useRef(false);
  useLayoutEffect(() => {
    latest.current = { name: state.name, doc: state.doc };
  }, [state.name, state.doc]);
  const dirty = state.name !== saved.name || state.doc !== saved.doc;

  const save = useCallback(async () => {
    if (saving.current || !canEdit) return;
    saving.current = true;
    setStatus("saving");
    const supabase = createClient();
    try {
      for (let attempt = 0; attempt < 4; attempt++) {
        const snap = latest.current;
        if (snap.name === base.current.name && snap.doc === base.current.doc) break;
        const { data, error } = await supabase
          .from("workflows")
          .update({ name: snap.name.trim() || "Workflow", doc: snap.doc })
          .eq("id", id)
          .eq("revision", revision.current)
          .select("revision")
          .maybeSingle();
        if (error) throw error;
        if (data) {
          revision.current = data.revision;
          setBase(snap);
          continue; // more edits may have arrived while saving
        }
        // someone saved first: merge my unsaved changes into their version
        const remote = await fetchPayload(id);
        if (!remote) {
          setGone(true);
          break;
        }
        const read = readPayload(remote);
        if (!read) throw new Error("bad document");
        const mine = latest.current;
        const merged: Snapshot = {
          name: mine.name !== base.current.name ? mine.name : read.snap.name,
          doc: mergeDocs(base.current.doc, mine.doc, read.snap.doc),
        };
        setBase(read.snap);
        revision.current = read.revision;
        setLogs(read.logs);
        dispatch({ type: "replace", snap: merged, keepHistory: true });
        latest.current = merged;
      }
      const now = latest.current;
      setStatus(now.name === base.current.name && now.doc === base.current.doc ? "saved" : "pending");
    } catch {
      setStatus("error");
    } finally {
      saving.current = false;
    }
  }, [id, canEdit, setBase]);

  // autosave shortly after the last edit
  useEffect(() => {
    if (!canEdit || !dirty) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- shows "unsaved" right away; the save runs later
    setStatus((s) => (s === "saving" ? s : "pending"));
    const t = setTimeout(() => void save(), SAVE_DELAY_MS);
    return () => clearTimeout(t);
  }, [state.name, state.doc, canEdit, dirty, save]);

  /** Loads the latest version when nothing is waiting to be saved. */
  const refresh = useCallback(async () => {
    const remote = await fetchPayload(id).catch(() => null);
    if (!remote) return;
    const read = readPayload(remote);
    if (!read) return;
    setLogs(read.logs);
    const mine = latest.current;
    if (saving.current || mine.name !== base.current.name || mine.doc !== base.current.doc) return;
    if (read.revision !== revision.current) {
      revision.current = read.revision;
      setBase(read.snap);
      latest.current = read.snap;
      dispatch({ type: "replace", snap: read.snap, keepHistory: false });
    }
  }, [id, setBase]);

  useEffect(() => {
    const tick = () => document.visibilityState === "visible" && void refresh();
    const timer = setInterval(tick, POLL_MS);
    document.addEventListener("visibilitychange", tick);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", tick);
    };
  }, [refresh]);

  // leaving with unsaved edits asks first
  useEffect(() => {
    if (!dirty) return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  /** Extends a step or changes its length through the public API (logged with name and role). */
  const submitChange = useCallback(
    async (input: ChangeInput): Promise<string | null> => {
      try {
        const res = await fetch(`/api/workflows/${id}/changes`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(input),
        });
        const body = await res.json().catch(() => null);
        if (!res.ok) return (body as { error?: string } | null)?.error ?? "Không lưu được thay đổi";
        const read = readPayload(body as Payload);
        if (read) {
          setLogs(read.logs);
          const mine = latest.current;
          // an editor's unsaved edits are merged by the next save instead
          if (!saving.current && mine.name === base.current.name && mine.doc === base.current.doc) {
            revision.current = read.revision;
            setBase(read.snap);
            latest.current = read.snap;
            dispatch({ type: "replace", snap: read.snap, keepHistory: canEdit });
          }
        }
        return null;
      } catch {
        return "Mất kết nối, hãy thử lại";
      }
    },
    [id, canEdit, setBase]
  );

  const cancelExtension = useCallback(
    async (logId: string): Promise<boolean> => {
      const { error } = await createClient().rpc("cancel_workflow_extension", { p_log: logId });
      if (!error) await refresh();
      return !error;
    },
    [refresh]
  );

  const edit = useCallback(
    (fn: (doc: WorkflowDoc) => WorkflowDoc, key: string | null = null) =>
      dispatch({ type: "edit", fn: (s) => ({ ...s, doc: fn(s.doc) }), key, at: Date.now() }),
    []
  );
  const rename = useCallback((name: string) => dispatch({ type: "edit", fn: (s) => ({ ...s, name }), key: "name", at: Date.now() }), []);
  const undo = useCallback(() => dispatch({ type: "undo" }), []);
  const redo = useCallback(() => dispatch({ type: "redo" }), []);

  return {
    name: state.name,
    doc: state.doc,
    logs,
    status,
    gone,
    canUndo: canEdit && state.past.length > 0,
    canRedo: canEdit && state.future.length > 0,
    edit,
    rename,
    undo,
    redo,
    save,
    refresh,
    submitChange,
    cancelExtension,
  };
}

export type WorkflowSync = ReturnType<typeof useWorkflowSync>;
