# AI Agent

The assistant chat (bottom-right, `Ctrl/⌘ + J`) now runs through an **agent**
that talks with the user and works on their files and folders: find, open a
folder, add files to folders, create, rename, move, copy, trash/restore,
share, comment, write text files and save links — and learns new ways of
saying things from all users. No language model is needed (0 tokens).

## Architecture

```
assistant-widget.tsx ── POST /api/assistant/chat ─┐
                                                   ▼
             src/lib/agent (host adapter)   ──►  packages/agent-core (reusable)
             · tools.ts   file-manager tools      · templates, dialogue, plans
             · resolve.ts names → ids (RLS)       · learning (lessons)
             · lessons.ts Supabase lesson store   · no framework / DB / LLM
             · token.ts   signed confirmations
             · index.ts   agentTurn(): sync with the engine
                    │ no tool matched
                    ▼
             src/lib/assistant/engine.ts (existing): search, questions about
             documents with citations, summaries, comparisons, exports,
             statistics, memory
```

* `packages/agent-core` is an npm workspace package. ESLint forbids it from
  importing the app, Next.js, React or Supabase, so it can be moved to other
  projects as-is (see its README).
* "Xem thêm kết quả" (paging) and memory commands ("Hãy nhớ…", "Quên…", "Bạn
  nhớ gì…") go straight to the engine.
* The agent and the engine share references: results listed by either one
  are what "file thứ hai" / "nó" refer to next.

## Tools

| Tool | Examples | Effect |
|---|---|---|
| Xem thư mục | “Xem thư mục Kế toán”, “Trong thư mục Dự án có gì?” | read |
| Thùng rác | “Xem thùng rác” | read |
| Link đã lưu | “Xem các link đã lưu” | read |
| Bình luận | “Xem bình luận của file Hợp đồng.docx” | read |
| Tải lên | “Tải file lên thư mục Kế toán”, “Thêm file vào folder Dự án” → button that opens the file picker | read (upload runs in the browser) |
| Tạo thư mục | “Tạo thư mục Hóa đơn trong thư mục Kế toán” | write |
| Chuyển / thêm file vào thư mục | “Thêm file Hợp đồng.docx vào thư mục Kế toán”, “Chuyển file thứ hai vào thư mục gốc” | write |
| Sao chép | “Sao chép file Báo cáo.pdf vào thư mục Lưu trữ” | write |
| Chuyển thư mục | “Chuyển thư mục Hóa đơn vào thư mục Kế toán” | write |
| Đổi tên | “Đổi tên file thứ hai thành Báo cáo Q3” (extension kept), “Đổi tên thư mục Cũ thành Lưu trữ” | write |
| Thùng rác | “Xóa file Bản nháp.docx”, “Xóa thư mục Cũ” (owner only, recoverable) | write |
| Khôi phục | “Khôi phục file Bản nháp.docx” | write |
| Chia sẻ | “Chia sẻ thư mục Dự án với an@example.com quyền chỉnh sửa” | write |
| Tạo file văn bản | “Tạo file todo.txt nội dung Gọi khách hàng” (content may be asked for, multi-line) | write |
| Bình luận | “Bình luận vào file Hợp đồng.docx rằng đã duyệt” | write |
| Lưu link | “Lưu link https://… tiêu đề Link cập nhật tiến độ mỗi ngày” | write |
| — | “Xóa vĩnh viễn …”, “Dọn sạch thùng rác” → refused, done on the Trash page | — |

Everything else (“Tìm báo cáo quý 3”, “Tóm tắt file thứ hai”, “So sánh…”,
“Xuất ra Excel”, “Hợp đồng có thời hạn thanh toán bao lâu?”) is answered by
the engine exactly as before (`npm run eval:assistant`: 33/33 cases).

Conversation features: asks for missing details, offers choices when a name
matches several items (with their folder), multi-step requests (“chuyển
Hợp đồng.docx vào thư mục Dự án rồi đổi tên nó thành HĐ ký”, “tiếp tục”),
cancel (“thôi”, “hủy”), `bạn làm được gì` lists the tools. A new request
replaces a pending question. When a message only looks like a command and the
file or folder it names does not exist (“copy link”, “lấy lại mật khẩu”,
“chuyển khoản vào tài khoản…”), the tool passes it on to the engine.

## Confirmation and permissions

* Every write ends in a card with the exact scope; nothing changes until
  “Xác nhận”. The card carries a token signed with HMAC (domain `agent:v1`,
  bound to the user, 10 minutes, single use per server instance) —
  `POST /api/assistant/action` verifies it and runs the tool's `execute`.
* All queries and RPCs run with the user's own session: row-level security
  and the existing security-definer functions decide what is visible and
  allowed. Names are resolved with `ilike` on RLS-protected tables, so the
  agent can only find what the user may open. The service role is never used.
* The conversation state (engine context + agent state) is signed per user;
  an unsigned agent state is discarded.
* Without `ASSISTANT_ACTION_SECRET` / `SUPABASE_SERVICE_ROLE_KEY` writes are
  shown but not offered for confirmation.

## Self-learning (shared across users)

Migration `202608280023_agent_lessons.sql`. A lesson maps something users say
to a sentence the agent already understands.

| How | Example |
|---|---|
| Teach | `Khi tôi nói "dọn rác" nghĩa là "xem thùng rác"` · `Dạy: cất => chuyển` |
| Observe | a message nobody understood, then a rephrasing that worked → stored as an observation + one-tap chip “Dạy: … => …” |
| Feedback | 👍/👎 on an answer that used lessons, or “sai rồi” |
| Forget | “Quên cách nói dọn rác” (also rejects a shared lesson for you) |

Who uses a lesson (`agent_lessons_for_me()`):

* its author, right after teaching it;
* **everyone**, when it only uses agent vocabulary (no names), it only reads
  (or an administrator approved it), at least **3** users confirmed it (or
  **5** users produced it by rephrasing), and fewer than half as many users
  rejected it;
* never a user who rejected it; never while blocked.

The agent re-checks each lesson before applying it, whatever the database
says: no redefining anything it already understands; a shared lesson must use
only agent words (no names) and lead to a read unless approved; no
e-mails/links/long numbers/passwords. Lessons only rewrite how a request
*starts* (after polite words or “rồi”) — never file names, e-mails or links
inside it. A 👍 only counts for lessons the user actually gets, and only after
the reply is confirmed to be theirs. Lessons are rewrites, so they can never
do more than the sentence they map to; writes still need confirmation.

Known limit: the sharing threshold counts distinct accounts, so several
accounts acting together can share a lesson. The checks above bound what such
a lesson can do (an unknown phrase → a generic read-only request); review
`agent_lesson_stats` and block anything odd.

Administration (SQL editor):

```sql
select * from agent_lesson_stats order by confirmed_users desc;      -- review
update agent_lessons set status = 'blocked' where id = '…';          -- stop a lesson
update agent_lessons set approved = true where id = '…';             -- share a write lesson
```

## Tests

* `packages/agent-core/src/__tests__` — templates, dialogue, plans, learning, safety.
* `src/lib/__tests__/agent-tools.test.ts` — every tool example, a table of
  real phrasings with expected slots, and a guard that none of the
  assistant's evaluation questions is captured by an agent tool.
* `src/lib/__tests__/agent-flow.test.ts` — whole conversations against an
  in-memory Supabase stand-in: confirmations, choices, missing details,
  shared references with the engine, upload, learning.
* `supabase/tests/70_agent_lessons.sql` — sharing thresholds, rejections,
  approval, observations, blocking, forgetting, no direct table access.
