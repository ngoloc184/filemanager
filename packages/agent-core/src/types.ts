// Public types of the agent. The host application provides tools, a lesson
// store and (optionally) a fallback for everything the tools do not cover.
// `Ctx` is whatever the host's tools need per request (database client, user);
// `R` is the host's rich reply shape (file lists, tables, …), passed through.

export type SlotType = "text" | "email" | "url" | "role" | "number";

export type SlotSpec = {
  type?: SlotType;
  required?: boolean;
  /** free text (comments, file content): keep line breaks and punctuation */
  multiline?: boolean;
  /** question asked when a required slot is missing */
  ask: string;
};

/** What the agent remembers between turns for references ("file thứ hai", "nó"). */
export type AgentMemory = {
  /** ids of the last list shown, in display order */
  items: string[];
  /** the item "it" refers to */
  focus: string | null;
};

export type Choice = { value: string; label: string };

export type ToolInput<Ctx> = {
  /** slot values typed by the user (original spelling) */
  args: Record<string, string>;
  /** slot values the user picked from a list of choices (ids) */
  picked: Record<string, string>;
  ctx: Ctx;
  memory: AgentMemory;
};

export type ToolOutcome<R> =
  | {
      type: "done";
      text: string;
      reply?: Partial<R>;
      suggestions?: string[];
      /** new memory for references in the next turns */
      memory?: Partial<AgentMemory>;
      /** something the client must do itself (e.g. open a file picker) */
      clientAction?: Record<string, unknown>;
    }
  | { type: "ask"; slot: string; text: string }
  /**
   * the message only looked like this tool (e.g. the file it names does not
   * exist): let the fallback handle it as if no tool had matched
   */
  | { type: "pass" }
  | { type: "choose"; slot: string; text: string; choices: Choice[] }
  | {
      type: "confirm";
      title: string;
      /** exact scope of the change, shown before the user confirms */
      summary: string;
      /** everything needed to execute later; signed by the host */
      params: Record<string, unknown>;
      warning?: string;
      /** what "it" refers to next (e.g. the file being changed) */
      memory?: Partial<AgentMemory>;
    }
  | { type: "error"; text: string };

export type ExecuteResult = { ok: boolean; message: string; openUrl?: string };

export type Tool<Ctx, R> = {
  name: string;
  title: string;
  description: string;
  /** "write" tools always end in a confirmation before anything changes */
  effect: "read" | "write";
  patterns: string[];
  /** natural examples: help text, suggestions and tests */
  examples: string[];
  slots?: Record<string, SlotSpec>;
  run(input: ToolInput<Ctx>): Promise<ToolOutcome<R>>;
  /** runs a confirmed write with the params produced by run() */
  execute?(params: Record<string, unknown>, ctx: Ctx): Promise<ExecuteResult>;
};

export type Lesson = {
  id: string;
  /** folded words the user says */
  phrase: string;
  /** folded words the agent already understands */
  canonical: string;
  /** "mine": taught by this user · "global": learned from many users */
  scope: "mine" | "global";
  /** an administrator allowed sharing this lesson although it leads to a write */
  approved?: boolean;
};

export type TeachInput = {
  phrase: string;
  canonical: string;
  effect: "read" | "write";
  /** canonical uses only the agent's own vocabulary (no names or values) */
  generic: boolean;
  source: "explicit" | "implicit";
};

/** Persistence for learned lessons (shared across users by the host). */
export interface LessonStore {
  list(): Promise<Lesson[]>;
  teach(input: TeachInput): Promise<Lesson | null>;
  vote(lessonIds: string[], vote: 1 | -1): Promise<void>;
  forget?(lessonId: string): Promise<void>;
}

/** Result of the host's own engine for messages no tool understood. */
export type FallbackResult<R> = {
  text: string;
  reply?: Partial<R>;
  suggestions?: string[];
  /** false when the fallback did not understand the message either */
  understood: boolean;
  memory?: Partial<AgentMemory>;
};

export type Fallback<Ctx, R> = (message: string, ctx: Ctx, memory: AgentMemory) => Promise<FallbackResult<R>>;

export type Pending =
  | { kind: "slot"; tool: string; args: Record<string, string>; picked: Record<string, string>; slot: string }
  | { kind: "choose"; tool: string; args: Record<string, string>; picked: Record<string, string>; slot: string; choices: Choice[] };

/** Conversation state; the host stores it (signed) between turns. */
export type AgentState = {
  v: 1;
  pending: Pending | null;
  /** remaining steps of a multi-step request */
  queue: string[];
  /** last message nobody understood, for implicit learning */
  unresolved: string | null;
  /** lessons used for the previous answer (for "sai rồi" feedback) */
  lastLessons: string[];
  memory: AgentMemory;
  turn: number;
};

export type AgentReply<R> = {
  text: string;
  reply?: Partial<R>;
  suggestions?: string[];
  choices?: Choice[];
  confirm?: { tool: string; title: string; summary: string; params: Record<string, unknown>; warning?: string };
  clientAction?: Record<string, unknown>;
  state: AgentState;
  trace: {
    handledBy: "tool" | "fallback" | "dialogue" | "learning" | "help";
    tools: string[];
    lessons: string[];
    steps: number;
  };
};
