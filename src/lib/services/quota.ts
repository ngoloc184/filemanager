import { createClient } from "@/lib/supabase/client";

export type StorageQuota = {
  used_bytes: number;
  quota_bytes: number;
};

export const QUOTA_CHANGED_EVENT = "storage-quota-changed";

export async function getStorageQuota(): Promise<StorageQuota | null> {
  const supabase = createClient();
  const { data, error } = await supabase.rpc("get_storage_quota").maybeSingle();
  if (error || !data) return null;
  const row = data as {
    used_bytes: number | string | null;
    quota_bytes: number | string | null;
  };
  return {
    used_bytes: Number(row.used_bytes ?? 0),
    quota_bytes: Number(row.quota_bytes ?? 0),
  };
}

export async function assertQuotaForSize(additionalBytes: number): Promise<void> {
  const quota = await getStorageQuota();
  if (!quota) return;
  if (quota.used_bytes + additionalBytes > quota.quota_bytes) {
    throw new Error(
      "Storage quota exceeded. Free up space or empty the trash, then try again."
    );
  }
}

export function notifyQuotaChanged(): void {
  if (typeof window !== "undefined") {
    window.dispatchEvent(new Event(QUOTA_CHANGED_EVENT));
  }
}
