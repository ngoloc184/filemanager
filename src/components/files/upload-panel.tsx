"use client";

import {
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  File,
  Loader2,
  RefreshCw,
  X,
  XCircle,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import type { UploadTask } from "@/lib/services/uploads";
import { formatBytes } from "@/lib/utils";

function StatusIcon({ task }: { task: UploadTask }) {
  switch (task.status) {
    case "done":
      return <CheckCircle2 className="h-4 w-4 text-green-600 shrink-0" />;
    case "failed":
      return <XCircle className="h-4 w-4 text-destructive shrink-0" />;
    case "uploading":
    case "registering":
      return <Loader2 className="h-4 w-4 text-primary animate-spin shrink-0" />;
    default:
      return <File className="h-4 w-4 text-muted-foreground shrink-0" />;
  }
}

function statusLabel(task: UploadTask): string {
  switch (task.status) {
    case "pending":
      return "Waiting...";
    case "uploading":
      return "Uploading...";
    case "registering":
      return "Saving...";
    case "done":
      return "Done";
    case "failed":
      return task.error ?? "Failed";
  }
}

export default function UploadPanel({
  tasks,
  open,
  onToggle,
  onClose,
  onRetry,
}: {
  tasks: UploadTask[];
  open: boolean;
  onToggle: () => void;
  onClose: () => void;
  onRetry: (localId: string) => void;
}) {
  if (tasks.length === 0) return null;

  const active = tasks.filter(
    (task) => task.status === "uploading" || task.status === "registering" || task.status === "pending"
  ).length;
  const failed = tasks.filter((task) => task.status === "failed").length;
  const done = tasks.filter((task) => task.status === "done").length;

  return (
    <div className="fixed bottom-4 right-4 z-50 w-80 max-w-[calc(100vw-2rem)] rounded-xl border bg-white shadow-2xl">
      <div
        className="flex items-center justify-between px-4 py-3 cursor-pointer select-none"
        onClick={onToggle}
      >
        <div className="flex items-center gap-2 text-sm font-medium">
          {active > 0 ? (
            <Loader2 className="h-4 w-4 animate-spin text-primary" />
          ) : failed > 0 ? (
            <XCircle className="h-4 w-4 text-destructive" />
          ) : (
            <CheckCircle2 className="h-4 w-4 text-green-600" />
          )}
          {active > 0
            ? `Uploading ${active} of ${tasks.length}...`
            : failed > 0
              ? `${done} done, ${failed} failed`
              : `${done} upload${done === 1 ? "" : "s"} completed`}
        </div>
        <div className="flex items-center gap-1">
          <button
            type="button"
            className="p-1 rounded hover:bg-muted text-muted-foreground"
            onClick={(e) => {
              e.stopPropagation();
              onClose();
            }}
            aria-label="Close upload panel"
          >
            <X className="h-4 w-4" />
          </button>
          {open ? (
            <ChevronDown className="h-4 w-4 text-muted-foreground" />
          ) : (
            <ChevronUp className="h-4 w-4 text-muted-foreground" />
          )}
        </div>
      </div>
      {open && (
        <div className="max-h-64 overflow-auto border-t px-2 py-2 space-y-1">
          {tasks.map((task) => (
            <div key={task.localId} className="flex items-center gap-2 px-2 py-1.5 rounded-md hover:bg-muted/60">
              <StatusIcon task={task} />
              <div className="flex-1 min-w-0">
                <p className="text-xs font-medium truncate">{task.file.name}</p>
                <p
                  className={`text-[11px] truncate ${
                    task.status === "failed" ? "text-destructive" : "text-muted-foreground"
                  }`}
                >
                  {formatBytes(task.file.size)} • {statusLabel(task)}
                </p>
              </div>
              {task.status === "failed" && (
                <Button
                  variant="ghost"
                  size="xs"
                  onClick={() => onRetry(task.localId)}
                  aria-label={`Retry ${task.file.name}`}
                >
                  <RefreshCw className="h-3 w-3" />
                </Button>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
