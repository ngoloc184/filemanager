"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { AlertCircle, CheckCircle2, Clock, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { uploadSticker } from "@/lib/services/stickers-admin";
import { STICKER_MAX_BYTES, stickerNameFromFile, type CustomSticker } from "@/lib/stickers/custom";
import { SKIP_REASONS, checkStickerImage } from "@/lib/stickers/zip-import";
import { getErrorMessage } from "@/lib/types/database";
import { cn } from "@/lib/utils";

/** A picked file (checked when its turn comes) or an image already read from a ZIP. */
export type UploadSource = File | { name: string; keywords: string[]; bytes: Uint8Array; /** shown in the progress list */ label?: string };

export type UploadJob = {
  key: string;
  packId: string;
  label: string;
  status: "waiting" | "uploading" | "done" | "failed";
  error?: string;
};

type Queued = { key: string; packId: string; source: UploadSource };

let nextKey = 0;

async function prepare(source: UploadSource): Promise<{ bytes: Uint8Array; name: string; keywords: string[] }> {
  if (!(source instanceof File)) return { bytes: source.bytes, name: source.name, keywords: source.keywords };
  // a huge file (a video dropped by mistake) is refused before it is read into memory
  if (source.size > STICKER_MAX_BYTES) throw new Error(SKIP_REASONS.size);
  const bytes = new Uint8Array(await source.arrayBuffer());
  const check = checkStickerImage(bytes);
  if (!check.ok) throw new Error(check.reason);
  return { bytes, name: stickerNameFromFile(source.name), keywords: [] };
}

/**
 * Uploads stickers one at a time (so each lands at the end of its pack in the
 * order picked); a failed file is reported and the queue moves on.
 */
export function useUploadQueue(onUploaded: (sticker: CustomSticker) => void) {
  const [jobs, setJobs] = useState<UploadJob[]>([]);
  const queue = useRef<Queued[]>([]);
  const running = useRef(false);
  /** the upload in flight, so deleting its pack can wait for it */
  const current = useRef<{ packId: string; done: Promise<void> } | null>(null);
  const uploaded = useRef(onUploaded);

  useEffect(() => {
    uploaded.current = onUploaded;
  }, [onUploaded]);

  const patch = useCallback((key: string, change: Partial<UploadJob>) => {
    setJobs((list) => list.map((j) => (j.key === key ? { ...j, ...change } : j)));
  }, []);

  const run = useCallback(async () => {
    if (running.current) return;
    running.current = true;
    try {
      for (let job = queue.current.shift(); job; job = queue.current.shift()) {
        const { key, packId, source } = job;
        patch(key, { status: "uploading" });
        const done = (async () => {
          try {
            const sticker = await uploadSticker(packId, await prepare(source));
            patch(key, { status: "done" });
            uploaded.current(sticker);
          } catch (err) {
            patch(key, { status: "failed", error: getErrorMessage(err) });
          }
        })();
        current.current = { packId, done };
        await done;
      }
    } finally {
      current.current = null;
      running.current = false;
    }
  }, [patch]);

  const enqueue = useCallback(
    (packId: string, sources: UploadSource[]) => {
      if (sources.length === 0) return;
      const added = sources.map((source) => ({ key: `u${++nextKey}`, packId, source }));
      setJobs((list) => [
        ...list,
        ...added.map(({ key, source }): UploadJob => ({ key, packId, label: source instanceof File ? source.name : (source.label ?? source.name), status: "waiting" })),
      ]);
      queue.current.push(...added);
      void run();
    },
    [run]
  );

  /**
   * Stops the uploads of a pack that is about to be deleted: waiting ones are
   * marked cancelled, and the one in flight is awaited, so its image cannot
   * land after the pack's images were removed (it would stay in the public
   * bucket with no row).
   */
  const cancelPack = useCallback(
    async (packId: string) => {
      const dropped = new Set(queue.current.filter((q) => q.packId === packId).map((q) => q.key));
      queue.current = queue.current.filter((q) => q.packId !== packId);
      setJobs((list) =>
        list.map((j) => (dropped.has(j.key) ? { ...j, status: "failed", error: "Cancelled: the pack is being deleted" } : j))
      );
      const inFlight = current.current;
      if (inFlight?.packId === packId) await inFlight.done;
    },
    []
  );

  const clearFinished = useCallback((packId: string) => {
    setJobs((list) => list.filter((j) => j.packId !== packId || j.status === "waiting" || j.status === "uploading"));
  }, []);

  const busy = jobs.some((j) => j.status === "waiting" || j.status === "uploading");

  // leaving the page would stop the queue
  useEffect(() => {
    if (!busy) return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [busy]);

  return { jobs, enqueue, cancelPack, clearFinished, busy };
}

const STATUS = {
  waiting: { icon: Clock, label: "Waiting", className: "text-muted-foreground" },
  uploading: { icon: Loader2, label: "Uploading", className: "text-primary [&_svg]:animate-spin" },
  done: { icon: CheckCircle2, label: "Added", className: "text-success" },
  failed: { icon: AlertCircle, label: "Failed", className: "text-destructive" },
} as const;

/** Per-file progress of one pack's uploads. */
export function UploadList({ jobs, onClear }: { jobs: UploadJob[]; onClear: () => void }) {
  if (jobs.length === 0) return null;
  const finished = jobs.filter((j) => j.status === "done" || j.status === "failed").length;
  const failed = jobs.filter((j) => j.status === "failed").length;
  const active = finished < jobs.length;
  return (
    <section className="space-y-2 rounded-xl border bg-muted/30 p-3" aria-label="Uploads">
      <div className="flex flex-wrap items-center gap-2">
        <p className="text-sm font-medium" role="status">
          {active ? `Uploading ${finished + 1} of ${jobs.length}…` : `Finished ${jobs.length} upload${jobs.length === 1 ? "" : "s"}`}
          {failed > 0 && <span className="text-destructive"> · {failed} failed</span>}
        </p>
        {!active && (
          <Button variant="ghost" size="sm" className="ml-auto" onClick={onClear}>
            Clear
          </Button>
        )}
      </div>
      <div
        className="h-1.5 overflow-hidden rounded-full bg-muted"
        role="progressbar"
        aria-label="Upload progress"
        aria-valuemin={0}
        aria-valuemax={jobs.length}
        aria-valuenow={finished}
      >
        <div className="h-full rounded-full bg-primary transition-[width]" style={{ width: `${(finished / jobs.length) * 100}%` }} />
      </div>
      <ul className="max-h-48 space-y-1 overflow-y-auto text-xs">
        {jobs.map((job) => {
          const { icon: Icon, label, className } = STATUS[job.status];
          return (
            <li key={job.key} className="flex min-w-0 items-start gap-2">
              <span className={cn("mt-px flex shrink-0", className)} title={label}>
                <Icon className="size-3.5" aria-hidden />
                <span className="sr-only">{label}:</span>
              </span>
              <span className="min-w-0 flex-1 [overflow-wrap:anywhere]">
                {job.label}
                {job.error && <span className="block text-destructive">{job.error}</span>}
              </span>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
