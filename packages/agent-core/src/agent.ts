// The agent: understands a message with the tools' templates, fills missing
// details by asking, offers choices when a name is ambiguous, asks for
// confirmation before any write, runs multi-step requests ("… rồi …"), hands
// everything else to the host's fallback, and learns new ways of saying
// things (see learning.ts). Framework-free: no network, no database, no LLM.

import {
  applyLessons,
  checkLesson,
  isGeneric,
  isNegativeFeedback,
  isSensitive,
  parseForget,
  parseTeaching,
  STEP_WORDS,
  type LessonCheck,
} from "./learning.ts";
import { compileTemplate, matchTemplate, type CompiledTemplate } from "./templates.ts";
import { cleanValue, fold, foldWithMap, originalSpan, tokens } from "./text.ts";
import type {
  AgentMemory,
  AgentReply,
  AgentState,
  Choice,
  ExecuteResult,
  Fallback,
  Lesson,
  LessonStore,
  Pending,
  SlotSpec,
  Tool,
  ToolOutcome,
} from "./types.ts";

export const DEFAULT_TEXT = {
  cancelled: "Đã hủy, không có thay đổi nào.",
  nothingToCancel: "Không có thao tác nào đang chờ.",
  pickFromList: "Bạn hãy chọn một mục trong danh sách (hoặc gõ số thứ tự).",
  notUnderstood: "Tôi chưa hiểu yêu cầu này. Bạn có thể nói theo một trong các cách dưới đây.",
  helpIntro: "Tôi có thể giúp bạn:",
  continueHint: "Gõ “tiếp tục” để làm bước tiếp theo:",
  nothingQueued: "Không còn bước nào đang chờ.",
  taught: (phrase: string, canonical: string) => `Đã ghi nhớ: khi bạn nói “${phrase}”, tôi sẽ hiểu là “${canonical}”.`,
  taughtShared:
    "Cách nói này sẽ được dùng cho mọi người khi đủ nhiều người dùng dạy giống bạn.",
  taughtPrivate: "Cách nói này chỉ áp dụng cho bạn (có tên riêng hoặc là thao tác thay đổi dữ liệu).",
  teachRejected: {
    sensitive: "Tôi không học các câu có e-mail, đường dẫn, số dài hay mật khẩu.",
    too_long: "Câu quá dài để học. Hãy dạy một cách nói ngắn hơn.",
    same: "Hai câu giống nhau nên không có gì để học.",
    phrase_known: "Tôi đã hiểu câu này theo một nghĩa khác nên không đổi nghĩa của nó.",
    canonical_unknown: "Tôi chưa hiểu câu đích, nên chưa học được. Hãy dùng một câu tôi đã hiểu.",
  } satisfies Record<Exclude<LessonCheck, { ok: true }>["reason"], string>,
  learningUnavailable: "Chức năng học cách nói mới chưa được bật.",
  forgot: (phrase: string) => `Đã quên cách nói “${phrase}”.`,
  forgetUnknown: (phrase: string) => `Tôi không có bài học nào cho “${phrase}”.`,
  feedbackThanks: "Cảm ơn bạn. Tôi sẽ không hiểu câu đó theo cách vừa rồi nữa.",
  feedbackNothing: "Cảm ơn bạn đã góp ý. Bạn có thể bấm 👎 dưới câu trả lời để ghi lại lý do.",
  teachSuggestion: (phrase: string, canonical: string) => `Dạy: ${phrase} => ${canonical}`,
  slotInvalid: (ask: string) => `Giá trị chưa hợp lệ. ${ask}`,
};

export type AgentText = typeof DEFAULT_TEXT;

