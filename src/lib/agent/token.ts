import "server-only";

// Signed confirmation tokens for agent tools. Same key and lifetime as the
// assistant's action tokens, but a separate HMAC domain ("agent:v1"), so a
// token of one kind can never be replayed as the other.

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { ACTION_TTL_MS, actionSecret } from "../assistant/action-token.ts";

export const AGENT_TOKEN_PREFIX = "ag1.";
const MAX_TOKEN = 32_000;

const b64 = (s: string) => Buffer.from(s).toString("base64url");
const mac = (key: Buffer, payload: string) => createHmac("sha256", key).update(`agent:v1:${payload}`).digest();

export function signAgentAction(
  userId: string,
  tool: string,
  params: Record<string, unknown>,
  now = Date.now(),
  key: Buffer | null = actionSecret()
): string {
  if (!key) throw new Error("actions not configured");
  const payload = b64(JSON.stringify({ u: userId, t: tool, p: params, e: now + ACTION_TTL_MS, n: randomBytes(9).toString("base64url") }));
  return `${AGENT_TOKEN_PREFIX}${payload}.${mac(key, payload).toString("base64url")}`;
}

export type AgentVerify =
  | { ok: true; tool: string; params: Record<string, unknown>; nonce: string }
  | { ok: false; reason: "invalid" | "expired" | "user" };

export function verifyAgentAction(token: string, userId: string, now = Date.now(), key: Buffer | null = actionSecret()): AgentVerify {
  if (!key || typeof token !== "string" || token.length > MAX_TOKEN || !token.startsWith(AGENT_TOKEN_PREFIX)) {
    return { ok: false, reason: "invalid" };
  }
  const [payload, sig] = token.slice(AGENT_TOKEN_PREFIX.length).split(".");
  if (!payload || !sig) return { ok: false, reason: "invalid" };
  const given = Buffer.from(sig, "base64url");
  const expected = mac(key, payload);
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return { ok: false, reason: "invalid" };
  let data: { u?: unknown; t?: unknown; p?: unknown; e?: unknown; n?: unknown };
  try {
    data = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    return { ok: false, reason: "invalid" };
  }
  if (data.u !== userId) return { ok: false, reason: "user" };
  if (typeof data.e !== "number" || data.e < now) return { ok: false, reason: "expired" };
  if (typeof data.t !== "string" || typeof data.n !== "string" || !data.p || typeof data.p !== "object") {
    return { ok: false, reason: "invalid" };
  }
  return { ok: true, tool: data.t, params: data.p as Record<string, unknown>, nonce: data.n };
}
