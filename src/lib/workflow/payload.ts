import { parseDoc, parseLog, todayDay, type StepLog, type WorkflowDoc } from "./model.ts";

/** A plan as /api/workflows/[id] (and the page) hands it over, before validation. */
export interface Payload {
  id: string;
  name: string;
  revision: number;
  doc: unknown;
  logs: unknown[];
}

export interface Loaded {
  snap: { name: string; doc: WorkflowDoc };
  revision: number;
  logs: StepLog[];
}

/** Validates a payload; null when its document is not a plan. */
export function readPayload(p: Payload): Loaded | null {
  const doc = parseDoc(p.doc, todayDay());
  if (!doc) return null;
  return { snap: { name: p.name, doc }, revision: p.revision, logs: p.logs.map(parseLog).filter((l): l is StepLog => l !== null) };
}