export type AgentOptions<Ctx, R> = {
  tools: Tool<Ctx, R>[];
  /** a store, or a function returning the store for this request's context */
  lessons?: LessonStore | ((ctx: Ctx) => LessonStore | undefined);
  fallback?: Fallback<Ctx, R>;
  /** cheap check whether the fallback can handle a sentence (a lesson may lead to it) */
  fallbackUnderstands?: (folded: string) => boolean;
  /**
   * cheap check whether the fallback gives a sentence a specific meaning, so
   * it must not be redefined by a lesson. Defaults to fallbackUnderstands;
   * set it when the fallback treats any text as, say, a search.
   */
  fallbackRecognizes?: (folded: string) => boolean;
  /** words that count as agent vocabulary besides the tools' templates */
  vocabulary?: string[];
  /**
   * minimum template score (0..1, share of the message that is literal
   * template words). Templates already have to match the whole message, so
   * the default (0) only ranks matches; raise it to demand literal-heavy matches.
   */
  minScore?: number;
  text?: Partial<AgentText>;
};

export type HandleInput = {
  message: string;
  /** value of a choice the user clicked */
  choice?: string | null;
  state?: unknown;
  /** references known to the host (e.g. its own last results) */
  memory?: Partial<AgentMemory>;
};

type Understood<Ctx, R> = { tool: Tool<Ctx, R>; args: Record<string, string>; score: number };

type StepResult<R> = {
  text: string;
  reply?: Partial<R>;
  suggestions?: string[];
  choices?: Choice[];
  confirm?: AgentReply<R>["confirm"];
  clientAction?: Record<string, unknown>;
  /** needs the user before the next step can run */
  blocking: boolean;
  understood: boolean;
  tool?: string;
  handledBy: AgentReply<R>["trace"]["handledBy"];
};

const MAX_STEPS = 5;
/** a tool declined: handle the message as if no tool had matched */
const PASS = Symbol("pass");
const CANCEL = /^(?:thoi|huy|huy bo|bo qua|dung lai|khong lam nua|cancel|stop|never mind|thoi khong can|khong can nua)(?: nhe| di)?$/;
const CONTINUE = /^(?:tiep tuc|tiep|lam tiep|buoc tiep theo|continue|next)(?: di| nhe)?$/;
const HELP = /^(?:help|tro giup|huong dan|ban (?:co the )?lam (?:duoc )?(?:nhung )?gi|ban giup (?:duoc )?gi|what can you do|ban biet lam gi)$/;
const STEP_SPLIT = / (?:roi sau do|va sau do|sau do|roi thi|roi|xong roi|xong thi|then|and then|after that) /g;
const POLITE_WORDS = ["hay", "giup", "toi", "minh", "vui", "long", "ban", "nhe", "nha", "di", "a", "cho", "xin", "please", "voi", "ok", "oke", "em", "lam", "on"];
/** where a lesson may start: the beginning of a request, after polite words or "rồi" */
const LESSON_START = new Set<string>([...POLITE_WORDS, ...STEP_WORDS]);

export const EMPTY_STATE: AgentState = {
  v: 1,
  pending: null,
  queue: [],
  unresolved: null,
  lastLessons: [],
  memory: { items: [], focus: null },
  turn: 0,
};

const ENTITY = /[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9.-]{1,190}\.[A-Za-z]{2,24}|https?:\/\/[^\s"“”'<>]+|www\.[^\s"“”'<>]+/g;

/** Replaces e-mails and links by one-word placeholders (and back). */
function protectEntities(raw: string): { text: string; restore: (value: string) => string } {
  const found: string[] = [];
  const text = raw.replace(ENTITY, (m) => `qqent${found.push(m) - 1}qq`);
  if (!found.length) return { text, restore: (v) => v };
  return { text, restore: (v) => v.replace(/qqent(\d+)qq/gi, (_, i) => found[Number(i)] ?? "") };
}

const str = (v: unknown, max: number): string | null => (typeof v === "string" && v.length <= max ? v : null);
const strs = (v: unknown, maxItems: number, maxLen: number): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && x.length <= maxLen).slice(0, maxItems) : [];
const record = (v: unknown): Record<string, string> => {
  if (!v || typeof v !== "object") return {};
  const out: Record<string, string> = {};
  for (const [k, val] of Object.entries(v).slice(0, 12)) {
    if (/^[a-z_][a-z0-9_]{0,30}$/.test(k) && typeof val === "string" && val.length <= 500) out[k] = val;
  }
  return out;
};

