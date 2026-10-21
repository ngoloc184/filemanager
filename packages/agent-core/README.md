# @ai-pro/agent-core

A conversational agent for applications, **without a language model**:
template-based understanding (Vietnamese-aware), slot filling, choices,
confirmation before any write, multi-step requests and **shared
self-learning**. No dependencies, no network, no framework — the host
application plugs in its own tools and storage.

```
message ─► cancel / answer to a pending question / teaching / "sai rồi"
        ─► learned lessons rewrite the message
        ─► plan: "A rồi B" → steps
        ─► each step: best matching tool ─► run ─► done | ask | choose | confirm | error
                       no tool          ─► host fallback (optional)
        ─► implicit learning: "<not understood>" then a rephrasing that worked
```

## Install

Inside this repository it is an npm workspace (`packages/agent-core`). To
reuse it elsewhere, copy the folder (or publish it) and add it as a
dependency. It ships TypeScript sources: Node ≥ 22.6 runs them directly;
Next.js needs `transpilePackages: ["@ai-pro/agent-core"]`.

```bash
npm test --workspace @ai-pro/agent-core   # unit tests (node:test)
```

## Quick start

```ts
import { createAgent, type Tool } from "@ai-pro/agent-core";

type Ctx = { db: MyDb; userId: string };

const moveFile: Tool<Ctx, MyReply> = {
  name: "move_file",
  title: "Move a file into a folder",
  description: "",
  effect: "write", // writes always end in a confirmation
  patterns: ["(chuyen|dua|them) {file} (vao|sang) (thu muc|folder)? {folder}"],
  examples: ["Chuyển Hợp đồng.docx vào thư mục Kế toán"],
  slots: {
    file: { required: true, ask: "Bạn muốn chuyển file nào?" },
    folder: { required: true, ask: "Vào thư mục nào?" },
  },
  async run({ args, picked, ctx, memory }) {
    const files = await ctx.db.findFiles(args.file);
    if (files.length > 1) {
      return { type: "choose", slot: "file", text: "File nào?", choices: files.map((f) => ({ value: f.id, label: f.name })) };
    }
    // …resolve the folder the same way…
    return { type: "confirm", title: "Chuyển file", summary: `Chuyển “${files[0].name}” vào …`, params: { fileId: files[0].id, folderId } };
  },
  async execute(params, ctx) {
    await ctx.db.moveFile(params.fileId as string, params.folderId as string);
    return { ok: true, message: "Đã chuyển." };
  },
};

const agent = createAgent<Ctx, MyReply>({
  tools: [moveFile /* … */],
  lessons: (ctx) => myLessonStore(ctx), // optional: self-learning
  fallback: async (message, ctx) => ({ text: "…", understood: false }), // optional
});

// one turn: keep `reply.state` (sign it!) and send it back with the next message
const reply = await agent.handle({ message, choice, state }, ctx);
// after the user confirmed reply.confirm (sign tool+params, verify on return):
await agent.execute(reply.confirm.tool, reply.confirm.params, ctx);
```

### Templates

Templates match the **whole message** on folded text (lower case, no
accents, `đ`→`d`, punctuation as spaces). Polite words around a request
("hãy", "giúp tôi", "nhé", "ạ", "please"…) are accepted automatically.

| Syntax | Meaning |
|---|---|
| `word` | literal word (folded) |
| `(a\|b c)` | one of the alternatives · `(…)?` optional |
| `{name}` | slot, one or more words · `{name?}` optional slot |

Slot values come back with the user's original spelling ("Báo cáo Q3.pdf").
E-mails and links are protected while matching. Slot `type` validates and
normalizes values: `email`, `url`, `role` (`viewer`/`editor`), `number`;
`multiline: true` keeps line breaks for free text. When several templates
match, the one with the most literal words wins.

### Dialogue

* Missing required slot → asks `slot.ask`; the next message fills it (unless
  it is a new request of its own).
* A tool may return `{ type: "pass" }` (e.g. the file it names does not
  exist): the message then goes to the fallback as if no tool had matched.
* `choose` → the user clicks a choice (`choice` in the next `handle()`), types
  its number, or its label.
* `confirm` → nothing happens until the host executes the signed params.
* "thôi / hủy / cancel" cancels; a new request replaces a pending question.
* "A rồi B" runs steps in order and stops at the first step that needs the
  user; "tiếp tục" resumes.
* References: `resolveReference("file thứ hai", memory)` → id from the last
  list (`memory.items`) or the focus ("nó", "file đó").

### Self-learning

A **lesson** maps a phrase to a sentence the agent understands.

* Explicit: `Khi tôi nói "dọn rác" nghĩa là "xem thùng rác"`, `Dạy: cất => chuyển`.
* Implicit: a message nobody understood followed by a rephrasing that worked
  is stored as an observation and offered as a one-tap “Dạy: … => …”.
* Feedback: "sai rồi" (or the host's 👎) votes against the lessons used.
* "Quên cách nói X" forgets a personal lesson.

Safety, enforced by the core at teach **and** apply time:

* a phrase that is already understood (a tool, the fallback's specific
  meaning, or only agent vocabulary) can never be redefined;
* lessons with e-mails, links, long numbers or passwords are refused;
* a shared (global) lesson is only applied if it leads to a read, unless the
  store marks it `approved`;
* a shared lesson must be generic (only agent vocabulary), whatever the store says;
* lessons only rewrite how a request starts (after polite words or "rồi"),
  never names, e-mails or links inside it;
* lessons are rewrites, so they can never do more than the canonical
  sentence — writes still need confirmation.

Who sees a lesson is the store's decision (`LessonStore.list()`): e.g. the
author immediately, everyone once N different users confirmed it. The host
in this repository implements that in SQL
(`supabase/migrations/202608280023_agent_lessons.sql`).

```ts
interface LessonStore {
  list(): Promise<Lesson[]>;                  // lessons for the current user
  teach(input: TeachInput): Promise<Lesson | null>;
  vote(lessonIds: string[], vote: 1 | -1): Promise<void>;
  forget?(lessonId: string): Promise<void>;
}
```

### Host responsibilities

* Sign the state you send to the client and discard unsigned state.
* Sign `confirm.tool` + `confirm.params`, verify them (user, expiry, single
  use) before `execute()`.
* Enforce permissions in `run()`/`execute()` (the core trusts tools).
* Localize texts with `createAgent({ text: { … } })` (defaults: Vietnamese).

## API

| Export | Purpose |
|---|---|
| `createAgent(options)` | `{ handle, execute, understand, tools, vocabulary }` |
| `sanitizeState(value)` | validates state coming back from a client |
| `resolveReference(text, memory)` | ordinal / pronoun references |
| `parseTeaching`, `parseForget`, `applyLessons`, `checkLesson`, `isGeneric`, `isSensitive` | learning building blocks |
| `compileTemplate`, `matchTemplate` | templates on their own |
| `fold`, `foldWithMap`, `originalSpan`, `cleanValue` | text utilities |

License: MIT.
