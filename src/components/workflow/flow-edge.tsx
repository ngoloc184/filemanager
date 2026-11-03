"use client";

import { BaseEdge, EdgeLabelRenderer, getSmoothStepPath, type Edge, type EdgeProps } from "@xyflow/react";
import { X } from "lucide-react";

/** late: the step before is overdue · active: leads into a step under way (drawn animated) */
export type FlowEdgeData = { onDelete: (id: string) => void; late: boolean; active: boolean };
export type FlowEdge = Edge<FlowEdgeData, "flow">;

/** A rounded elbow arrow; a selected arrow shows a remove button at its middle. */
export function FlowEdgeView({ id, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, markerEnd, selected, data }: EdgeProps<FlowEdge>) {
  const [path, labelX, labelY] = getSmoothStepPath({ sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, borderRadius: 14, offset: 24 });
  return (
    <>
      <BaseEdge
        id={id}
        path={path}
        markerEnd={markerEnd}
        interactionWidth={18}
        style={{
          stroke: selected ? "var(--primary)" : data?.late ? "var(--color-rose-500)" : data?.active ? "var(--color-sky-500)" : "color-mix(in oklch, var(--muted-foreground) 55%, transparent)",
          strokeWidth: data?.active ? 3 : selected ? 2.25 : 1.75,
        }}
      />
      {selected && (
        <EdgeLabelRenderer>
          <button
            type="button"
            aria-label="Xoá mũi tên"
            onClick={() => data?.onDelete(id)}
            className="nodrag nopan pointer-events-auto absolute grid size-6 place-items-center rounded-full bg-background text-muted-foreground shadow-sm ring-1 ring-border hover:bg-destructive hover:text-white"
            style={{ transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)` }}
          >
            <X className="size-3.5" />
          </button>
        </EdgeLabelRenderer>
      )}
    </>
  );
}
