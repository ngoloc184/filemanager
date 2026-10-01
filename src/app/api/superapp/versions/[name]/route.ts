import { isAuthorizedSuperAppRequest } from "@/lib/superapp";
import { createSupabaseVersionStore } from "@/lib/superapp-version-store";
import { putMiniAppVersion } from "@/lib/superapp-versions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Publishes a newer version (Bearer SUPERAPP_API_KEY, same as uploads). */
export async function PUT(
  request: Request,
  { params }: RouteContext<"/api/superapp/versions/[name]">
) {
  const { name } = await params;
  return putMiniAppVersion(request, name, {
    store: createSupabaseVersionStore(),
    isAuthorized: isAuthorizedSuperAppRequest,
  });
}
