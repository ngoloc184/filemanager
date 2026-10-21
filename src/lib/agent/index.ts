import "server-only";

// The file manager's agent: @ai-pro/agent-core with the file-manager tools,
// a Supabase lesson store, and the existing assistant engine as fallback for
// everything the tools do not cover (search, questions about documents,
// summaries, comparisons, exports, statistics, memory).
//
// Both share one notion of "what we are talking about": the agent's memory
// (items/focus) and the engine's conversation context (results/focus) are
// kept in sync, so "file thứ hai" means the same file whoever answered last.

import {
  createAgent,
  type AgentMemory,
  type AgentState,
  type LessonStore,
  type Tool,
} from "@ai-pro/agent-core";
// relative imports (not "@/"): the agent is unit-tested with node --test
import { parseQuestion } from "../assistant/intent.ts";
import type { ConversationContext } from "../assistant/context.ts";
import type { PendingAction } from "../assistant/actions.ts";
import type { AssistantMeta, AssistantReply } from "../assistant/types.ts";
import type { AgentCtx } from "./resolve.ts";
import { FILE_MANAGER_TOOLS } from "./tools.ts";

export type FileAgentCtx = AgentCtx & {
  lessons?: LessonStore;
  /** runs the assistant engine on a message with the shared references */
  engine: (message: string, memory: AgentMemory) => Promise<AssistantReply>;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isId = (v: unknown): v is string => typeof v === "string" && UUID.test(v);
const NOT_UNDERSTOOD = new Set(["out_of_scope", "clarify"]);

/** Words of the engine's own language: lessons made of these may be shared. */
const ENGINE_VOCABULARY = [
  "tim", "tim kiem", "liet ke", "hien thi", "file", "tep", "tai lieu", "van ban", "thu muc", "tom tat", "so sanh",
  "xuat", "excel", "csv", "markdown", "thong ke", "dung luong", "gan day", "moi nhat", "cua toi", "duoc chia se",
  "chia se", "pdf", "word", "anh", "hinh", "video", "noi dung", "hom nay", "hom qua", "tuan nay", "tuan truoc",
  "thang nay", "thang truoc", "nam nay", "nam ngoai", "bao nhieu", "link", "binh luan", "thung rac", "hop dong",
  "bao cao", "hoa don", "ke hoach", "bien ban", "de xuat", "tai chinh", "nhan su", "cong van", "quyet dinh",
];

export const fileAgent = createAgent<FileAgentCtx, AssistantReply>({
  tools: FILE_MANAGER_TOOLS as Tool<FileAgentCtx, AssistantReply>[],
  lessons: (ctx) => ctx.lessons,
  vocabulary: ENGINE_VOCABULARY,
  fallbackUnderstands: (folded) => !NOT_UNDERSTOOD.has(parseQuestion(folded).kind),
  // the engine reads any unknown words as a search, which is not a meaning a
  // lesson would override; its other intents (summaries, questions…) are
  fallbackRecognizes: (folded) => !NOT_UNDERSTOOD.has(parseQuestion(folded).kind) && parseQuestion(folded).kind !== "find",
  fallback: async (message, ctx, memory) => {
    const reply = await ctx.engine(message, memory);
    return {
      text: reply.text,
      reply,
      suggestions: reply.suggestions,
      understood: !NOT_UNDERSTOOD.has(reply.intent),
      memory: reply.context ? { items: reply.context.results, focus: reply.context.focus } : undefined,
    };
  },
});

export type AgentContext = ConversationContext & { agent?: AgentState };

export type AgentTurnInput = {
  message: string;
  /** a choice the user clicked (only used while the agent waits for one) */
  choice: string | null;
  context: ConversationContext;
  agentState: unknown;
  ctx: AgentCtx;
  lessons?: LessonStore;
  runEngine: (message: string, context: ConversationContext) => Promise<AssistantReply>;
  /** signs a confirmed write; undefined when actions are not configured */
  sign?: (tool: string, params: Record<string, unknown>) => string;
  tuningVersion: string;
};

/** True while the agent waits for the user to pick one of its choices. */
export function agentWaitsForChoice(state: unknown): boolean {
  return !!state && typeof state === "object" && (state as AgentState).pending?.kind === "choose";
}

export async function agentTurn(input: AgentTurnInput): Promise<{ reply: AssistantReply; context: AgentContext }> {
  let engineContext = input.context;
  const ctx: FileAgentCtx = {
    ...input.ctx,
    lessons: input.lessons,
    engine: async (message, memory) => {
      const reply = await input.runEngine(message, {
        ...engineContext,
        results: memory.items.filter(isId),
        focus: isId(memory.focus) ? memory.focus : null,
      });
      if (reply.context) engineContext = reply.context;
      return reply;
    },
  };

  const out = await fileAgent.handle(
    {
      message: input.message,
      choice: input.choice,
      state: input.agentState,
      memory: { items: engineContext.results, focus: engineContext.focus },
    },
    ctx
  );

  const { context: _engineOwnContext, ...base } = (out.reply ?? {}) as Partial<AssistantReply>;
  void _engineOwnContext;
  const lastTool = out.trace.tools[out.trace.tools.length - 1];
  const intent =
    out.trace.handledBy === "fallback"
      ? (base.intent ?? "out_of_scope")
      : out.trace.handledBy === "tool" && lastTool
        ? `agent:${lastTool}`
        : out.trace.handledBy === "help"
          ? "help"
          : `agent:${out.trace.handledBy}`;

  let text = out.text;
  let action: PendingAction | null = base.action ?? null;
  if (out.confirm) {
    if (input.sign) {
      action = {
        kind: `agent:${out.confirm.tool}`,
        title: out.confirm.title,
        summary: out.confirm.summary,
        params: {},
        token: input.sign(out.confirm.tool, out.confirm.params),
        warning: out.confirm.warning,
      };
      text = text === out.confirm.title ? "Bạn kiểm tra và xác nhận giúp tôi:" : text;
    } else {
      text = `${out.confirm.summary}\nThao tác thay đổi dữ liệu chưa được bật trên máy chủ (cần ASSISTANT_ACTION_SECRET hoặc SUPABASE_SERVICE_ROLE_KEY).`;
    }
  }

  const meta: AssistantMeta = base.meta ?? {
    method: out.trace.handledBy === "tool" ? `agent:${lastTool ?? "tool"}` : `agent:${out.trace.handledBy}`,
    resultCount: (base.files?.length ?? 0) + (base.folders?.length ?? 0),
    grounded: null,
    confidence: null,
    llmCalls: 0,
    tokensEst: 0,
    tuningVersion: input.tuningVersion,
  };

  const upload =
    out.clientAction?.kind === "upload"
      ? {
          folderId: isId(out.clientAction.folderId) ? out.clientAction.folderId : null,
          folderName: typeof out.clientAction.folderName === "string" ? out.clientAction.folderName : "My Files",
        }
      : undefined;

  const reply: AssistantReply = {
    ...base,
    intent: intent.slice(0, 40),
    text,
    engine: base.engine ?? "local",
    suggestions: out.suggestions ?? base.suggestions,
    choices: out.choices ? out.choices.map((c) => ({ fileId: c.value, label: c.label })) : base.choices,
    action,
    upload,
    lessonIds: out.trace.lessons.length ? out.trace.lessons : undefined,
    meta,
  };

  const context: AgentContext = {
    ...engineContext,
    results: out.state.memory.items.filter(isId).slice(0, 20),
    focus: isId(out.state.memory.focus) ? out.state.memory.focus : null,
    agent: out.state,
  };
  return { reply, context };
}

export { createLessonStore } from "./lessons.ts";
export { signAgentAction, verifyAgentAction, AGENT_TOKEN_PREFIX } from "./token.ts";