/** Validates state coming back from the client (the host also signs it). */
export function sanitizeState(value: unknown): AgentState {
  if (!value || typeof value !== "object") return { ...EMPTY_STATE, memory: { items: [], focus: null } };
  const s = value as Record<string, unknown>;
  const m = (s.memory ?? {}) as Record<string, unknown>;
  let pending: Pending | null = null;
  const p = s.pending as Record<string, unknown> | null | undefined;
  if (p && typeof p === "object" && typeof p.tool === "string" && typeof p.slot === "string") {
    const base = { tool: p.tool.slice(0, 60), args: record(p.args), picked: record(p.picked), slot: p.slot.slice(0, 30) };
    if (p.kind === "slot") pending = { kind: "slot", ...base };
    if (p.kind === "choose" && Array.isArray(p.choices)) {
      const choices = p.choices
        .filter((c): c is Choice => !!c && typeof c === "object" && typeof c.value === "string" && typeof c.label === "string")
        .slice(0, 20)
        .map((c) => ({ value: c.value.slice(0, 200), label: c.label.slice(0, 300) }));
      if (choices.length) pending = { kind: "choose", ...base, choices };
    }
  }
  return {
    v: 1,
    pending,
    queue: strs(s.queue, MAX_STEPS, 500),
    unresolved: str(s.unresolved, 500),
    lastLessons: strs(s.lastLessons, 10, 64),
    memory: { items: strs(m.items, 50, 100), focus: str(m.focus, 100) },
    turn: typeof s.turn === "number" && Number.isFinite(s.turn) ? Math.min(Math.max(Math.trunc(s.turn), 0), 100_000) : 0,
  };
}

const ORDINAL_REF = /^(?:(?:file|tep|tai lieu|thu muc|folder|muc|cai|so) )?(?:thu |so )?(\d|nhat|dau tien|dau|hai|ba|tu|bon|nam|first|second|third)$/;
const LAST_REF = /^(?:(?:file|tep|tai lieu|thu muc|folder|muc|cai) )?(?:cuoi|cuoi cung|last)$/;
const PRONOUN_REF = /^(?:no|cai do|cai nay|file nay|file do|tep nay|tai lieu nay|tai lieu do|thu muc nay|thu muc do|it|this|that)$/;

/** True for "nó", "file thứ hai", "cái cuối cùng"… (resolvable or not). */
export function isReference(value: string): boolean {
  const f = fold(value);
  return ORDINAL_REF.test(f) || LAST_REF.test(f) || PRONOUN_REF.test(f);
}

/** “file thứ hai”, “cái cuối cùng”, “nó” → which remembered item is meant. */
export function resolveReference(value: string, memory: AgentMemory): string | null {
  const f = fold(value);
  const ordinals: Record<string, number> = {
    "1": 0, nhat: 0, dau: 0, "dau tien": 0, first: 0, "2": 1, hai: 1, second: 1, "3": 2, ba: 2, third: 2,
    "4": 3, tu: 3, bon: 3, "5": 4, nam: 4,
  };
  const ord = f.match(ORDINAL_REF);
  if (ord && ord[1] in ordinals) return memory.items[ordinals[ord[1]]] ?? null;
  if (LAST_REF.test(f)) return memory.items[memory.items.length - 1] ?? null;
  if (PRONOUN_REF.test(f)) {
    return memory.focus ?? (memory.items.length === 1 ? memory.items[0] : null);
  }
  return null;
}

