"use client";

import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { AlertTriangle, ArrowLeft, FileInput, FilePen, FileText, Loader2, X } from "lucide-react";
import { toast } from "sonner";
import { Button, buttonVariants } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { DepartmentSelect, nativeSelectClass } from "@/components/org/department-select";
import { DuplicateDialog } from "@/components/documents/duplicate-dialog";
import { ExternalOrgInput } from "@/components/documents/external-org-input";
import {
  DocumentUpload,
  newUploadItem,
  type DocUploadItem,
} from "@/components/documents/document-upload";
import {
  attachDocumentFile,
  createDocument,
  ensureDocumentFolder,
  getDocument,
  listDocFields,
  listDocTypes,
  listHolidays,
  listRegisters,
  updateDocumentProfile,
} from "@/lib/services/documents";
import { peekNextNumber } from "@/lib/services/document-admin";
import { registerIncoming } from "@/lib/services/documents-incoming";
import { getMyOrg, type MyOrg, type OrgHoliday } from "@/lib/services/org";
import { createUploadTasks, uploadOne } from "@/lib/services/uploads";
import { defaultDueDate, formatDay, holidaySet, todayIn } from "@/lib/documents/deadlines";
import {
  MAX_DESCRIPTION_LENGTH,
  MAX_KEYWORDS,
  MAX_KEYWORD_LENGTH,
  MAX_SUBJECT_LENGTH,
  addKeywords,
  changedFields,
  emptyDocumentForm,
  formValuesFromDocument,
  isFormDirty,
  isFormValid,
  sortDocTypes,
  submitLabel,
  toProfilePayload,
  validateDocumentForm,
  type DocumentFormErrors,
  type DocumentFormField,
  type DocumentFormValues,
} from "@/lib/documents/form";
import type { DuplicateCandidate } from "@/lib/documents/incoming";
import { CONFIDENTIALITY_LABELS, DIRECTION_LABELS, URGENCY_LABELS } from "@/lib/documents/labels";
import {
  CONFIDENTIALITIES,
  URGENCIES,
  type Direction,
  type DocField,
  type DocRegister,
  type DocType,
  type DocumentBundle,
  type DocumentProfileInput,
} from "@/lib/documents/types";
import { hasRole } from "@/lib/org";
import { getErrorMessage } from "@/lib/types/database";
import { cn } from "@/lib/utils";

export type DocumentFormProps =
  | { mode: "create"; direction: Direction; userId: string }
  | { mode: "edit"; bundle: DocumentBundle; userId: string };

/** Order the fields are checked in, so focus goes to the first error on the page. */
const FIELD_ORDER: DocumentFormField[] = [
  "docTypeId",
  "fieldId",
  "subject",
  "urgency",
  "confidentiality",
  "dueDate",
  "keywords",
  "description",
  "draftingDepartmentId",
  "issuingOrgName",
  "notation",
  "issuedDate",
  "arrivalDate",
  "signerName",
  "signerPosition",
  "pageCount",
  "mainFile",
];

const TITLES: Record<Direction, string> = {
  incoming: "Register an incoming document (Vào sổ văn bản đến)",
  outgoing: "New outgoing document (Văn bản đi)",
  internal: "New internal document (Văn bản nội bộ)",
};

type Lookups = {
  org: MyOrg | null;
  types: DocType[];
  fields: DocField[];
  registers: DocRegister[];
  holidays: OrgHoliday[];
};

type Failure = { message: string; documentId: string | null };

function Notice({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
        <CardDescription>{children}</CardDescription>
      </CardHeader>
    </Card>
  );
}

function Loading({ label }: { label: string }) {
  return (
    <div className="flex items-center gap-2 text-sm text-muted-foreground" role="status">
      <Loader2 className="size-4 animate-spin" aria-hidden />
      {label}
    </div>
  );
}

/**
 * Create, edit and register form for documents (Văn bản). Create uploads the
 * picked files on submit into the caller's 'Documents' folder, links them
 * (main first) and, for incoming documents, registers the draft (vào sổ) in
 * one go; possible duplicates open DuplicateDialog. Edit sends only the
 * fields that changed.
 */
