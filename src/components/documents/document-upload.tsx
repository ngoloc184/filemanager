"use client";

import { useId, useRef, useState } from "react";
import { CheckCircle2, FileText, Loader2, Paperclip, Upload, X, XCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn, formatBytes } from "@/lib/utils";

// Files of a new document. Nothing uploads on drop: the form uploads the
// picked files on submit (into the 'Documents' folder) and reports each
// file's state back through the items.

export type DocUploadState = "queued" | "uploading" | "done" | "error";

export type DocUploadItem = {
  localId: string;
  file: File;
  kind: "main" | "attachment";
  state: DocUploadState;
  error?: string;
  /** set once uploaded (public.files.id) */
  fileId?: string;
  /** set once linked to the document */
  attached?: boolean;
};

/** A new item for `file`, waiting for submit. */
export function newUploadItem(file: File, kind: DocUploadItem["kind"]): DocUploadItem {
  return { localId: crypto.randomUUID(), file, kind, state: "queued" };
}

const MAIN_ACCEPT =
  ".pdf,.doc,.docx,.odt,.rtf,.jpg,.jpeg,.png,.tif,.tiff,application/pdf,application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document,image/*";

const STATE_LABELS: Record<DocUploadState, string> = {
  queued: "Queued",
  uploading: "Uploading…",
  done: "Uploaded",
  error: "Failed",
};

function StateIcon({ state }: { state: DocUploadState }) {
  switch (state) {
    case "done":
      return <CheckCircle2 className="size-4 shrink-0 text-success" aria-hidden />;
    case "error":
      return <XCircle className="size-4 shrink-0 text-destructive" aria-hidden />;
    case "uploading":
      return <Loader2 className="size-4 shrink-0 animate-spin text-primary" aria-hidden />;
    default:
      return <FileText className="size-4 shrink-0 text-muted-foreground" aria-hidden />;
  }
}

function ItemRow({
  item,
  onRemove,
  disabled,
}: {
  item: DocUploadItem;
  onRemove: (localId: string) => void;
  disabled?: boolean;
}) {
  // an uploaded file is already in the Documents folder: keep it listed
  const removable = !disabled && item.state !== "uploading" && !item.fileId;
  return (
    <li className="flex items-center gap-2 rounded-lg border bg-background px-2.5 py-2">
      <StateIcon state={item.state} />
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium" title={item.file.name}>
          {item.file.name}
        </p>
        <p
          className={cn(
            "truncate text-xs",
            item.state === "error" ? "text-destructive" : "text-muted-foreground"
          )}
        >
          {formatBytes(item.file.size)} · {item.state === "error" && item.error ? item.error : STATE_LABELS[item.state]}
        </p>
      </div>
      {removable && (
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          onClick={() => onRemove(item.localId)}
          aria-label={`Remove ${item.file.name}`}
        >
          <X aria-hidden />
        </Button>
      )}
    </li>
  );
}

function DropZone({
  id,
  label,
  hint,
  icon,
  multiple,
  accept,
  disabled,
  invalid,
  describedBy,
  onFiles,
}: {
  id: string;
  label: string;
  hint: string;
  icon: React.ReactNode;
  multiple: boolean;
  accept?: string;
  disabled?: boolean;
  invalid?: boolean;
  describedBy?: string;
  onFiles: (files: File[]) => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);

  return (
    <div
      onDragOver={(e) => {
        if (disabled || !e.dataTransfer.types.includes("Files")) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = "copy";
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        if (disabled) return;
        e.preventDefault();
        setOver(false);
        const files = Array.from(e.dataTransfer.files);
        if (files.length) onFiles(files);
      }}
      className={cn(
        "flex flex-col items-center gap-2 rounded-xl border-2 border-dashed px-4 py-5 text-center transition-colors",
        over ? "border-primary bg-primary/5" : "border-border bg-muted/20",
        invalid && !over && "border-destructive/60",
        disabled && "opacity-60"
      )}
    >
      {icon}
      <p className="text-sm font-medium">{label}</p>
      <p className="text-xs text-muted-foreground">{hint}</p>
      <Button
        type="button"
        variant="outline"
        size="sm"
        disabled={disabled}
        aria-describedby={describedBy}
        onClick={() => inputRef.current?.click()}
      >
        <Upload aria-hidden />
        {multiple ? "Choose files" : "Choose file"}
      </Button>
      <input
        ref={inputRef}
        id={id}
        type="file"
        className="sr-only"
        tabIndex={-1}
        aria-hidden
        multiple={multiple}
        accept={accept}
        disabled={disabled}
        onChange={(e) => {
          const files = Array.from(e.target.files ?? []);
          // allow picking the same file again after removing it
          e.target.value = "";
          if (files.length) onFiles(files);
        }}
      />
    </div>
  );
}

