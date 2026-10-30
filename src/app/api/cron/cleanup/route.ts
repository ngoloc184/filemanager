import { NextResponse, type NextRequest } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { isCronAuthorized } from "@/lib/cron-auth";
import { STORAGE_REMOVE_BATCH_SIZE, UPLOADS_BUCKET } from "@/lib/storage";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** trashed items older than this are purged */
const TRASH_RETENTION_DAYS = 30;
/** files purged per run; the next run picks up the rest */
const PURGE_LIMIT = 500;
/** unregistered uploads older than this are removed */
const ORPHAN_MIN_AGE = "24 hours";
const ORPHAN_LIMIT = 500;

const json = (body: Record<string, unknown>, status = 200) =>
  NextResponse.json(body, { status, headers: { "Cache-Control": "no-store" } });

type Admin = ReturnType<typeof createAdminClient>;

/** Removes objects in batches the Storage API accepts; returns how many went. */
async function removeObjects(admin: Admin, paths: string[]): Promise<number> {
  let removed = 0;
  for (let i = 0; i < paths.length; i += STORAGE_REMOVE_BATCH_SIZE) {
    const chunk = paths.slice(i, i + STORAGE_REMOVE_BATCH_SIZE);
    const { data, error } = await admin.storage.from(UPLOADS_BUCKET).remove(chunk);
    if (error) {
      // left for the orphan pass of a later run
      console.warn("cron cleanup: storage remove failed", error.message);
      continue;
    }
    removed += data?.length ?? 0;
  }
  return removed;
}

/**
 * GET|POST /api/cron/cleanup — daily storage hygiene, called by Vercel Cron
 * (GET with `Authorization: Bearer $CRON_SECRET`) or another scheduler
 * (`x-cron-secret`). Hard-deletes items that sat in the trash for 30 days
 * and removes their storage objects, then removes uploads that were never
 * registered (older than 24 hours). Returns only counts.
 */
async function handle(request: NextRequest) {
  if (!isCronAuthorized(request.headers, process.env.CRON_SECRET)) {
    return json({ error: "Unauthorized" }, 401);
  }

  let admin: Admin;
  try {
    admin = createAdminClient();
  } catch {
    return json({ error: "Cleanup is not configured" }, 503);
  }

  const purged = await admin.rpc("purge_old_trash", {
    p_days: TRASH_RETENTION_DAYS,
    p_limit: PURGE_LIMIT,
  });
  if (purged.error) {
    console.error("cron cleanup: purge_old_trash failed", purged.error.code || "error");
    return json({ error: "Trash purge failed" }, 500);
  }
  const purgedRows = (purged.data ?? []) as { file_id: string; storage_path: string | null }[];
  const purgedFiles = new Set(purgedRows.map((row) => row.file_id)).size;
  const purgedPaths = purgedRows
    .map((row) => row.storage_path)
    .filter((path): path is string => Boolean(path));
  const removedObjects = await removeObjects(admin, purgedPaths);

  const orphans = await admin.rpc("storage_orphan_candidates", {
    p_older_than: ORPHAN_MIN_AGE,
    p_limit: ORPHAN_LIMIT,
  });
  let orphansRemoved = 0;
  if (orphans.error) {
    console.error("cron cleanup: storage_orphan_candidates failed", orphans.error.code || "error");
  } else {
    const names = ((orphans.data ?? []) as { name: string }[]).map((row) => row.name);
    orphansRemoved = await removeObjects(admin, names);
  }

  const result = { purgedFiles, removedObjects, orphansRemoved };
  console.info(JSON.stringify({ event: "cron.cleanup", ...result }));
  return json(result);
}

export const GET = handle;
export const POST = handle;
