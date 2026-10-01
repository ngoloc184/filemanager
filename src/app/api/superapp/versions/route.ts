import { createSupabaseVersionStore } from "@/lib/superapp-version-store";
import { listMiniAppVersions } from "@/lib/superapp-versions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Public: latest version of every mini-app, never cached. */
export async function GET() {
  return listMiniAppVersions(createSupabaseVersionStore());
}
