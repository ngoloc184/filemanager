"use client";

import { useEffect, useState } from "react";
import {
  QUOTA_CHANGED_EVENT,
  getStorageQuota,
  type StorageQuota,
} from "@/lib/services/quota";
import { cn, formatBytes } from "@/lib/utils";

export default function StorageUsage() {
  const [quota, setQuota] = useState<StorageQuota | null>(null);

  useEffect(() => {
    let cancelled = false;

    const load = () => {
      getStorageQuota()
        .then((data) => {
          if (!cancelled) setQuota(data);
        })
        .catch(() => {
          if (!cancelled) setQuota(null);
        });
    };

    load();
    window.addEventListener(QUOTA_CHANGED_EVENT, load);
    return () => {
      cancelled = true;
      window.removeEventListener(QUOTA_CHANGED_EVENT, load);
    };
  }, []);

  if (!quota || quota.quota_bytes <= 0) return null;

  const percent = Math.min(
    100,
    Math.round((quota.used_bytes / quota.quota_bytes) * 100)
  );
  const barClass =
    percent >= 95
      ? "bg-destructive"
      : percent >= 80
        ? "bg-amber-500"
        : "bg-primary";

  return (
    <div className="px-3 py-2" aria-label="Storage usage">
      <div className="flex items-center justify-between text-xs text-muted-foreground mb-1">
        <span>Storage</span>
        <span>{percent}%</span>
      </div>
      <div className="h-1.5 rounded-full bg-muted overflow-hidden">
        <div
          className={cn("h-full rounded-full transition-all", barClass)}
          style={{ width: `${percent}%` }}
        />
      </div>
      <p className="text-xs text-muted-foreground mt-1">
        {formatBytes(quota.used_bytes)} of {formatBytes(quota.quota_bytes)} used
      </p>
    </div>
  );
}