function validSlot(spec: SlotSpec | undefined, value: string): string | null {
  if (spec?.multiline && (!spec.type || spec.type === "text")) {
    const text = value.replace(/^[\s"“”'‘’]+|[\s"“”'‘’]+$/gu, "");
    return text || null;
  }
  const v = cleanValue(value);
  if (!v) return null;
  switch (spec?.type) {
    case "email": {
      const m = v.match(/[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9.-]{1,190}\.[A-Za-z]{2,24}/);
      return m ? m[0].toLowerCase() : null;
    }
    case "url": {
      const m = v.match(/(?:https?:\/\/|www\.)[^\s"“”'<>]+|^[a-z0-9.-]+\.[a-z]{2,}(?:\/[^\s]*)?$/i);
      return m ? m[0] : null;
    }
    case "role": {
      const f = fold(v);
      if (/\b(chinh sua|sua|editor|edit|bien tap|ghi)\b/.test(f)) return "editor";
      if (/\b(xem|chi xem|viewer|view|doc|read)\b/.test(f)) return "viewer";
      return null;
    }
    case "number":
      return /^\d{1,9}$/.test(v) ? v : null;
    default:
      return v;
  }
}

function mergeReply<R>(a: Partial<R> | undefined, b: Partial<R> | undefined): Partial<R> | undefined {
  if (!a) return b;
  if (!b) return a;
  const out: Record<string, unknown> = { ...a };
  for (const [k, v] of Object.entries(b)) {
    const prev = out[k];
    out[k] = Array.isArray(prev) && Array.isArray(v) ? [...prev, ...v] : v;
  }
  return out as Partial<R>;
}

export function createAgent<Ctx, R = Record<string, unknown>>(options: AgentOptions<Ctx, R>) {
  const text: AgentText = { ...DEFAULT_TEXT, ...options.text };
  const minScore = options.minScore ?? 0;
  const byName = new Map(options.tools.map((t) => [t.name, t]));
  if (byName.size !== options.tools.length) throw new Error("Tool names must be unique");
  const compiled: { tool: Tool<Ctx, R>; template: CompiledTemplate }[] = options.tools.flatMap((tool) =>
    tool.patterns.map((p) => ({ tool, template: compileTemplate(p) }))
  );

  const vocabulary = new Set<string>([...POLITE_WORDS, ...(options.vocabulary ?? []).flatMap((w) => tokens(fold(w)))]);
  /** words of write tools: a synonym for one of them is a write lesson */
  const writeWords = new Set<string>();
  for (const tool of options.tools) {
    for (const p of tool.patterns) {
      for (const w of p.replace(/\{[^}]*\}/g, " ").match(/[a-z0-9]+/g) ?? []) {
        vocabulary.add(w);
        if (tool.effect === "write") writeWords.add(w);
      }
    }
  }
  const effectOf = (canonical: string): "read" | "write" =>
    understand(canonical)?.tool.effect ?? (tokens(canonical).some((w) => writeWords.has(w)) ? "write" : "read");

  /** Best tool for a message, with slot values validated by type. */
  function understand(input: string): Understood<Ctx, R> | null {
    // e-mails and links would be split into words by folding: match them as one token
    const { text: raw, restore } = protectEntities(input);
    const folded = foldWithMap(raw);
    let best: (Understood<Ctx, R> & { literals: number }) | null = null;
    for (const { tool, template } of compiled) {
      const m = matchTemplate(template, raw, folded);
      if (!m || m.score < minScore) continue;
      const args: Record<string, string> = {};
      let valid = true;
      for (const [name, value] of Object.entries(m.slots)) {
        const v = validSlot(tool.slots?.[name], restore(value));
        if (v === null) {
          valid = false;
          break;
        }
        args[name] = v;
      }
      if (!valid) continue;
      if (!best || m.score > best.score || (m.score === best.score && template.literals > best.literals)) {
        best = { tool, args, score: m.score, literals: template.literals };
      }
    }
    return best;
  }

  const understands = (folded: string) =>
    understand(folded) !== null || HELP.test(folded) || (options.fallbackUnderstands?.(folded) ?? false);
  /** phrases that must keep their meaning: anything understood, or made only of agent words */
  const recognizes = options.fallbackRecognizes ?? options.fallbackUnderstands;
  const knownPhrase = (folded: string) =>
    understand(folded) !== null ||
    HELP.test(folded) ||
    (recognizes?.(folded) ?? false) ||
    tokens(folded).every((w) => vocabulary.has(w));
  /** a sentence the agent understands, or a short synonym made of its own words ("cất" -> "chuyển") */
  const understandsTarget = (folded: string) =>
    understands(folded) || (tokens(folded).length <= 3 && isGeneric(folded, vocabulary));

  function helpReply(): StepResult<R> {
    const lines = options.tools.map((t) => `• ${t.title}: “${t.examples[0]}”`);
    return {
      text: `${text.helpIntro}\n${lines.join("\n")}`,
      suggestions: options.tools.slice(0, 6).map((t) => t.examples[0]),
      blocking: false,
      understood: true,
      handledBy: "help",
    };
  }

  /** Splits "A rồi B" into steps when at least one part is a tool request. */
  function plan(input: string): string[] {
    // a "rồi" inside free text or a link is not a step boundary
    const whole = understand(input);
    if (whole && Object.keys(whole.args).some((k) => whole.tool.slots?.[k]?.multiline || whole.tool.slots?.[k]?.type === "url")) {
      return [input];
    }
    const { text: raw, restore } = protectEntities(input);
    const folded = foldWithMap(raw);
    const padded = ` ${folded.text} `;
    const cuts: [number, number][] = [];
    for (const m of padded.matchAll(STEP_SPLIT)) cuts.push([m.index!, m.index! + m[0].length - 2]);
    if (!cuts.length) return [input];
    const parts: string[] = [];
    let from = 0;
    for (const [s, e] of cuts) {
      parts.push(originalSpan(raw, folded, from, s));
      from = e + 1;
    }
    parts.push(originalSpan(raw, folded, from, folded.text.length));
    const steps = parts.map((p) => restore(p).trim()).filter(Boolean);
    if (steps.length < 2 || !steps.some((s) => understand(s))) return [input];
    return steps.slice(0, MAX_STEPS);
  }

  /**
   * Lessons come from storage that clients can influence, so each one is
   * re-checked before use: it may not redefine anything already understood,
   * and a shared lesson may only lead to a read unless an admin approved it.
   */
  const usableCache = new Map<string, boolean>();
  function usable(lesson: Lesson): boolean {
    const key = `${lesson.scope}|${lesson.approved ? 1 : 0}|${lesson.phrase}|${lesson.canonical}`;
    let ok = usableCache.get(key);
    if (ok === undefined) {
      ok =
        !lesson.phrase.includes("qqent") &&
        !knownPhrase(lesson.phrase) &&
        understandsTarget(lesson.canonical) &&
        // a shared lesson may only use agent words (never someone's names,
        // whatever the store claims) and only lead to a read unless approved
        (lesson.scope === "mine" ||
          (isGeneric(lesson.canonical, vocabulary) && (lesson.approved === true || effectOf(lesson.canonical) === "read")));
      if (usableCache.size > 5000) usableCache.clear();
      usableCache.set(key, ok);
    }
    return ok;
  }

  return {
    tools: options.tools,
    vocabulary: vocabulary as ReadonlySet<string>,
    understand,

    /** Executes a write the user confirmed (params come back signed by the host). */
    async execute(toolName: string, params: Record<string, unknown>, ctx: Ctx): Promise<ExecuteResult> {
      const tool = byName.get(toolName);
      if (!tool?.execute || tool.effect !== "write") return { ok: false, message: "Unknown action" };
      return tool.execute(params, ctx);
    },

    async handle(input: HandleInput, ctx: Ctx): Promise<AgentReply<R>> {
      const store = typeof options.lessons === "function" ? options.lessons(ctx) : options.lessons;
      const state = sanitizeState(input.state);
      if (input.memory) {
        state.memory = {
          items: input.memory.items?.slice(0, 50) ?? state.memory.items,
          focus: input.memory.focus !== undefined ? input.memory.focus : state.memory.focus,
        };
      }
      const message = input.message.trim().slice(0, 1000);
      const folded = fold(message);
      // implicit learning only looks one turn back
      const previousUnresolved = state.unresolved;
      state.unresolved = null;
      const usedLessons: string[] = [];
      const toolsUsed: string[] = [];
      let lessonsCache: Lesson[] | null = null;
      const loadLessons = async () =>
        (lessonsCache ??= store ? (await store.list().catch(() => [] as Lesson[])).filter(usable) : []);

      const finish = (r: StepResult<R>, steps = 1): AgentReply<R> => ({
        text: r.text,
        reply: r.reply,
        suggestions: r.suggestions?.length ? [...new Set(r.suggestions)].slice(0, 6) : undefined,
        choices: r.choices,
        confirm: r.confirm,
        clientAction: r.clientAction,
        state: { ...state, lastLessons: usedLessons, turn: state.turn + 1 },
        trace: { handledBy: r.handledBy, tools: toolsUsed, lessons: usedLessons, steps },
      });

      // ---- runs one tool, turning "need more input" into pending state
      async function runTool(
        tool: Tool<Ctx, R>,
        args: Record<string, string>,
        picked: Record<string, string>
      ): Promise<StepResult<R> | typeof PASS> {
        toolsUsed.push(tool.name);
        for (const [slot, spec] of Object.entries(tool.slots ?? {})) {
          if (spec.required && !args[slot] && !picked[slot]) {
            state.pending = { kind: "slot", tool: tool.name, args, picked, slot };
            return { text: spec.ask, blocking: true, understood: true, tool: tool.name, handledBy: "dialogue" };
          }
        }
        let out: ToolOutcome<R>;
        try {
          out = await tool.run({ args, picked, ctx, memory: state.memory });
        } catch (error) {
          const msg = error instanceof Error ? error.message : "";
          return { text: msg || "Không thực hiện được yêu cầu.", blocking: true, understood: true, tool: tool.name, handledBy: "tool" };
        }
        switch (out.type) {
          case "done":
            if (out.memory) state.memory = { ...state.memory, ...out.memory };
            return {
              text: out.text,
              reply: out.reply,
              suggestions: out.suggestions,
              clientAction: out.clientAction,
              blocking: Boolean(out.clientAction),
              understood: true,
              tool: tool.name,
              handledBy: "tool",
            };
          case "ask":
            state.pending = { kind: "slot", tool: tool.name, args, picked, slot: out.slot };
            return { text: out.text, blocking: true, understood: true, tool: tool.name, handledBy: "dialogue" };
          case "choose":
            state.pending = { kind: "choose", tool: tool.name, args, picked, slot: out.slot, choices: out.choices.slice(0, 20) };
            return { text: out.text, choices: out.choices.slice(0, 20), blocking: true, understood: true, tool: tool.name, handledBy: "dialogue" };
          case "confirm":
            if (out.memory) state.memory = { ...state.memory, ...out.memory };
            return {
              text: out.title,
              confirm: { tool: tool.name, title: out.title, summary: out.summary, params: out.params, warning: out.warning },
              blocking: true,
              understood: true,
              tool: tool.name,
              handledBy: "tool",
            };
          case "error":
            return { text: out.text, blocking: true, understood: true, tool: tool.name, handledBy: "tool" };
          case "pass":
            toolsUsed.pop();
            return PASS;
        }
      }

      async function fallbackStep(raw: string): Promise<StepResult<R>> {
        if (options.fallback) {
          const fb = await options.fallback(raw, ctx, state.memory);
          if (fb.memory) state.memory = { ...state.memory, ...fb.memory };
          return { text: fb.text, reply: fb.reply, suggestions: fb.suggestions, blocking: false, understood: fb.understood, handledBy: "fallback" };
        }
        const help = helpReply();
        return { ...help, text: `${text.notUnderstood}\n${help.text.split("\n").slice(1).join("\n")}`, understood: false };
      }

      /** runs a tool; when it declines, the message goes to the fallback */
      async function runOrFallback(tool: Tool<Ctx, R>, args: Record<string, string>, picked: Record<string, string>, raw: string) {
        const r = await runTool(tool, args, picked);
        return r === PASS ? fallbackStep(raw) : r;
      }

      // ---- one step: a tool, the help, or the host's fallback
      async function runStep(raw: string): Promise<StepResult<R>> {
        const f = fold(raw);
        if (HELP.test(f)) return helpReply();
        const u = understand(raw);
        if (u) return runOrFallback(u.tool, u.args, {}, raw);
        return fallbackStep(raw);
      }

      async function runSteps(steps: string[]): Promise<{ reply: AgentReply<R>; understood: boolean }> {
        let combined: StepResult<R> | null = null;
        for (let i = 0; i < steps.length; i++) {
          const r = await runStep(steps[i]);
          combined = combined
            ? {
                ...r,
                text: `${combined.text}\n\n${r.text}`,
                reply: mergeReply(combined.reply, r.reply),
                suggestions: [...(combined.suggestions ?? []), ...(r.suggestions ?? [])],
              }
            : r;
          if (r.blocking && i < steps.length - 1) {
            state.queue = steps.slice(i + 1);
            combined = {
              ...combined,
              text: `${combined.text}\n\n${text.continueHint} “${state.queue[0]}”`,
              suggestions: ["Tiếp tục", ...(combined.suggestions ?? [])],
            };
            break;
          }
          if (!r.understood) break;
        }
        return { reply: finish(combined!, steps.length), understood: combined!.understood };
      }

      // 1. cancel
      if (CANCEL.test(folded)) {
        const had = state.pending || state.queue.length;
        state.pending = null;
        state.queue = [];
        return finish({ text: had ? text.cancelled : text.nothingToCancel, blocking: false, understood: true, handledBy: "dialogue" });
      }

      // 2. answer to a pending question / choice
      if (state.pending) {
        const pending = state.pending;
        const tool = byName.get(pending.tool);
        state.pending = null;
        const other = understand(message);
        if (tool && pending.kind === "choose") {
          const n = Number(folded.match(/^(?:so |thu |cai |muc )?(\d{1,2})$/)?.[1] ?? NaN);
          const pick =
            pending.choices.find((c) => c.value === input.choice) ??
            (Number.isInteger(n) ? pending.choices[n - 1] : undefined) ??
            pending.choices.find((c) => fold(c.label) === folded);
          if (pick) {
            return finish(
              await runOrFallback(tool, { ...pending.args, [pending.slot]: pick.label }, { ...pending.picked, [pending.slot]: pick.value }, message)
            );
          }
          // only a failed attempt to pick ("7", "số 9") asks again; anything else is a new request
          if (!other && /^(?:so |thu |cai |muc )?\d{1,2}$/.test(folded)) {
            state.pending = pending;
            return finish({ text: text.pickFromList, choices: pending.choices, blocking: true, understood: true, handledBy: "dialogue" });
          }
        }
        const spec = tool?.slots?.[pending.slot];
        // a request with its own meaning is not the answer to the question —
        // except for free text (a comment may well say "tóm tắt cuộc họp")
        const newRequest = other !== null || (!spec?.multiline && (recognizes?.(folded) ?? false));
        if (tool && pending.kind === "slot" && !newRequest && !CONTINUE.test(folded) && !parseTeaching(message)) {
          const value = validSlot(spec, message);
          if (value === null) {
            state.pending = pending;
            return finish({ text: text.slotInvalid(spec?.ask ?? ""), blocking: true, understood: true, handledBy: "dialogue" });
          }
          const picked = { ...pending.picked };
          delete picked[pending.slot];
          return finish(await runOrFallback(tool, { ...pending.args, [pending.slot]: value }, picked, message));
        }
        // anything else starts a new request
      }

      // 3. remaining steps of a multi-step request
      if (CONTINUE.test(folded)) {
        if (!state.queue.length) return finish({ text: text.nothingQueued, blocking: false, understood: true, handledBy: "dialogue" });
        const steps = state.queue;
        state.queue = [];
        return (await runSteps(steps)).reply;
      }
      state.queue = [];

      // 4. teaching, forgetting, "that was wrong"
      const teaching = parseTeaching(message);
      if (teaching) {
        if (!store) return finish({ text: text.learningUnavailable, blocking: false, understood: true, handledBy: "learning" });
        // checked on the original text: folding drops "@" and "://"
        const check = isSensitive(message) ? ({ ok: false, reason: "sensitive" } as const) : checkLesson(teaching, knownPhrase, understandsTarget);
        if (!check.ok) return finish({ text: text.teachRejected[check.reason], blocking: false, understood: true, handledBy: "learning" });
        const generic = isGeneric(teaching.canonical, vocabulary);
        const effect = effectOf(teaching.canonical);
        const saved = await store.teach({ ...teaching, effect, generic, source: "explicit" });
        return finish({
          text: `${text.taught(teaching.phrase, teaching.canonical)} ${generic && effect === "read" ? text.taughtShared : text.taughtPrivate}`,
          suggestions: saved ? [teaching.phrase] : undefined,
          blocking: false,
          understood: true,
          handledBy: "learning",
        });
      }
      const forget = parseForget(message);
      if (forget && store?.forget) {
        const all = await loadLessons();
        // forgetting a shared lesson rejects it for this user
        const lesson = all.find((l) => l.phrase === forget && l.scope === "mine") ?? all.find((l) => l.phrase === forget);
        if (lesson) await store.forget(lesson.id);
        return finish({ text: lesson ? text.forgot(forget) : text.forgetUnknown(forget), blocking: false, understood: true, handledBy: "learning" });
      }
      if (isNegativeFeedback(message)) {
        const ids = state.lastLessons;
        if (ids.length && store) await store.vote(ids, -1);
        return finish({ text: ids.length ? text.feedbackThanks : text.feedbackNothing, blocking: false, understood: true, handledBy: "learning" });
      }

      // 5. learned ways of saying things, then plan and run
      // lessons rewrite how a request starts, never names, e-mails or links in it
      const protectedMessage = protectEntities(message);
      const applied = applyLessons(protectedMessage.text, await loadLessons(), LESSON_START);
      const rewritten = { text: protectedMessage.restore(applied.text), used: applied.used };
      usedLessons.push(...rewritten.used.map((l) => l.id));
      const { reply, understood } = await runSteps(plan(rewritten.text));

      // 6. implicit learning: a message nobody understood, then a rephrasing
      //    that worked -> candidate lesson (counts towards sharing only after
      //    many users) and a one-tap suggestion to teach it explicitly
      if (!understood) {
        reply.state.unresolved = message.slice(0, 500);
      } else if (previousUnresolved && store && !rewritten.used.length) {
        const candidate = { phrase: fold(previousUnresolved), canonical: folded };
        if (!isSensitive(previousUnresolved) && !isSensitive(message) && checkLesson(candidate, knownPhrase, understandsTarget).ok) {
          const effect = effectOf(candidate.canonical);
          await store
            .teach({ ...candidate, effect, generic: isGeneric(candidate.canonical, vocabulary), source: "implicit" })
            .catch(() => null);
          reply.suggestions = [text.teachSuggestion(previousUnresolved, message), ...(reply.suggestions ?? [])].slice(0, 6);
        }
      }
      return reply;
    },
  };
}

export type Agent<Ctx, R> = ReturnType<typeof createAgent<Ctx, R>>;
