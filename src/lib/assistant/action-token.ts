// Signed, short-lived confirmation tokens for assistant actions (server only).
// The token binds the exact action to the user who saw it; the action route
// rejects tokens of other users, expired tokens and tampered payloads.

import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { validateSpec, type ActionSpec } from "./actions.ts";

export const ACTION_TTL_MS = 10 * 60_000;

function secret(): Buffer | null {
  const explicit = process.env.ASSISTANT_ACTION_SECRET;
  if (explicit && explicit.length >= 16) return Buffer.from(explicit);
  const service = process.env.SUPABASE_SERVICE_ROLE_KEY;
  // Derived key: the service key itself is never used or exposed directly.
  return service ? createHash("sha256").update(`assistant-action:v1:${service}`).digest() : null;
}

export function actionsConfigured(): boolean {
  return secret() !== null;
}

const b64 = (b: Buffer | string) => Buffer.from(b).toString("base64url");

export function signAction(userId: string, spec: ActionSpec, now = Date.now(), key: Buffer | null = secret()): string {
  if (!key) throw new Error("actions not configured");
  const payload = b64(JSON.stringify({ u: userId, s: spec, e: now + ACTION_TTL_MS, n: randomBytes(9).toString("base64url") }));
  const sig = createHmac("sha256", key).update(payload).digest("base64url");
  return `${payload}.${sig}`;
}

export type VerifyResult = { ok: true; spec: ActionSpec; nonce: string } | { ok: false; reason: "invalid" | "expired" | "user" };

export function verifyAction(token: string, userId: string, now = Date.now(), key: Buffer | null = secret()): VerifyResult {
  if (!key || typeof token !== "string" || token.length > 8000) return { ok: false, reason: "invalid" };
  const [payload, sig] = token.split(".");
  if (!payload || !sig) return { ok: false, reason: "invalid" };
  const expected = createHmac("sha256", key).update(payload).digest();
  const given = Buffer.from(sig, "base64url");
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return { ok: false, reason: "invalid" };
  let data: { u?: unknown; s?: unknown; e?: unknown; n?: unknown };
  try {
    data = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    return { ok: false, reason: "invalid" };
  }
  if (data.u !== userId) return { ok: false, reason: "user" };
  if (typeof data.e !== "number" || data.e < now) return { ok: false, reason: "expired" };
  const spec = validateSpec(data.s);
  return spec && typeof data.n === "string" ? { ok: true, spec, nonce: data.n } : { ok: false, reason: "invalid" };
}

// ------------------------------------------------------------- context seal
// The conversation context travels through the browser. It is signed and
// bound to the user so a modified or another user's context is discarded
// (the engine then re-checks every id itself).

export function sealContext(userId: string, context: object, key: Buffer | null = secret()): object {
  if (!key) return context;
  const body = JSON.stringify(context);
  return { ...context, sig: createHmac("sha256", key).update(`${userId}:${body}`).digest("base64url") };
}

/** The context without its signature, and whether the signature was valid. */
export function openContext(userId: string, raw: unknown, key: Buffer | null = secret()): { context: unknown; trusted: boolean } {
  if (!raw || typeof raw !== "object") return { context: raw, trusted: false };
  const { sig, ...context } = raw as Record<string, unknown>;
  if (!key || typeof sig !== "string") return { context, trusted: false };
  const expected = createHmac("sha256", key).update(`${userId}:${JSON.stringify(context)}`).digest();
  const given = Buffer.from(sig, "base64url");
  return { context, trusted: given.length === expected.length && timingSafeEqual(given, expected) };
}
