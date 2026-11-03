"use client";

import "@xyflow/react/dist/style.css";
import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent } from "react";
import {
  Background,
  BackgroundVariant,
  ConnectionLineType,
  Controls,
  MarkerType,
  MiniMap,
  Panel,
  ReactFlow,
  ReactFlowProvider,
  useNodesState,
  useReactFlow,
  type Connection,
  type Edge,
  type FinalConnectionState,
  type Node,
} from "@xyflow/react";
import { useTheme } from "next-themes";
import { toast } from "sonner";
import { Crosshair, LayoutGrid, MousePointerClick, Plus, Workflow as WorkflowIcon, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { LIMITS, NODE_H, NODE_W, autoLayout, connectSteps, isOverdue, makeStep, removeSteps, topoOrder } from "@/lib/workflow/model";
import { useWorkflow } from "./context";
import { StepNode, type StepFlowNode } from "./step-node";
import { EndNode, StartNode } from "./plan-nodes";
import { FlowEdgeView, type FlowEdge } from "./flow-edge";

const NODE_TYPES = { step: StepNode, start: StartNode, end: EndNode };
const EDGE_TYPES = { flow: FlowEdgeView };
const START_ID = "__start";
const END_ID = "__end";

/** Room for the toolbar above and the zoom controls / minimap below. */
const FIT_PADDING = { top: "72px", bottom: "56px", left: "32px", right: "32px" } as const;
const HINT_KEY = "workflow-builder:hint";

const MINIMAP_FILL: Record<string, string> = {
  violet: "#8b5cf6",
  sky: "#0ea5e9",
  emerald: "#10b981",
  amber: "#f59e0b",
  rose: "#f43f5e",
  teal: "#14b8a6",
  orange: "#f97316",
  slate: "#64748b",
};

const CONNECT_ERRORS = {
  same: "Không thể nối một bước với chính nó.",
  duplicate: "Hai bước này đã được nối.",
  cycle: "Không thể nối: mũi tên này tạo thành vòng lặp.",
  limit: `Tối đa ${LIMITS.edges} mũi tên.`,
};

/** Picks the handle pair that faces the other step, so arrows never loop around a card. */
function sides(a: { x: number; y: number }, b: { x: number; y: number }) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  if (Math.abs(dx) * (NODE_H / NODE_W) >= Math.abs(dy)) return dx >= 0 ? (["s-r", "t-l"] as const) : (["s-l", "t-r"] as const);
  return dy >= 0 ? (["s-b", "t-t"] as const) : (["s-t", "t-b"] as const);
}

type AnyNode = StepFlowNode | Node<Record<string, never>, "start" | "end">;

