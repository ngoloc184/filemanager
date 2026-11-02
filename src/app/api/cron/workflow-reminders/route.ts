import { NextResponse, type NextRequest } from "next/server";
import { isCronAuthorized } from "@/lib/cron-auth";
import { isMailConfigured } from "@/lib/workflow/mailer";
import { appOrigin, runDailyReminders } from "@/lib/workflow/reminders-server";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const json = (body: Record<string, unknown>, status = 200) => NextResponse.json(body, { status, headers: { "Cache-Control": "no-store" } });

/**
 * GET|POST /api/cron/workflow-reminders — the daily workflow e-mails, called by Vercel Cron
 * (GET with `Authorization: Bearer $CRON_SECRET`) or another scheduler (`x-cron-secret`): steps
 * starting on the next working day, due today, or overdue and not done, to the addresses of their
 * PIC roles. Each step, kind and day is mailed once, so a retry sends nothing twice. Returns counts.
 */
async function handle(request: NextRequest) {
  if (!isCronAuthorized(request.headers, process.env.CRON_SECRET)) return json({ error: "Unauthorized" }, 401);
  if (!isMailConfigured()) return json({ error: "Mail is not configured" }, 503);
  try {
    const result = await runDailyReminders(appOrigin(request.nextUrl.origin));
    console.info(JSON.stringify({ event: "cron.workflow_reminders", ...result }));
    return json(result);
  } catch (error) {
    console.error("cron workflow-reminders failed", error instanceof Error ? error.name : "error");
    return json({ error: "Reminders failed" }, 500);
  }
}

export const GET = handle;
export const POST = handle;
