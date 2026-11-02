"use client";

import { useState, type FormEvent } from "react";
import { format } from "date-fns";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";

import { nativeSelectClass } from "@/components/org/department-select";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { OPINION_CHIP_LABELS } from "@/lib/documents/events";
import type { DocumentBundle, OpinionKind } from "@/lib/documents/types";
import { addDocumentOpinion } from "@/lib/services/documents";
import { getErrorMessage } from "@/lib/types/database";
import { cn } from "@/lib/utils";

// Processing opinions (ý kiến xử lý): every reader may comment or propose;
// instructions (chỉ đạo) are for leaders, company admins and whoever
// assigned the document (the add_document_opinion rule).

export const MAX_OPINION_LENGTH = 5000;

const KIND_CLASSES: Record<OpinionKind, string> = {
  instruction: "bg-primary/10 text-primary dark:bg-primary/20",
  proposal: "bg-warning/15 text-amber-800 dark:bg-warning/20 dark:text-amber-200",
  comment: "bg-muted text-muted-foreground",
  result: "bg-success/15 text-emerald-700 dark:bg-success/20 dark:text-emerald-300",
  consult_reply: "bg-secondary text-secondary-foreground",
};

function canInstruct(bundle: DocumentBundle): boolean {
  const roles = bundle.me.roles ?? [];
  return (
    roles.includes("leader") ||
    roles.includes("org_admin") ||
    bundle.assignments.some((a) => a.assigned_by === bundle.me.user_id)
  );
}

export function DocumentOpinions({ bundle, onChanged }: { bundle: DocumentBundle; onChanged: () => void }) {
  const [body, setBody] = useState("");
  const [kind, setKind] = useState<OpinionKind>("comment");
  const [saving, setSaving] = useState(false);
  const instruct = canInstruct(bundle);
  const kinds: OpinionKind[] = instruct ? ["comment", "proposal", "instruction"] : ["comment", "proposal"];
  const trimmed = body.trim();
  const opinions = bundle.opinions;

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (saving || !trimmed || trimmed.length > MAX_OPINION_LENGTH) return;
    setSaving(true);
    try {
      await addDocumentOpinion(bundle.document.id, kinds.includes(kind) ? kind : "comment", trimmed);
      setBody("");
      setKind("comment");
      toast.success("Opinion added");
      onChanged();
    } catch (err) {
      toast.error(getErrorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card className="print:shadow-none print:ring-0">
      <CardHeader>
        <h2 className="font-heading text-base font-medium">Opinions (Ý kiến xử lý)</h2>
      </CardHeader>
      <CardContent className="space-y-4">
        {opinions.length === 0 ? (
          <p className="text-sm text-muted-foreground">No opinions yet.</p>
        ) : (
          <ul className="space-y-3">
            {opinions.map((o) => {
              const at = new Date(o.created_at);
              return (
                <li key={o.id} className="rounded-lg border bg-background p-3 print:break-inside-avoid">
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                    <Badge variant="secondary" className={KIND_CLASSES[o.kind]}>
                      {OPINION_CHIP_LABELS[o.kind] ?? o.kind}
                    </Badge>
                    <span className="text-sm font-medium">{o.author_name || "Former member"}</span>
                    {!Number.isNaN(at.getTime()) && (
                      <time dateTime={o.created_at} className="text-xs text-muted-foreground">
                        {format(at, "dd/MM/yyyy HH:mm")}
                      </time>
                    )}
                  </div>
                  <p className="mt-1.5 text-sm whitespace-pre-wrap break-words">{o.body}</p>
                </li>
              );
            })}
          </ul>
        )}

        <form onSubmit={(e) => void submit(e)} className="space-y-2 print:hidden">
          <Label htmlFor="opinion-body">Add an opinion</Label>
          <Textarea
            id="opinion-body"
            value={body}
            onChange={(e) => setBody(e.target.value)}
            maxLength={MAX_OPINION_LENGTH}
            rows={3}
            placeholder="Write your opinion…"
            aria-describedby="opinion-count"
            disabled={saving}
          />
          <div className="flex flex-wrap items-center gap-2">
            <label htmlFor="opinion-kind" className="sr-only">
              Opinion kind
            </label>
            <select
              id="opinion-kind"
              className={cn(nativeSelectClass, "w-auto")}
              value={kinds.includes(kind) ? kind : "comment"}
              onChange={(e) => setKind(e.target.value as OpinionKind)}
              disabled={saving}
            >
              {kinds.map((k) => (
                <option key={k} value={k}>
                  {OPINION_CHIP_LABELS[k]}
                </option>
              ))}
            </select>
            <span
              id="opinion-count"
              className={cn(
                "text-xs text-muted-foreground tabular-nums",
                body.length >= MAX_OPINION_LENGTH && "text-destructive"
              )}
            >
              {body.length}/{MAX_OPINION_LENGTH}
            </span>
            <Button type="submit" size="sm" className="ml-auto" disabled={saving || !trimmed}>
              {saving && <Loader2 className="animate-spin" aria-hidden="true" />}
              Add opinion
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}