function Canvas() {
  const { doc, slots, now, canEdit, currentIds, edit, openStep } = useWorkflow();
  const { screenToFlowPosition, fitView, getNodes } = useReactFlow();
  const { resolvedTheme } = useTheme();
  const wrapper = useRef<HTMLDivElement>(null);
  const [nodes, setNodes, onNodesChange] = useNodesState<AnyNode>([]);
  const [selectedEdge, setSelectedEdge] = useState<string | null>(null);

  // first steps (no arrow in) and last steps (no arrow out), for the start and finish pills
  const { roots, sinks } = useMemo(() => {
    const order = topoOrder(doc.steps, doc.edges);
    const hasIn = new Set(doc.edges.map((e) => e.target));
    const hasOut = new Set(doc.edges.map((e) => e.source));
    return { roots: order.filter((id) => !hasIn.has(id)), sinks: order.filter((id) => !hasOut.has(id)) };
  }, [doc.steps, doc.edges]);

  // the document is the source of truth; the local list only adds drag state and selection
  useEffect(() => {
    setNodes((prev) => {
      const old = new Map(prev.map((n) => [n.id, n]));
      const steps: AnyNode[] = doc.steps.map((step, index) => {
        const was = old.get(step.id);
        return {
          ...(was ?? {}),
          id: step.id,
          type: "step" as const,
          position: was?.dragging ? was.position : step.position,
          draggable: canEdit,
          data: { stepId: step.id, index },
        };
      });
      if (!doc.steps.length) return steps;
      const first = doc.steps.find((s) => s.id === roots[0]) ?? doc.steps[0];
      const last = doc.steps.find((s) => s.id === sinks.at(-1)) ?? doc.steps.at(-1)!;
      const lastHeight = old.get(last.id)?.measured?.height ?? NODE_H;
      return [
        { id: START_ID, type: "start", position: { x: first.position.x, y: first.position.y - 84 }, draggable: false, selectable: false, data: {} },
        ...steps,
        { id: END_ID, type: "end", position: { x: last.position.x, y: last.position.y + lastHeight + 56 }, draggable: false, selectable: false, data: {} },
      ];
    });
  }, [doc.steps, roots, sinks, canEdit, setNodes]);

  const removeEdge = useCallback((id: string) => edit((d) => ({ ...d, edges: d.edges.filter((e) => e.id !== id) })), [edit]);

  const edges = useMemo<Edge[]>(() => {
    const pos = new Map(nodes.map((n) => [n.id, n.position]));
    const byId = new Map(doc.steps.map((s) => [s.id, s]));
    const out: Edge[] = [];
    for (const e of doc.edges) {
      const a = pos.get(e.source);
      const b = pos.get(e.target);
      if (!a || !b) continue;
      const [sourceHandle, targetHandle] = sides(a, b);
      const late = isOverdue(byId.get(e.source)!, slots.get(e.source), now);
      const active = currentIds.has(e.target);
      const selected = e.id === selectedEdge;
      out.push({
        id: e.id,
        source: e.source,
        target: e.target,
        sourceHandle,
        targetHandle,
        type: "flow",
        selected,
        selectable: canEdit,
        animated: active && !late,
        markerEnd: { type: MarkerType.ArrowClosed, width: 18, height: 18, color: selected ? "var(--primary)" : active && !late ? "#0ea5e9" : "#94a3b8" },
        data: { onDelete: removeEdge, late, active },
      } satisfies FlowEdge);
    }
    // dashed guides from the start pill and into the finish pill
    const guide = { type: "smoothstep", selectable: false, focusable: false, style: { stroke: "#94a3b8", strokeWidth: 1.5, strokeDasharray: "4 4" } };
    const startPos = pos.get(START_ID);
    const endPos = pos.get(END_ID);
    for (const id of roots) {
      const p = pos.get(id);
      if (!startPos || !p) continue;
      const below = p.y > startPos.y + 20 && Math.abs(p.x - startPos.x) < NODE_W;
      out.push({ ...guide, id: `g_start_${id}`, source: START_ID, target: id, sourceHandle: below ? "s-b" : "s-r", targetHandle: below ? "t-t" : "t-l" });
    }
    for (const id of sinks) {
      const p = pos.get(id);
      if (!endPos || !p) continue;
      const above = p.y < endPos.y - 20 && Math.abs(p.x - endPos.x) < NODE_W;
      out.push({ ...guide, id: `g_end_${id}`, source: id, target: END_ID, sourceHandle: above ? "s-b" : "s-r", targetHandle: above ? "t-t" : "t-l" });
    }
    return out;
  }, [nodes, doc.edges, doc.steps, slots, selectedEdge, removeEdge, canEdit, roots, sinks, now, currentIds]);

  const onConnect = useCallback(
    (c: Connection) => {
      const result = connectSteps(doc.edges, c.source, c.target);
      if (!result.ok) return void toast.error(CONNECT_ERRORS[result.reason]);
      edit((d) => ({ ...d, edges: result.edges }));
    },
    [doc.edges, edit]
  );

  /** Adds a step at a flow position, optionally after (and connected from) another step. */
  const addStepAt = useCallback(
    (position: { x: number; y: number }, fromId?: string) => {
      if (doc.steps.length >= LIMITS.steps) return void toast.error(`Tối đa ${LIMITS.steps} bước.`);
      const from = fromId ? doc.steps.find((s) => s.id === fromId) : undefined;
      const step = makeStep(position, from?.picIds ?? []);
      edit((d) => {
        const next = { ...d, steps: [...d.steps, step] };
        if (!from) return next;
        const linked = connectSteps(next.edges, from.id, step.id);
        return linked.ok ? { ...next, edges: linked.edges } : next;
      });
      openStep(step.id);
    },
    [doc.steps, edit, openStep]
  );

  // dropping a new arrow on empty canvas creates the next step there
  const onConnectEnd = useCallback(
    (event: MouseEvent | TouchEvent, state: FinalConnectionState) => {
      if (state.isValid || !state.fromNode || state.fromHandle?.type !== "source" || state.fromNode.type !== "step") return;
      const point = "changedTouches" in event ? event.changedTouches[0] : event;
      const p = screenToFlowPosition({ x: point.clientX, y: point.clientY });
      addStepAt({ x: p.x - NODE_W / 2, y: p.y - 40 }, state.fromNode.id);
    },
    [screenToFlowPosition, addStepAt]
  );

  const onDoubleClick = useCallback(
    (e: ReactMouseEvent) => {
      if (!canEdit || !(e.target as HTMLElement).classList.contains("react-flow__pane")) return;
      const p = screenToFlowPosition({ x: e.clientX, y: e.clientY });
      addStepAt({ x: p.x - NODE_W / 2, y: p.y - 40 });
    },
    [canEdit, screenToFlowPosition, addStepAt]
  );

  /** Toolbar button: after the selected step, else after the last one, else in view. */
  const addFromToolbar = useCallback(() => {
    const selected = nodes.filter((n) => n.selected && n.type === "step");
    const from = selected.length === 1 ? doc.steps.find((s) => s.id === selected[0].id) : doc.steps.find((s) => s.id === sinks.at(-1));
    if (from) return addStepAt({ x: from.position.x + NODE_W + 88, y: from.position.y }, from.id);
    const el = wrapper.current?.getBoundingClientRect();
    const p = el ? screenToFlowPosition({ x: el.left + el.width / 2, y: el.top + el.height / 2 }) : { x: 0, y: 0 };
    addStepAt({ x: p.x - NODE_W / 2, y: p.y - NODE_H / 2 });
  }, [nodes, doc.steps, sinks, addStepAt, screenToFlowPosition]);

  const tidy = useCallback(() => {
    edit((d) => ({ ...d, steps: autoLayout(d.steps, d.edges) }));
    requestAnimationFrame(() => fitView({ padding: FIT_PADDING, duration: 400 }));
  }, [edit, fitView]);

  const onNodeDragStop = useCallback(
    (_: unknown, __: Node, dragged: Node[]) => {
      const moved = new Map(dragged.filter((n) => n.type === "step").map((n) => [n.id, { x: Math.round(n.position.x), y: Math.round(n.position.y) }]));
      if (moved.size) edit((d) => ({ ...d, steps: d.steps.map((s) => (moved.has(s.id) ? { ...s, position: moved.get(s.id)! } : s)) }));
    },
    [edit]
  );

  /** Brings the steps under way into view. */
  const showCurrent = useCallback(
    (duration = 400) => fitView({ nodes: [...currentIds].map((id) => ({ id })), padding: FIT_PADDING, maxZoom: 1, duration }),
    [currentIds, fitView]
  );

  // fit once the cards are measured; a phone shows the stage under way (else the start) at a readable size
  const fitted = useRef(false);
  useEffect(() => {
    if (fitted.current || !nodes.length || !nodes.every((n) => n.measured)) return;
    fitted.current = true;
    const narrow = (wrapper.current?.clientWidth ?? 1000) < 640;
    const first = getNodes().find((n) => n.type === "step");
    const current = [...currentIds][0];
    if (narrow && current) fitView({ nodes: [{ id: current }], padding: FIT_PADDING, maxZoom: 0.85 });
    else if (narrow && first) fitView({ nodes: [{ id: START_ID }, { id: first.id }], padding: FIT_PADDING, maxZoom: 0.85 });
    else fitView({ padding: FIT_PADDING, maxZoom: 1 });
  }, [nodes, fitView, getNodes, currentIds]);

  const [hint, setHint] = useState(false);
  useEffect(() => {
    try {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- localStorage exists only after hydration
      setHint(canEdit && localStorage.getItem(HINT_KEY) !== "hidden");
    } catch {}
  }, [canEdit]);
  const hideHint = () => {
    setHint(false);
    try {
      localStorage.setItem(HINT_KEY, "hidden");
    } catch {}
  };

  return (
    <div ref={wrapper} className="relative h-full w-full" onDoubleClick={onDoubleClick}>
      <ReactFlow<AnyNode, Edge>
        nodes={nodes}
        edges={edges}
        nodeTypes={NODE_TYPES}
        edgeTypes={EDGE_TYPES}
        onNodesChange={onNodesChange}
        onNodeDragStop={onNodeDragStop}
        onNodesDelete={(gone) => canEdit && edit((d) => removeSteps(d, gone.filter((n) => n.type === "step").map((n) => n.id)))}
        onEdgesDelete={(gone) => canEdit && edit((d) => ({ ...d, edges: d.edges.filter((e) => !gone.some((g) => g.id === e.id)) }))}
        onEdgeClick={(_, e) => canEdit && !e.id.startsWith("g_") && setSelectedEdge(e.id)}
        onPaneClick={() => setSelectedEdge(null)}
        onNodeClick={() => setSelectedEdge(null)}
        onConnect={onConnect}
        onConnectEnd={canEdit ? onConnectEnd : undefined}
        nodesConnectable={canEdit}
        nodesDraggable={canEdit}
        connectionLineType={ConnectionLineType.SmoothStep}
        connectionLineStyle={{ stroke: "var(--primary)", strokeWidth: 2 }}
        connectionRadius={36}
        deleteKeyCode={canEdit ? ["Delete", "Backspace"] : null}
        zoomOnDoubleClick={false}
        minZoom={0.2}
        maxZoom={1.75}
        snapToGrid
        snapGrid={[8, 8]}
        colorMode={resolvedTheme === "dark" ? "dark" : "light"}
        className="bg-transparent!"
      >
        <Background variant={BackgroundVariant.Dots} gap={20} size={1.2} className="opacity-60" />
        <Controls showInteractive={false} position="bottom-left" className="overflow-hidden rounded-lg! shadow-sm! ring-1 ring-border" />
        <MiniMap
          position="bottom-right"
          pannable
          zoomable
          className="hidden overflow-hidden rounded-lg! ring-1 ring-border md:block"
          style={{ width: 168, height: 108 }}
          maskColor="color-mix(in oklch, var(--background) 70%, transparent)"
          nodeBorderRadius={8}
          nodeColor={(n) => {
            if (n.type !== "step") return "#94a3b8";
            const step = doc.steps.find((s) => s.id === n.id);
            const role = doc.roles.find((r) => r.id === step?.picIds[0]);
            return role ? MINIMAP_FILL[role.color] : "#94a3b8";
          }}
        />
        {canEdit && (
          <Panel position="top-left" className="flex gap-1.5">
            <Button size="sm" onClick={addFromToolbar} className="shadow-sm">
              <Plus /> Thêm bước
            </Button>
            <Button size="sm" variant="outline" onClick={tidy} disabled={doc.steps.length < 2} className="shadow-sm">
              <LayoutGrid /> Sắp xếp gọn
            </Button>
          </Panel>
        )}
        {currentIds.size > 0 && (
          <Panel position="top-right">
            <Button size="sm" variant="outline" onClick={() => showCurrent()} className="bg-background shadow-sm" title="Đưa các bước đang diễn ra vào giữa màn hình">
              <Crosshair className="text-sky-600 dark:text-sky-400" /> Bước đang diễn ra
            </Button>
          </Panel>
        )}
        {hint && (
          <Panel position="bottom-center" className="hidden items-center gap-2 rounded-full bg-background/90 py-1.5 pr-1.5 pl-3 text-[11px] text-muted-foreground shadow-sm ring-1 ring-border backdrop-blur lg:flex">
            <MousePointerClick className="size-3.5 shrink-0 text-primary" />
            <span>Kéo chấm tròn ở cạnh bước để nối · thả ra chỗ trống để tạo bước tiếp theo · nhấp đúp nền để thêm bước · chọn rồi nhấn Delete để xoá</span>
            <button type="button" onClick={hideHint} aria-label="Ẩn hướng dẫn" className="grid size-5 place-items-center rounded-full hover:bg-muted hover:text-foreground">
              <X className="size-3" />
            </button>
          </Panel>
        )}
      </ReactFlow>

      {doc.steps.length === 0 && (
        <div className="pointer-events-none absolute inset-0 grid place-items-center p-6">
          <div className="pointer-events-auto max-w-sm rounded-2xl bg-background/90 p-6 text-center shadow-sm ring-1 ring-border backdrop-blur">
            <span className="mx-auto mb-3 grid size-11 place-items-center rounded-xl bg-primary/10 text-primary">
              <WorkflowIcon className="size-5" />
            </span>
            <h2 className="text-base font-semibold">{canEdit ? "Bắt đầu vẽ workflow" : "Workflow chưa có bước nào"}</h2>
            {canEdit && (
              <>
                <p className="mt-1 text-sm text-muted-foreground">Thêm bước đầu tiên, rồi kéo từ cạnh bước để tạo các bước tiếp theo.</p>
                <Button className="mt-4" onClick={addFromToolbar}>
                  <Plus /> Thêm bước đầu tiên
                </Button>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

export function WorkflowCanvas() {
  return (
    <ReactFlowProvider>
      <Canvas />
    </ReactFlowProvider>
  );
}