export function DocumentForm(props: DocumentFormProps) {
  const router = useRouter();
  const ids = useId();
  const fieldId = (field: DocumentFormField) => `${ids}-${field}`;

  const mode = props.mode;
  const bundle = props.mode === "edit" ? props.bundle : null;
  const direction: Direction = props.mode === "edit" ? props.bundle.document.direction : props.direction;
  const incoming = direction === "incoming";
  const userId = props.userId;

  const [lookups, setLookups] = useState<Lookups | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [initial, setInitial] = useState<DocumentFormValues | null>(null);
  const [values, setValues] = useState<DocumentFormValues>(() => emptyDocumentForm());
  const [errors, setErrors] = useState<DocumentFormErrors>({});
  const [keywordDraft, setKeywordDraft] = useState("");

  const [registerNow, setRegisterNow] = useState(true);
  const [registerId, setRegisterId] = useState("");
  const [nextNumber, setNextNumber] = useState<{ registerId: string; n: number | null } | null>(null);

  const [main, setMain] = useState<DocUploadItem | null>(null);
  const [attachments, setAttachments] = useState<DocUploadItem[]>([]);

  const [saving, setSaving] = useState(false);
  const [failure, setFailure] = useState<Failure | null>(null);
  const [duplicates, setDuplicates] = useState<DuplicateCandidate[] | null>(null);

  // the draft created by an earlier attempt, so a retry does not create another
  const createdIdRef = useRef<string | null>(null);
  const savedPayloadRef = useRef<DocumentProfileInput | null>(null);
  const folderIdRef = useRef<string | null>(null);
  const leavingRef = useRef(false);
  // set synchronously, so a second submit before the re-render is ignored
  const submittingRef = useRef(false);

  // ------------------------------------------------------------ loading

  useEffect(() => {
    let cancelled = false;
    const load = async (): Promise<{ lookups: Lookups; start: DocumentFormValues }> => {
      const [org, types, fields] = await Promise.all([
        mode === "create" ? getMyOrg() : Promise.resolve(null),
        listDocTypes(true),
        listDocFields(true),
      ]);
      const today = todayIn(org?.org.timezone);
      const registersFor = mode === "create" && incoming && org && hasRole(org.me, "clerk");
      const [registers, holidays] = await Promise.all([
        registersFor ? listRegisters("incoming", Number(today.slice(0, 4))) : Promise.resolve([]),
        incoming ? listHolidays().catch(() => [] as OrgHoliday[]) : Promise.resolve([] as OrgHoliday[]),
      ]);

      let start: DocumentFormValues;
      if (bundle) {
        start = formValuesFromDocument(bundle.document);
      } else {
        const firstType = sortDocTypes(types)[0];
        start = emptyDocumentForm({
          docTypeId: firstType?.id ?? "",
          draftingDepartmentId: !incoming ? (org?.me.department_id ?? "") : "",
          arrivalDate: incoming ? today : "",
        });
      }
      return { lookups: { org, types, fields, registers, holidays }, start };
    };
    load()
      .then(({ lookups: loaded, start }) => {
        if (cancelled) return;
        setLookups(loaded);
        setInitial(start);
        setValues(start);
      })
      .catch((err: unknown) => {
        if (!cancelled) setLoadError(getErrorMessage(err));
      });
    return () => {
      cancelled = true;
    };
    // bundle is set once by DocumentEditForm, so this runs once per document
  }, [mode, incoming, bundle]);

  const roles = bundle ? bundle.me.roles : (lookups?.org?.me.roles ?? []);
  const isClerk = roles.includes("clerk");
  const canSaveContact = isClerk || roles.includes("org_admin");

  const typeOptions = useMemo(
    () => sortDocTypes(lookups?.types ?? [], initial?.docTypeId || null),
    [lookups?.types, initial?.docTypeId]
  );
  const fieldOptions = useMemo(
    () => (lookups?.fields ?? []).filter((f) => f.active || f.id === initial?.fieldId),
    [lookups?.fields, initial?.fieldId]
  );
  const selectedType = typeOptions.find((t) => t.id === values.docTypeId) ?? null;

  // open registers of this year that take the chosen type
  const registerOptions = useMemo(
    () =>
      (lookups?.registers ?? []).filter(
        (r) =>
          !r.closed_at &&
          (!values.docTypeId || r.allowed_type_ids.length === 0 || r.allowed_type_ids.includes(values.docTypeId))
      ),
    [lookups?.registers, values.docTypeId]
  );
  const selectedRegisterId = registerOptions.some((r) => r.id === registerId)
    ? registerId
    : (registerOptions[0]?.id ?? "");
  const showRegister = mode === "create" && incoming;
  const willRegister = showRegister && registerNow && !!selectedRegisterId;
  // issuing organisation and notation are required to register, and stay so once registered
  const senderRequired = willRegister || (!!bundle && incoming && bundle.document.status !== "draft");

  // preview of the arrival number register_incoming would hand out
  useEffect(() => {
    if (!willRegister) return;
    let cancelled = false;
    peekNextNumber(selectedRegisterId)
      .then((n) => {
        if (!cancelled) setNextNumber({ registerId: selectedRegisterId, n });
      })
      .catch(() => {
        if (!cancelled) setNextNumber({ registerId: selectedRegisterId, n: null });
      });
    return () => {
      cancelled = true;
    };
  }, [willRegister, selectedRegisterId]);

  const previewNumber = nextNumber && nextNumber.registerId === selectedRegisterId ? nextNumber.n : null;

  // ------------------------------------------------------------ leave guard

  const dirty =
    !!initial && (isFormDirty(initial, values) || !!main || attachments.length > 0 || keywordDraft.trim() !== "");

  useEffect(() => {
    if (!dirty && !saving) return;
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      if (leavingRef.current) return;
      e.preventDefault();
      // older browsers show the prompt only when returnValue is set
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [dirty, saving]);

  // ------------------------------------------------------------ editing

  const set = <K extends keyof DocumentFormValues>(key: K, value: DocumentFormValues[K]) => {
    setValues((v) => ({ ...v, [key]: value }));
    setErrors((e) => {
      if (!e[key]) return e;
      const next = { ...e };
      delete next[key];
      return next;
    });
  };

  const commitKeywords = (typed: string) => {
    if (!typed.trim()) {
      setKeywordDraft("");
      return;
    }
    set("keywords", addKeywords(values.keywords, typed));
    setKeywordDraft("");
  };

  const patchItem = useCallback((localId: string, patch: Partial<DocUploadItem>) => {
    setMain((m) => (m && m.localId === localId ? { ...m, ...patch } : m));
    setAttachments((list) => list.map((a) => (a.localId === localId ? { ...a, ...patch } : a)));
  }, []);

  const clearFileError = () =>
    setErrors((e) => {
      if (!e.mainFile) return e;
      const next = { ...e };
      delete next.mainFile;
      return next;
    });

  // ------------------------------------------------------------ submit

  const finish = (message: string, documentId: string) => {
    leavingRef.current = true;
    toast.success(message);
    router.push(`/documents/${documentId}`);
  };

  /** Uploads what is not uploaded yet, then links what is not linked, main first. */
  const uploadAndAttach = async (documentId: string) => {
    const items = [main, ...attachments].filter((i): i is DocUploadItem => !!i);
    if (!items.some((i) => !i.attached)) return;
    if (items.some((i) => !i.fileId)) {
      folderIdRef.current ??= await ensureDocumentFolder();
    }
    const folderId = folderIdRef.current;
    const failed: string[] = [];
    for (const item of items) {
      let fileId = item.fileId;
      if (!fileId) {
        patchItem(item.localId, { state: "uploading", error: undefined });
        try {
          const [task] = createUploadTasks([item.file], folderId);
          const row = await uploadOne(
            userId,
            task,
            (status, error) => {
              if (status === "failed") patchItem(item.localId, { state: "error", error });
            },
            (warning) => toast.warning(`${item.file.name}: ${warning}`)
          );
          fileId = row.id;
          patchItem(item.localId, { state: "done", fileId });
        } catch (err) {
          patchItem(item.localId, { state: "error", error: getErrorMessage(err) });
          failed.push(item.file.name);
          continue;
        }
      }
      if (!item.attached) {
        try {
          await attachDocumentFile(documentId, fileId, item.kind);
          patchItem(item.localId, { attached: true });
        } catch (err) {
          patchItem(item.localId, { state: "error", error: getErrorMessage(err) });
          failed.push(item.file.name);
        }
      }
    }
    if (failed.length) {
      throw new Error(
        failed.length === 1
          ? `"${failed[0]}" could not be uploaded or attached.`
          : `${failed.length} files could not be uploaded or attached.`
      );
    }
  };

  const focusFirstError = (found: DocumentFormErrors) => {
    const first = FIELD_ORDER.find((f) => found[f]);
    if (!first) return;
    window.requestAnimationFrame(() => {
      const el = document.getElementById(fieldId(first));
      el?.focus();
      el?.scrollIntoView({ block: "center", behavior: "smooth" });
    });
  };

  const submitCreate = async () => {
    const pending = keywordDraft.trim() ? addKeywords(values.keywords, keywordDraft) : values.keywords;
    const current = pending === values.keywords ? values : { ...values, keywords: pending };
    if (current !== values) {
      setValues(current);
      setKeywordDraft("");
    }
    const found = validateDocumentForm(current, direction, { registerNow: willRegister, hasMainFile: !!main });
    setErrors(found);
    if (!isFormValid(found)) {
      focusFirstError(found);
      return;
    }

    setSaving(true);
    setFailure(null);
    let documentId = createdIdRef.current;
    try {
      const payload = toProfilePayload(current, direction);
      if (!documentId) {
        documentId = await createDocument(direction, payload);
        createdIdRef.current = documentId;
      } else {
        // a retry: bring the draft in line with what is on screen now
        const changes = changedFields(savedPayloadRef.current ?? {}, payload);
        if (Object.keys(changes).length) await updateDocumentProfile(documentId, changes);
      }
      savedPayloadRef.current = payload;

      await uploadAndAttach(documentId);

      if (willRegister) {
        const result = await registerIncoming(documentId, selectedRegisterId);
        if (!result.ok) {
          setDuplicates(result.duplicates ?? []);
          return;
        }
        finish(`Registered as arrival no. ${result.arrival_number ?? "?"}`, documentId);
      } else {
        finish("Draft saved", documentId);
      }
    } catch (err) {
      const message = getErrorMessage(err);
      setFailure({ message, documentId });
      toast.error(message);
    } finally {
      setSaving(false);
    }
  };

  const submitEdit = async () => {
    if (!bundle || !initial) return;
    const pending = keywordDraft.trim() ? addKeywords(values.keywords, keywordDraft) : values.keywords;
    const current = pending === values.keywords ? values : { ...values, keywords: pending };
    if (current !== values) {
      setValues(current);
      setKeywordDraft("");
    }
    // a registered document keeps what registering required
    const found = validateDocumentForm(current, direction, { registerNow: senderRequired, hasMainFile: true });
    setErrors(found);
    if (!isFormValid(found)) {
      focusFirstError(found);
      return;
    }
    const changes = changedFields(toProfilePayload(initial, direction), toProfilePayload(current, direction));
    const id = bundle.document.id;
    if (Object.keys(changes).length === 0) {
      leavingRef.current = true;
      toast.message("No changes to save");
      router.push(`/documents/${id}`);
      return;
    }
    setSaving(true);
    setFailure(null);
    try {
      await updateDocumentProfile(id, changes);
      finish("Changes saved", id);
    } catch (err) {
      const message = getErrorMessage(err);
      setFailure({ message, documentId: null });
      toast.error(message);
    } finally {
      setSaving(false);
    }
  };

  const onSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (saving || submittingRef.current) return;
    submittingRef.current = true;
    void (mode === "edit" ? submitEdit() : submitCreate()).finally(() => {
      submittingRef.current = false;
    });
  };

  const confirmDuplicate = async (reason: string) => {
    const documentId = createdIdRef.current;
    if (!documentId) throw new Error("The draft was not saved");
    const result = await registerIncoming(documentId, selectedRegisterId, reason);
    if (!result.ok) throw new Error("The document could not be registered. Try again.");
    setDuplicates(null);
    finish(`Registered as arrival no. ${result.arrival_number ?? "?"}`, documentId);
  };

  const keepDraft = () => {
    const documentId = createdIdRef.current;
    setDuplicates(null);
    if (documentId) finish("Draft saved", documentId);
  };

  const cancel = () => {
    if (window.history.length > 1) router.back();
    else router.push(bundle ? `/documents/${bundle.document.id}` : "/documents");
  };

  // ------------------------------------------------------------ render

  const backHref = bundle ? `/documents/${bundle.document.id}` : "/documents";
  const title = bundle ? "Edit document" : TITLES[direction];
  const Icon = bundle ? FilePen : incoming ? FileInput : FileText;

  const header = (
    <div className="space-y-2">
      <Link href={backHref} className={cn(buttonVariants({ variant: "ghost", size: "sm" }), "-ml-2")}>
        <ArrowLeft aria-hidden />
        {bundle ? "Back to the document" : "Documents"}
      </Link>
      <div className="flex items-center gap-3">
        <Icon className="size-7 shrink-0 text-primary" aria-hidden />
        <h2 className="text-xl font-bold sm:text-2xl">{title}</h2>
      </div>
      {bundle && (
        <p className="text-sm text-muted-foreground [overflow-wrap:anywhere]">
          {DIRECTION_LABELS[direction]} · {bundle.document.subject}
        </p>
      )}
    </div>
  );

  if (loadError) {
    return (
      <div className="max-w-3xl space-y-6">
        {header}
        <p
          className="rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive"
          role="alert"
        >
          {loadError}
        </p>
      </div>
    );
  }
  if (!lookups || !initial) {
    return (
      <div className="max-w-3xl space-y-6">
        {header}
        <Loading label="Loading form…" />
      </div>
    );
  }
  if (mode === "create" && !lookups.org) {
    return (
      <div className="max-w-3xl space-y-6">
        {header}
        <Notice title="Join a company first">
          Documents belong to a company. <Link href="/org">Create or join a company</Link> to start.
        </Notice>
      </div>
    );
  }
  if (mode === "create" && lookups.org && lookups.org.me.status !== "active") {
    return (
      <div className="max-w-3xl space-y-6">
        {header}
        <Notice title="Not available">Your company membership is suspended.</Notice>
      </div>
    );
  }
  if (mode === "create" && incoming && !isClerk) {
    return (
      <div className="max-w-3xl space-y-6">
        {header}
        <Notice title="Not available">Only records clerks (Văn thư) can register incoming documents.</Notice>
      </div>
    );
  }

  const errorText = (field: DocumentFormField) =>
    errors[field] ? (
      <p id={`${fieldId(field)}-error`} className="text-xs text-destructive">
        {errors[field]}
      </p>
    ) : null;
  const describe = (field: DocumentFormField, ...hints: (string | false | null | undefined)[]) =>
    [errors[field] ? `${fieldId(field)}-error` : null, ...hints].filter(Boolean).join(" ") || undefined;
  const invalid = (field: DocumentFormField) => (errors[field] ? true : undefined);
  const required = (
    <>
      {" "}
      <span aria-hidden className="text-destructive">
        *
      </span>
    </>
  );

  const today = todayIn(lookups.org?.org.timezone);
  const holidays = holidaySet(lookups.holidays);
  const defaultDue = incoming ? defaultDueDate(today, values.urgency, holidays) : null;
  const errorCount = Object.keys(errors).length;
  const isSigned = bundle?.document.status === "signed";

  return (
    <div className="max-w-3xl space-y-6">
      {header}

      <form noValidate onSubmit={onSubmit} className="space-y-6" aria-busy={saving}>
        {isSigned && (
          <p className="rounded-lg border border-warning/40 bg-warning/10 px-3 py-2 text-sm text-amber-800 dark:text-amber-200">
            This document is signed: only pages, copies, keywords and description can still change.
          </p>
        )}

        {/* 1) Profile */}
        <Card>
          <CardHeader>
            <CardTitle>
              <h3>Document profile (Thông tin văn bản)</h3>
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor={fieldId("docTypeId")}>
                  Type (Loại văn bản){required}
                </Label>
                <select
                  id={fieldId("docTypeId")}
                  className={cn(nativeSelectClass, errors.docTypeId && "border-destructive")}
                  value={values.docTypeId}
                  required
                  disabled={saving || isSigned}
                  aria-invalid={invalid("docTypeId")}
                  aria-describedby={describe("docTypeId")}
                  onChange={(e) => set("docTypeId", e.target.value)}
                >
                  <option value="">Choose a type</option>
                  {typeOptions.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.name}
                      {t.abbreviation ? ` (${t.abbreviation})` : ""}
                      {!t.active ? " (inactive)" : ""}
                    </option>
                  ))}
                </select>
                {typeOptions.length === 0 && (
                  <p className="text-xs text-muted-foreground">
                    No document types yet. Ask a company admin to add them.
                  </p>
                )}
                {errorText("docTypeId")}
              </div>
              <div className="space-y-1.5">
                <Label htmlFor={fieldId("fieldId")}>Field (Lĩnh vực)</Label>
                <select
                  id={fieldId("fieldId")}
                  className={nativeSelectClass}
                  value={values.fieldId}
                  disabled={saving || isSigned}
                  onChange={(e) => set("fieldId", e.target.value)}
                >
                  <option value="">None</option>
                  {fieldOptions.map((f) => (
                    <option key={f.id} value={f.id}>
                      {f.name}
                      {!f.active ? " (inactive)" : ""}
                    </option>
                  ))}
                </select>
              </div>
            </div>

            <div className="space-y-1.5">
              <div className="flex items-baseline justify-between gap-2">
                <Label htmlFor={fieldId("subject")}>
                  Subject (Trích yếu){required}
                </Label>
                <span
                  id={`${fieldId("subject")}-count`}
                  className={cn(
                    "text-xs tabular-nums",
                    values.subject.trim().length > MAX_SUBJECT_LENGTH ? "text-destructive" : "text-muted-foreground"
                  )}
                >
                  {values.subject.trim().length}/{MAX_SUBJECT_LENGTH}
                </span>
              </div>
              <Textarea
                id={fieldId("subject")}
                value={values.subject}
                required
                rows={3}
                disabled={saving || isSigned}
                aria-invalid={invalid("subject")}
                aria-describedby={describe(
                  "subject",
                  `${fieldId("subject")}-count`,
                  selectedType?.is_cong_van && `${fieldId("subject")}-hint`
                )}
                onChange={(e) => set("subject", e.target.value)}
              />
              {selectedType?.is_cong_van && (
                <p id={`${fieldId("subject")}-hint`} className="text-xs text-muted-foreground">
                  Start with &quot;V/v&quot; for official letters
                </p>
              )}
              {errorText("subject")}
            </div>

            <fieldset className="space-y-1.5" disabled={saving || isSigned}>
              <legend className="mb-1.5 text-sm font-medium">Urgency (Độ khẩn)</legend>
              <div className="flex flex-wrap gap-2">
                {URGENCIES.map((u) => (
                  <label
                    key={u}
                    className={cn(
                      "inline-flex cursor-pointer items-center rounded-full border px-3 py-1 text-sm transition-colors has-[:focus-visible]:ring-3 has-[:focus-visible]:ring-ring/50",
                      values.urgency === u
                        ? "border-primary bg-primary/10 font-medium text-primary dark:bg-primary/20"
                        : "border-border hover:bg-muted"
                    )}
                  >
                    <input
                      type="radio"
                      name={`${ids}-urgency`}
                      value={u}
                      checked={values.urgency === u}
                      onChange={() => set("urgency", u)}
                      className="sr-only"
                    />
                    {URGENCY_LABELS[u]}
                  </label>
                ))}
              </div>
            </fieldset>

            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor={fieldId("confidentiality")}>Confidentiality (Độ mật)</Label>
                <select
                  id={fieldId("confidentiality")}
                  className={nativeSelectClass}
                  value={values.confidentiality}
                  disabled={saving || isSigned}
                  aria-describedby={`${fieldId("confidentiality")}-hint`}
                  onChange={(e) => set("confidentiality", e.target.value as DocumentFormValues["confidentiality"])}
                >
                  {CONFIDENTIALITIES.map((c) => (
                    <option key={c} value={c}>
                      {CONFIDENTIALITY_LABELS[c]}
                    </option>
                  ))}
                </select>
                <p id={`${fieldId("confidentiality")}-hint`} className="text-xs text-muted-foreground">
                  {values.confidentiality === "confidential"
                    ? "Only the people taking part can see it. Keep state secrets (MẬT) out of the system."
                    : values.confidentiality === "normal"
                      ? "Who in the company may see it."
                      : "A label for readers only: who can see it does not change. Choose Confidential to limit readers."}
                </p>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor={fieldId("dueDate")}>{incoming ? "Due date (Hạn xử lý)" : "Reply deadline (Hạn trả lời)"}</Label>
                <Input
                  id={fieldId("dueDate")}
                  type="date"
                  value={values.dueDate}
                  disabled={saving || isSigned}
                  aria-invalid={invalid("dueDate")}
                  aria-describedby={describe("dueDate", `${fieldId("dueDate")}-hint`)}
                  onChange={(e) => set("dueDate", e.target.value)}
                />
                <p id={`${fieldId("dueDate")}-hint`} className="text-xs text-muted-foreground">
                  {incoming
                    ? `Leave empty to use the default by urgency: 7/2/1/0 working days${
                        defaultDue && mode === "create" ? ` (now ${formatDay(defaultDue)})` : ""
                      }`
                    : "Reply deadline (optional)"}
                </p>
                {errorText("dueDate")}
              </div>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor={fieldId("keywords")}>Keywords (Từ khóa)</Label>
              <div
                className={cn(
                  "flex min-h-8 flex-wrap items-center gap-1.5 rounded-lg border border-input px-2 py-1 focus-within:border-ring focus-within:ring-3 focus-within:ring-ring/50 dark:bg-input/30",
                  errors.keywords && "border-destructive"
                )}
              >
                {values.keywords.map((k) => (
                  <span
                    key={k}
                    className="inline-flex max-w-full items-center gap-1 rounded-full bg-secondary px-2 py-0.5 text-xs text-secondary-foreground"
                  >
                    <span className="truncate">{k}</span>
                    <button
                      type="button"
                      disabled={saving}
                      onClick={() => set("keywords", values.keywords.filter((x) => x !== k))}
                      className="inline-flex size-4 items-center justify-center rounded-full hover:bg-foreground/10 focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none"
                      aria-label={`Remove keyword ${k}`}
                    >
                      <X className="size-3" aria-hidden />
                    </button>
                  </span>
                ))}
                <input
                  id={fieldId("keywords")}
                  type="text"
                  value={keywordDraft}
                  maxLength={MAX_KEYWORD_LENGTH * 3}
                  disabled={saving || values.keywords.length >= MAX_KEYWORDS}
                  placeholder={values.keywords.length >= MAX_KEYWORDS ? "Keyword limit reached" : "Type and press Enter"}
                  aria-invalid={invalid("keywords")}
                  aria-describedby={describe("keywords", `${fieldId("keywords")}-hint`)}
                  className="h-6 min-w-32 flex-1 bg-transparent text-base outline-none placeholder:text-muted-foreground disabled:cursor-not-allowed md:text-sm"
                  onChange={(e) => {
                    const text = e.target.value;
                    if (text.includes(",")) commitKeywords(text);
                    else setKeywordDraft(text);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      commitKeywords(keywordDraft);
                    } else if (e.key === "Backspace" && !keywordDraft && values.keywords.length) {
                      set("keywords", values.keywords.slice(0, -1));
                    }
                  }}
                  onBlur={() => commitKeywords(keywordDraft)}
                />
              </div>
              <p id={`${fieldId("keywords")}-hint`} className="text-xs text-muted-foreground">
                Enter or comma adds a keyword; up to {MAX_KEYWORDS}, each at most {MAX_KEYWORD_LENGTH} characters.
              </p>
              {errorText("keywords")}
            </div>

            <div className="space-y-1.5">
              <Label htmlFor={fieldId("description")}>Description (Ghi chú)</Label>
              <Textarea
                id={fieldId("description")}
                value={values.description}
                rows={2}
                maxLength={MAX_DESCRIPTION_LENGTH + 100}
                disabled={saving}
                aria-invalid={invalid("description")}
                aria-describedby={describe("description")}
                onChange={(e) => set("description", e.target.value)}
              />
              {errorText("description")}
            </div>

            {!incoming && (
              <div className="space-y-1.5 sm:max-w-sm">
                <Label htmlFor={fieldId("draftingDepartmentId")}>Drafting department (Đơn vị soạn thảo)</Label>
                <DepartmentSelect
                  id={fieldId("draftingDepartmentId")}
                  value={values.draftingDepartmentId || null}
                  onChange={(id) => set("draftingDepartmentId", id ?? "")}
                  placeholder="Not set"
                  disabled={saving || isSigned}
                />
              </div>
            )}
          </CardContent>
        </Card>

        {/* 2) Sender (incoming) */}
        {incoming && (
          <Card>
            <CardHeader>
              <CardTitle>
                <h3>Sender details (Nơi gửi)</h3>
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="space-y-1.5">
                <Label htmlFor={fieldId("issuingOrgName")}>
                  Issuing organisation (Cơ quan ban hành){senderRequired && required}
                </Label>
                <ExternalOrgInput
                  id={fieldId("issuingOrgName")}
                  value={values.issuingOrgName}
                  externalOrgId={values.externalOrgId || null}
                  onChange={(name, orgId) => {
                    set("issuingOrgName", name);
                    set("externalOrgId", orgId ?? "");
                  }}
                  canSave={canSaveContact}
                  disabled={saving || isSigned}
                  invalid={!!errors.issuingOrgName}
                  required={senderRequired}
                  aria-describedby={describe("issuingOrgName")}
                />
                {errorText("issuingOrgName")}
              </div>

              <div className="grid gap-4 sm:grid-cols-2">
                <div className="space-y-1.5">
                  <Label htmlFor={fieldId("notation")}>
                    Number/notation (Số, ký hiệu){senderRequired && required}
                  </Label>
                  <Input
                    id={fieldId("notation")}
                    value={values.notation}
                    placeholder="e.g. 123/UBND-VP"
                    maxLength={150}
                    autoComplete="off"
                    disabled={saving || isSigned}
                    aria-invalid={invalid("notation")}
                    aria-required={senderRequired || undefined}
                    aria-describedby={describe("notation")}
                    onChange={(e) => set("notation", e.target.value)}
                  />
                  {errorText("notation")}
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor={fieldId("issuedDate")}>Date of document (Ngày văn bản)</Label>
                  <Input
                    id={fieldId("issuedDate")}
                    type="date"
                    value={values.issuedDate}
                    max={today}
                    disabled={saving || isSigned}
                    aria-invalid={invalid("issuedDate")}
                    aria-describedby={describe("issuedDate")}
                    onChange={(e) => set("issuedDate", e.target.value)}
                  />
                  {errorText("issuedDate")}
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor={fieldId("arrivalDate")}>Arrival date (Ngày đến)</Label>
                  <Input
                    id={fieldId("arrivalDate")}
                    type="date"
                    value={values.arrivalDate}
                    disabled={saving || isSigned}
                    aria-invalid={invalid("arrivalDate")}
                    aria-describedby={describe("arrivalDate")}
                    onChange={(e) => set("arrivalDate", e.target.value)}
                  />
                  {errorText("arrivalDate")}
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor={fieldId("pageCount")}>Pages (Số trang)</Label>
                  <Input
                    id={fieldId("pageCount")}
                    type="number"
                    inputMode="numeric"
                    min={1}
                    step={1}
                    value={values.pageCount}
                    disabled={saving}
                    aria-invalid={invalid("pageCount")}
                    aria-describedby={describe("pageCount")}
                    onChange={(e) => set("pageCount", e.target.value)}
                  />
                  {errorText("pageCount")}
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor={fieldId("signerName")}>Signer name (Người ký)</Label>
                  <Input
                    id={fieldId("signerName")}
                    value={values.signerName}
                    maxLength={250}
                    disabled={saving}
                    aria-invalid={invalid("signerName")}
                    aria-describedby={describe("signerName")}
                    onChange={(e) => set("signerName", e.target.value)}
                  />
                  {errorText("signerName")}
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor={fieldId("signerPosition")}>Signer position (Chức vụ)</Label>
                  <Input
                    id={fieldId("signerPosition")}
                    value={values.signerPosition}
                    maxLength={250}
                    disabled={saving}
                    aria-invalid={invalid("signerPosition")}
                    aria-describedby={describe("signerPosition")}
                    onChange={(e) => set("signerPosition", e.target.value)}
                  />
                  {errorText("signerPosition")}
                </div>
              </div>
            </CardContent>
          </Card>
        )}

        {/* 3) Files */}
        <Card>
          <CardHeader>
            <CardTitle>
              <h3>Files (Tệp văn bản)</h3>
            </CardTitle>
            {mode === "create" && (
              <CardDescription>
                Files upload when you save, into your &quot;Documents&quot; folder.
              </CardDescription>
            )}
          </CardHeader>
          <CardContent>
            {bundle ? (
              <div className="space-y-2">
                {bundle.files.length === 0 ? (
                  <p className="text-sm text-muted-foreground">No files attached yet.</p>
                ) : (
                  <ul className="space-y-1.5">
                    {bundle.files.map((f) => (
                      <li key={f.id} className="flex items-center gap-2 text-sm">
                        <FileText className="size-4 shrink-0 text-muted-foreground" aria-hidden />
                        <span className="min-w-0 truncate">{f.name}</span>
                        <span className="shrink-0 text-xs text-muted-foreground">
                          {f.kind === "main" ? "Main" : f.kind === "attachment" ? "Attachment" : f.kind}
                          {f.frozen ? " · frozen" : ""}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
                <p className="text-xs text-muted-foreground">
                  Add or replace files on the <Link href={backHref} className="underline underline-offset-3">document page</Link>.
                </p>
              </div>
            ) : (
              <DocumentUpload
                main={main}
                attachments={attachments}
                disabled={saving}
                mainRequired={willRegister}
                mainError={errors.mainFile}
                mainErrorId={`${fieldId("mainFile")}-error`}
                mainWarning={
                  incoming
                    ? undefined
                    : "You can add the main file later, but it is needed before submitting for approval."
                }
                onSetMain={(file) => {
                  setMain(newUploadItem(file, "main"));
                  clearFileError();
                }}
                onAddAttachments={(files) =>
                  setAttachments((list) => [...list, ...files.map((f) => newUploadItem(f, "attachment"))])
                }
                onRemove={(localId) => {
                  setMain((m) => (m?.localId === localId ? null : m));
                  setAttachments((list) => list.filter((a) => a.localId !== localId));
                }}
              />
            )}
            {/* the main-file error is focusable through this anchor */}
            {!bundle && (
              <span id={fieldId("mainFile")} tabIndex={-1} className="sr-only">
                Main document
              </span>
            )}
          </CardContent>
        </Card>

        {/* 4) Register now (incoming create) */}
        {showRegister && (
          <Card>
            <CardHeader>
              <CardTitle>
                <h3>Register now (Vào sổ)</h3>
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <label className="flex items-start gap-2 text-sm">
                <input
                  type="checkbox"
                  className="mt-0.5 size-4 accent-primary"
                  checked={registerNow && registerOptions.length > 0}
                  disabled={saving || registerOptions.length === 0}
                  onChange={(e) => {
                    setRegisterNow(e.target.checked);
                    clearFileError();
                  }}
                  aria-describedby={`${ids}-register-hint`}
                />
                <span>
                  Register in an incoming register when saving
                  <span id={`${ids}-register-hint`} className="block text-xs text-muted-foreground">
                    Gives the next arrival number (số đến) and freezes the files. Untick to keep it as a draft.
                  </span>
                </span>
              </label>

              {registerOptions.length === 0 ? (
                <p className="text-sm text-amber-700 dark:text-amber-300">
                  {(lookups.registers ?? []).some((r) => !r.closed_at)
                    ? "No open register of this year takes this document type."
                    : `No open incoming register for ${today.slice(0, 4)}. Ask a company admin to open one.`}{" "}
                  The document is saved as a draft.
                </p>
              ) : (
                registerNow && (
                  <div className="grid gap-3 sm:grid-cols-2 sm:items-end">
                    <div className="space-y-1.5">
                      <Label htmlFor={`${ids}-register`}>Register (Sổ văn bản)</Label>
                      <select
                        id={`${ids}-register`}
                        className={nativeSelectClass}
                        value={selectedRegisterId}
                        disabled={saving}
                        onChange={(e) => setRegisterId(e.target.value)}
                      >
                        {registerOptions.map((r) => (
                          <option key={r.id} value={r.id}>
                            {r.name} ({r.year}){r.is_confidential ? " · confidential" : ""}
                          </option>
                        ))}
                      </select>
                    </div>
                    <p className="text-sm" aria-live="polite">
                      Next arrival number:{" "}
                      <span className="font-semibold tabular-nums">
                        {previewNumber ?? (nextNumber?.registerId === selectedRegisterId ? "unavailable" : "…")}
                      </span>
                      <span className="block text-xs text-muted-foreground">
                        A preview; the number is taken when you save.
                      </span>
                    </p>
                  </div>
                )
              )}
            </CardContent>
          </Card>
        )}

        {failure && (
          <div
            className="flex flex-col gap-2 rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive sm:flex-row sm:items-center sm:justify-between"
            role="alert"
          >
            <span className="flex items-start gap-2">
              <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden />
              <span>
                {failure.message}
                {failure.documentId && (
                  <span className="block text-xs">
                    The draft was kept. Save again to retry, or open the draft.
                  </span>
                )}
              </span>
            </span>
            {failure.documentId && (
              <Link
                href={`/documents/${failure.documentId}`}
                onClick={() => {
                  leavingRef.current = true;
                }}
                className={cn(buttonVariants({ variant: "outline", size: "sm" }), "shrink-0 text-foreground")}
              >
                Open draft
              </Link>
            )}
          </div>
        )}

        {errorCount > 0 && (
          <p className="text-sm text-destructive" role="alert">
            {errorCount === 1 ? "Fix the field marked above." : `Fix the ${errorCount} fields marked above.`}
          </p>
        )}

        <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <Button type="button" variant="outline" disabled={saving} onClick={cancel}>
            Cancel
          </Button>
          <Button type="submit" disabled={saving}>
            {saving && <Loader2 className="animate-spin" aria-hidden />}
            {submitLabel(mode, direction, willRegister)}
          </Button>
        </div>
      </form>

      {duplicates && (
        <DuplicateDialog open duplicates={duplicates} onConfirm={confirmDuplicate} onCancel={keepDraft} />
      )}
    </div>
  );
}

/** Edit page body: loads the document and shows the form when the caller may edit it. */
export function DocumentEditForm({ id, userId }: { id: string; userId: string }) {
  const [bundle, setBundle] = useState<DocumentBundle | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    getDocument(id)
      .then((loaded) => {
        if (!cancelled) setBundle(loaded);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(getErrorMessage(err));
      });
    return () => {
      cancelled = true;
    };
  }, [id]);

  const back = (
    <Link href="/documents" className={cn(buttonVariants({ variant: "ghost", size: "sm" }), "-ml-2")}>
      <ArrowLeft aria-hidden />
      Documents
    </Link>
  );

  if (error) {
    return (
      <div className="max-w-3xl space-y-4">
        {back}
        <Notice title="Document not available">
          {/not found/i.test(error) ? "This document does not exist or you do not have access." : error}
        </Notice>
      </div>
    );
  }
  if (!bundle) return <Loading label="Loading document…" />;
  if (!bundle.me.can_edit) {
    return (
      <div className="max-w-3xl space-y-4">
        {back}
        <Notice title="You cannot edit this document">
          You can open it, but you do not have permission to change its details.{" "}
          <Link href={`/documents/${bundle.document.id}`}>Open the document</Link>
        </Notice>
      </div>
    );
  }
  return <DocumentForm key={bundle.document.id} mode="edit" bundle={bundle} userId={userId} />;
}
