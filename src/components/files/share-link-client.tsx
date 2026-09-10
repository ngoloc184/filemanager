"use client";

import { useEffect, useState } from "react";
import { Download, FileText, Loader2, AlertCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
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
        const res = await fetch(`/api/public-share/${token}/info`);
        const data = await res.json();
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
    <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-gray-50 to-gray-100 px-4">
      <Card className="w-full max-w-md shadow-lg">
        <CardHeader className="text-center space-y-2">
          <div className="mx-auto w-12 h-12 bg-primary rounded-xl flex items-center justify-center">
            {error ? (
              <AlertCircle className="h-6 w-6 text-destructive-foreground" />
            ) : (
              <FileText className="h-6 w-6 text-primary-foreground" />
            )}
          </div>
          <CardTitle className="text-xl font-bold truncate">
            {meta?.name || "Shared file"}
          </CardTitle>
          <CardDescription>
            {error ? "Unable to load file" : "This file has been shared publicly with you"}
          </CardDescription>
        </CardHeader>
        <CardContent>
          {loading ? (
            <div className="flex justify-center py-6">
              <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
            </div>
          ) : error ? (
            <div className="text-center space-y-3 py-2">
              <p className="text-sm text-destructive font-medium">{error}</p>
            </div>
          ) : (
            <div className="space-y-4">
              {meta && (
                <div className="bg-muted/50 rounded-lg p-3 text-sm space-y-1">
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Size:</span>
                    <span className="font-medium">{formatBytes(meta.size)}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Type:</span>
                    <span className="font-medium truncate max-w-[200px]">{meta.mimeType}</span>
                  </div>
                </div>
              )}
              <p className="text-xs text-muted-foreground text-center">
                No sign-in is required to download this file.
              </p>
              <Button className="w-full" render={<a href={`/api/public-share/${token}`} />}>
                <Download className="h-4 w-4 mr-2" />
                Download file
              </Button>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

