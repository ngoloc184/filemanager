import "server-only";

// Server-side adapters for the assistant: memory persistence, telemetry,
// tuning and the model budget. All queries run with the signed-in user's
// session (RLS), never with the service role.

import type { SupabaseClient } from "@supabase/supabase-js";
import type { MemoryInput, MemoryItem, MemoryStore } from "./memory.ts";
import { DEFAULT_TUNING, mergeTuning, type Tuning } from "./tuning.ts";
import type { AssistantMeta } from "./types.ts";

type MemoryRow = {
  id: string;
  kind: MemoryItem["kind"];
  key: string | null;
  value: string;
  source: MemoryItem["source"];
  created_at: string;
  updated_at: string;
  expires_at: string | null;
};

const toItem = (r: MemoryRow): MemoryItem => ({
  id: r.id,
  kind: r.kind,
  key: r.key,
  value: r.value,
  source: r.source,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
  expiresAt: r.expires_at,
});

const COLUMNS = "id, kind, key, value, source, created_at, updated_at, expires_at";

export function createMemoryStore(supabase: SupabaseClient): MemoryStore {
  return {
    async list() {
      const { data, error } = await supabase
        .from("assistant_memories")
        .select(COLUMNS)
        .or(`expires_at.is.null,expires_at.gt.${new Date().toISOString()}`)
        .order("created_at", { ascending: true })
        .limit(100);
      if (error) throw error;
      return ((data ?? []) as MemoryRow[]).map(toItem);
    },
    async save(input: MemoryInput) {
      if (input.key !== null) {
        const { data: existing } = await supabase
          .from("assistant_memories")
          .select("id")
          .eq("kind", input.kind)
          .eq("key", input.key)
          .maybeSingle();
        if (existing) {
          const { data, error } = await supabase
            .from("assistant_memories")
            .update({ value: input.value, source: input.source, expires_at: input.expiresAt ?? null })
            .eq("id", (existing as { id: string }).id)
            .select(COLUMNS)
            .single();
          if (error) throw error;
          return toItem(data as MemoryRow);
        }
      }
      const { data, error } = await supabase
        .from("assistant_memories")
        .insert({ kind: input.kind, key: input.key, value: input.value, source: input.source, expires_at: input.expiresAt ?? null })
        .select(COLUMNS)
        .single();
      if (error) throw error;
      return toItem(data as MemoryRow);
    },
    async remove(ids: string[]) {
      if (!ids.length) return 0;
      const { data, error } = await supabase.from("assistant_memories").delete().in("id", ids).select("id");
      if (error) throw error;
      return (data ?? []).length;
    },
  };
}

/** Missing tables (migration not applied yet) must never break the chat. */
export async function optional<T>(work: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await work();
  } catch {
    return fallback;
  }
}

let tuningCache: { at: number; value: Tuning } | null = null;

export async function loadTuning(supabase: SupabaseClient): Promise<Tuning> {
  if (tuningCache && Date.now() - tuningCache.at < 60_000) return tuningCache.value;
  const value = await optional(async () => {
    const { data, error } = await supabase.from("assistant_tuning").select("version, config").eq("active", true).maybeSingle();
    if (error || !data) return DEFAULT_TUNING;
    const row = data as { version: string; config: Record<string, unknown> };
    return mergeTuning({ ...row.config, version: row.version });
  }, DEFAULT_TUNING);
  tuningCache = { at: Date.now(), value };
  return value;
}

/** Logs one answer (metadata only, no question or content); returns its id. */
export async function logEvent(
  supabase: SupabaseClient,
  event: { intent: string; meta?: AssistantMeta; latencyMs: number; errorCode?: string | null }
): Promise<string | null> {
  return optional(async () => {
    const m = event.meta;
    const { data, error } = await supabase
      .from("assistant_events")
      .insert({
        intent: event.intent.slice(0, 40),
        method: m?.method.slice(0, 40) ?? null,
        result_count: Math.min(m?.resultCount ?? 0, 1000),
        grounded: m?.grounded ?? null,
        confidence: m?.confidence ?? null,
        latency_ms: Math.min(Math.round(event.latencyMs), 600_000),
        llm_calls: Math.min(m?.llmCalls ?? 0, 50),
        tokens_est: Math.min(m?.tokensEst ?? 0, 1_000_000),
        tuning_version: m?.tuningVersion.slice(0, 40) ?? null,
        error_code: event.errorCode?.slice(0, 40) ?? null,
      })
      .select("id")
      .single();
    if (error) return null;
    return (data as { id: string }).id;
  }, null);
}

/** Estimated model tokens this user consumed today (UTC). */
export async function tokensUsedToday(supabase: SupabaseClient): Promise<number> {
  return optional(async () => {
    const since = new Date();
    since.setUTCHours(0, 0, 0, 0);
    const { data, error } = await supabase
      .from("assistant_events")
      .select("tokens_est")
      .gte("created_at", since.toISOString())
      .gt("tokens_est", 0)
      .limit(1000);
    if (error) return 0;
    return ((data ?? []) as { tokens_est: number }[]).reduce((s, r) => s + Number(r.tokens_est), 0);
  }, 0);
}

export function dailyTokenBudget(): number {
  const v = Number(process.env.ASSISTANT_LLM_DAILY_TOKENS ?? 50_000);
  return Number.isFinite(v) && v >= 0 ? v : 50_000;
}
