"use client";

import { useEffect } from "react";
import { AlertTriangle, RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button";

export default function DashboardError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <div className="mx-auto flex max-w-md flex-col items-center rounded-3xl border bg-card/80 px-6 py-14 text-center shadow-xl backdrop-blur">
      <div className="mb-4 flex h-12 w-12 items-center justify-center rounded-2xl bg-destructive/10 text-destructive">
        <AlertTriangle className="h-6 w-6" />
      </div>
      <h2 className="text-lg font-semibold">Something went wrong</h2>
      <p className="mt-1 text-sm text-muted-foreground">
        This page failed to load. Please try again.
      </p>
      <Button variant="brand" className="mt-6 gap-2" onClick={reset}>
        <RotateCcw className="h-4 w-4" />
        Try again
      </Button>
    </div>
  );
}
