import "server-only";

// Lesson store backed by Supabase (migration 202608280023_agent_lessons.sql).
// Runs with the user's session; the SQL functions decide which lessons a user
// sees (their own, and lessons shared after enough users confirmed them).
// If the migration is missing, learning is silently disabled.

import type { Lesson, LessonStore } from "@ai-pro/agent-core";
import type { SupabaseClient } from "@supabase/supabase-js";

type Row = { id: string; phrase: string; canonical: string; scope: string; approved: boolean };

const toLesson = (r: Row): Lesson => ({
  id: r.id,
  phrase: r.phrase,
  canonical: r.canonical,
  scope: r.scope === "mine" ? "mine" : "global",
  approved: Boolean(r.approved),
});

/** Lessons change rarely: cache each user's list briefly on this instance. */
const CACHE_MS = 30_000;
const cache = new Map<string, { at: number; lessons: Lesson[] }>();

export function createLessonStore(supabase: SupabaseClient, userId: string): LessonStore {
  const invalidate = () => cache.delete(userId);
  return {
    async list() {
      const hit = cache.get(userId);
      if (hit && Date.now() - hit.at < CACHE_MS) return hit.lessons;
      const { data, error } = await supabase.rpc("agent_lessons_for_me");
      if (error) return [];
      const lessons = ((data ?? []) as Row[]).map(toLesson);
      if (cache.size > 5000) cache.clear();
      cache.set(userId, { at: Date.now(), lessons });
      return lessons;
    },
    async teach(input) {
      const { data, error } = await supabase.rpc("agent_teach", {
        p_phrase: input.phrase,
        p_canonical: input.canonical,
        p_effect: input.effect,
        p_generic: input.generic,
        p_source: input.source,
      });
      invalidate();
      if (error) return null;
      const row = ((data ?? []) as Row[])[0];
      return row ? toLesson(row) : null;
    },
    async vote(ids, vote) {
      if (ids.length) await supabase.rpc("agent_vote", { p_ids: ids.slice(0, 10), p_vote: vote });
      invalidate();
    },
    async forget(id) {
      await supabase.rpc("agent_forget_lesson", { p_id: id });
      invalidate();
    },
  };
}
