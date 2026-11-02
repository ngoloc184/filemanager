import { NextResponse, type NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  BAN_DURATION,
  parseOffboardRequest,
  type OffboardResponse,
  type OffboardingResult,
} from "@/lib/offboarding";

export const dynamic = "force-dynamic";

const json = (body: OffboardResponse, status = 200) =>
  NextResponse.json(body, { status, headers: { "Cache-Control": "no-store" } });

/** SQLSTATEs raised on purpose by offboard_member; their messages are safe to show. */
const STATUS_BY_CODE: Record<string, number> = {
  "42501": 403, // not signed in / not an admin of the person's company
  "22023": 400, // bad choice (yourself, same person, inactive successor)
  P0002: 404, // member not found
  "23514": 409, // the company would have no admin
};

/**
 * POST /api/org/offboard {userId, successorId, blockSignIn}
 *
 * Hands the leaver's files, groups and document work to the successor and
 * marks them 'left' (rpc offboard_member, run as the caller so the admin
 * check happens in SQL). Only after that succeeds, and only when
 * blockSignIn is true, the account is banned and its sessions revoked with
 * the service role. The account is global, so the ban blocks the whole app.
 */
export async function POST(request: NextRequest) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return json({ error: "Unauthorized" }, 401);

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return json({ error: "Invalid request" }, 400);
  }
  const input = parseOffboardRequest(body);
  if ("error" in input) return json({ error: input.error }, 400);
  if (input.userId === user.id) return json({ error: "You cannot offboard yourself" }, 400);

  const { data, error } = await supabase.rpc("offboard_member", {
    p_user_id: input.userId,
    p_successor: input.successorId,
  });
  if (error) {
    const status = STATUS_BY_CODE[error.code ?? ""];
    if (status) return json({ error: error.message }, status);
    console.error("offboard_member failed", error.code, error.message);
    return json({ error: "Could not offboard this member. Please try again." }, 500);
  }
  const counts = data as OffboardingResult;

  if (!input.blockSignIn) return json({ ok: true, counts, banned: false });

  let banned = false;
  let warning: string | undefined;
  try {
    const admin = createAdminClient();
    const ban = await admin.auth.admin.updateUserById(input.userId, { ban_duration: BAN_DURATION });
    if (ban.error) {
      console.error("offboard: ban failed", ban.error.message);
      warning = "The work was handed over, but sign-in could not be blocked. Block the account in Supabase.";
    } else {
      banned = true;
      // a banned account cannot refresh; also end the sessions it has now
      const revoked = await admin.rpc("revoke_user_sessions", { p_user_id: input.userId });
      if (revoked.error || revoked.data === null) {
        warning = "Sign-in is blocked. Sessions already open end when their access token expires.";
      }
    }
  } catch (err) {
    console.error("offboard: admin client unavailable", err instanceof Error ? err.message : err);
    warning = "The work was handed over, but sign-in could not be blocked on this server. Block the account in Supabase.";
  }
  return json({ ok: true, counts, banned, ...(warning ? { warning } : {}) });
}