/**
 * Main file (tệp chính) and attachments (phụ lục). Dropping several files on
 * the main zone keeps the first as the main file and adds the rest as
 * attachments.
 */
export function DocumentUpload({
  main,
  attachments,
  onSetMain,
  onAddAttachments,
  onRemove,
  disabled,
  mainError,
  mainErrorId,
  mainRequired,
  mainWarning,
}: {
  main: DocUploadItem | null;
  attachments: DocUploadItem[];
  onSetMain: (file: File) => void;
  onAddAttachments: (files: File[]) => void;
  onRemove: (localId: string) => void;
  disabled?: boolean;
  mainError?: string;
  /** id of the element that shows mainError (aria-describedby) */
  mainErrorId?: string;
  mainRequired?: boolean;
  /** a non-blocking note, e.g. 'needed before submitting for approval' */
  mainWarning?: string;
}) {
  const mainId = useId();
  const attachmentsId = useId();

  return (
    <div className="space-y-4">
      <div className="space-y-2">
        <h3 className="text-sm font-medium" id={`${mainId}-label`}>
          Main document (Tệp chính)
          {mainRequired && (
            <>
              {" "}
              <span aria-hidden className="text-destructive">
                *
              </span>
              <span className="sr-only">(required)</span>
            </>
          )}
        </h3>
        {main ? (
          <ul aria-labelledby={`${mainId}-label`}>
            <ItemRow item={main} onRemove={onRemove} disabled={disabled} />
          </ul>
        ) : (
          <DropZone
            id={mainId}
            label="Drop the main document here (PDF, Word, scan)"
            hint="One file. You can also choose it from your device."
            icon={<FileText className="size-6 text-muted-foreground" aria-hidden />}
            multiple
            accept={MAIN_ACCEPT}
            disabled={disabled}
            invalid={!!mainError}
            describedBy={mainError ? mainErrorId : undefined}
            onFiles={(files) => {
              onSetMain(files[0]);
              if (files.length > 1) onAddAttachments(files.slice(1));
            }}
          />
        )}
        {mainError && (
          <p id={mainErrorId} className="text-xs text-destructive" role="alert">
            {mainError}
          </p>
        )}
        {!mainError && !main && mainWarning && (
          <p className="text-xs text-amber-700 dark:text-amber-300">{mainWarning}</p>
        )}
      </div>

      <div className="space-y-2">
        <h3 className="text-sm font-medium" id={`${attachmentsId}-label`}>
          Attachments (Phụ lục)
        </h3>
        {attachments.length > 0 && (
          <ul className="space-y-2" aria-labelledby={`${attachmentsId}-label`}>
            {attachments.map((item) => (
              <ItemRow key={item.localId} item={item} onRemove={onRemove} disabled={disabled} />
            ))}
          </ul>
        )}
        <DropZone
          id={attachmentsId}
          label="Drop attachments here"
          hint="Appendices, annexes and other supporting files."
          icon={<Paperclip className="size-5 text-muted-foreground" aria-hidden />}
          multiple
          disabled={disabled}
          onFiles={onAddAttachments}
        />
      </div>
    </div>
  );
}
