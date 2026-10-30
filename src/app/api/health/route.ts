import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

/** a hanging database must not hang the probe */
const DB_TIMEOUT_MS = 5000;

type DbStatus = "ok" | "error";

/**
 * Asks PostgREST for a head-only count. Rows hidden by RLS (no session) still
 * answer "ok"; only a network, timeout or PostgREST error is "error".
 */
async function checkDb(): Promise<DbStatus> {
  try {
    const supabase = await createClient();
    const { error } = await supabase
      .from("user_profiles")
      .select("id", { head: true, count: "exact" })
      .limit(1)
      .abortSignal(AbortSignal.timeout(DB_TIMEOUT_MS));
    if (!error) return "ok";
    console.error("health db check failed", error.code || "error");
  } catch {
    console.error("health db check failed", "unreachable");
  }
  return "error";
}

/**
 * GET /api/health — liveness and database reachability for uptime monitors
 * and deploy checks. Reveals no configuration or error details.
 */
export async function GET() {
  const db = await checkDb();
  const ok = db === "ok";
  return NextResponse.json(
    { ok, time: new Date().toISOString(), db },
    { status: ok ? 200 : 503, headers: { "Cache-Control": "no-store" } },
  );
}
