"use client";

import { format } from "date-fns";
import { Building2, UserRound } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { DueBadge } from "@/components/documents/doc-badges";
import { assignmentTree, type AssignmentNode } from "@/lib/documents/incoming";
import { ASSIGNMENT_ROLE_LABELS, ASSIGNMENT_STATUS_LABELS } from "@/lib/documents/labels";
import type { Assignment, AssignmentStatus } from "@/lib/documents/types";
import { cn } from "@/lib/utils";

// Who handles the document (xử lý): lead / support / info assignments nested
// by sub-assignment, with connector lines between a node and its children.

const STATUS_CLASSES: Record<AssignmentStatus, string> = {
  pending: "bg-muted text-muted-foreground",
  seen: "bg-primary/10 text-primary dark:bg-primary/20",
  in_progress: "bg-primary/10 text-primary dark:bg-primary/20",
  done: "bg-success/15 text-emerald-700 dark:bg-success/20 dark:text-emerald-300",
  returned: "bg-warning/15 text-amber-800 dark:bg-warning/20 dark:text-amber-200",
  revoked: "bg-muted text-muted-foreground line-through",
};

/** No deadline chip once the assignment is over. */
const CLOSED: readonly AssignmentStatus[] = ["done", "returned", "revoked"];

function when(iso: string | null | undefined): string {
  if (!iso) return "";
  const at = new Date(iso);
  return Number.isNaN(at.getTime()) ? "" : format(at, "dd/MM/yyyy");
}

function NodeCard({ node, today, holidays }: { node: AssignmentNode; today: string; holidays: ReadonlySet<string> }) {
  const isDepartment = !node.assignee_user_id && !!node.assignee_department_id;
  const Icon = isDepartment ? Building2 : UserRound;
  const name = isDepartment
    ? node.assignee_department_name || "A department"
    : node.assignee_name || "Former member";
  return (
    <div className="rounded-lg border bg-background p-3 print:break-inside-avoid">
      <div className="flex flex-wrap items-center gap-1.5">
        <Badge variant={node.role === "lead" ? "default" : "outline"}>
          {ASSIGNMENT_ROLE_LABELS[node.role] ?? node.role}
        </Badge>
        <span className="inline-flex min-w-0 items-center gap-1 font-medium">
          <Icon className="size-3.5 shrink-0 text-muted-foreground" aria-label={isDepartment ? "Department" : "Person"} />
          <span className="break-words">{name}</span>
        </span>
        <Badge variant="secondary" className={cn("ml-auto", STATUS_CLASSES[node.status])}>
          {ASSIGNMENT_STATUS_LABELS[node.status] ?? node.status}
        </Badge>
      </div>
      <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
        <span>
          Assigned by {node.assigned_by_name || "someone"}
          {node.assigned_at && ` · ${when(node.assigned_at)}`}
        </span>
        {!CLOSED.includes(node.status) && <DueBadge due={node.due_date} today={today} holidays={holidays} />}
        {node.status === "done" && node.done_at && <span>Done {when(node.done_at)}</span>}
      </div>
      {node.instruction && (
        <blockquote className="mt-2 border-l-2 border-primary/40 pl-3 text-sm whitespace-pre-wrap text-muted-foreground italic">
          {node.instruction}
        </blockquote>
      )}
      {node.result && (node.status === "done" || node.status === "returned") && (
        <div className="mt-2 rounded-md bg-muted/60 px-3 py-2 text-sm">
          <span className="text-xs font-medium text-muted-foreground">
            {node.status === "done" ? "Result (Kết quả)" : "Reason returned"}
          </span>
          <p className="whitespace-pre-wrap">{node.result}</p>
        </div>
      )}
    </div>
  );
}

function Branch({
  nodes,
  today,
  holidays,
  nested,
}: {
  nodes: AssignmentNode[];
  today: string;
  holidays: ReadonlySet<string>;
  nested: boolean;
}) {
  // assignmentTree nests only rows reachable from a root, so the recursion ends
  return (
    <ul className={cn("space-y-2", nested && "mt-2 ml-3 border-l pl-4 sm:ml-5")}>
      {nodes.map((node) => (
        <li
          key={node.id}
          className={cn(
            "relative",
            nested && "before:absolute before:top-5 before:-left-4 before:w-3 before:border-t before:content-['']"
          )}
        >
          <NodeCard node={node} today={today} holidays={holidays} />
          {node.children.length > 0 && (
            <Branch nodes={node.children} today={today} holidays={holidays} nested />
          )}
        </li>
      ))}
    </ul>
  );
}

export function DocumentAssignments({
  assignments,
  today,
  holidays,
}: {
  assignments: Assignment[];
  today: string;
  holidays: ReadonlySet<string>;
}) {
  if (assignments.length === 0) return null;
  const tree = assignmentTree(assignments);
  return (
    <Card className="print:shadow-none print:ring-0">
      <CardHeader>
        <h2 className="font-heading text-base font-medium">Processing (Xử lý)</h2>
      </CardHeader>
      <CardContent>
        <Branch nodes={tree} today={today} holidays={holidays} nested={false} />
      </CardContent>
    </Card>
  );
}
