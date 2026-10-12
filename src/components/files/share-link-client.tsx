"use client";

import { useEffect, useState } from "react";
import { Download, FileText, Loader2, AlertCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { AuthShell } from "@/components/auth/auth-shell";
import { formatBytes } from "@/lib/utils";

type FileMeta = {
  name: string;
  size: number;
  mimeType: string;
  requiresPassword: boolean;
};

export default function ShareLinkClient({ token }: { token: string }) {
  const [meta, setMeta] = useState<FileMeta | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function fetchInfo() {
      try {
        const res = await fetch(
          `/api/public-share/${encodeURIComponent(token)}/info`,
          { cache: "no-store" }
        );
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
          throw new Error(data.error || "File is not available");
        }
        if (!cancelled) {
          setMeta(data);
        }
      } catch (err: unknown) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : "Failed to load file information");
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    void fetchInfo();
    return () => {
      cancelled = true;
    };
  }, [token]);

  return (
    <AuthShell
      icon={error ? <AlertCircle className="h-5 w-5" /> : <FileText className="h-5 w-5" />}
      title={<span className="block truncate">{meta?.name || "Shared file"}</span>}
      description={
        error ? "Unable to load file" : "This file has been shared publicly with you"
      }
    >
      {loading ? (
        <div className="flex justify-center py-6">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </div>
      ) : error ? (
        <p className="py-2 text-center text-sm font-medium text-destructive">{error}</p>
      ) : (
        <div className="space-y-4">
          {meta && (
            <div className="space-y-1 rounded-xl border bg-muted/40 p-3 text-sm">
              <div className="flex justify-between">
                <span className="text-muted-foreground">Size</span>
                <span className="font-medium">{formatBytes(meta.size)}</span>
              </div>
              <div className="flex justify-between gap-4">
                <span className="text-muted-foreground">Type</span>
                <span className="max-w-[200px] truncate font-medium">{meta.mimeType}</span>
              </div>
            </div>
          )}
          <p className="text-center text-xs text-muted-foreground">
            No sign-in is required to download this file.
          </p>
          <Button
            variant="brand"
            className="h-10 w-full"
            render={<a href={`/api/public-share/${encodeURIComponent(token)}`} />}
          >
            <Download className="h-4 w-4" />
            Download file
          </Button>
        </div>
      )}
    </AuthShell>
  );
}
