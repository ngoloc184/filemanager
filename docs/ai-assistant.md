# AI Assistant (chatbox)

A floating assistant in the signed-in app (bottom-right, or `Ctrl/⌘ + J`) that
works on the files **the current user is allowed to see**. It understands
follow-up questions, remembers what the user asks it to, answers questions
from the documents with citations, compares documents, exports results and
performs file operations after confirmation.

Design principles: **local-first, retrieval-first, AI-optional**. Without any
language model the assistant still searches, answers with quoted passages,
compares, remembers by rules and runs tools; a model (local or cloud, only if
an administrator configures one) is used only to *word* answers from passages
the user may read.

> What "learning" means here. The assistant does **not** train or fine-tune a
> model. It (1) keeps the conversation state, (2) keeps per-user memories the
> user asked for or confirmed, (3) retrieves knowledge from the user's indexed
> documents at question time, and (4) improves shared behaviour (synonyms,
> ranking weights, intent rules) through versioned tuning that an
> administrator applies only after the evaluation suite shows it is not worse.

## Architecture

```
Chat UI (assistant-widget.tsx, assistant-parts.tsx, memory-panel.tsx)
   │  POST /api/assistant/chat { message, context (signed), contextFileId? }
   ▼
Chat API — user from the session cookie; context signature checked;
   │       memory store + active tuning + model budget wired in; event logged
   ▼
Engine (engine.ts) — the reasoning loop, every turn:
   1. understand    intent.ts (rules) · memory.ts (remember/forget/prefs)
                    context.ts (“file thứ hai”, “nó”, “cả hai file”, refinements)
   2. what is known conversation context: last results, focus file, current task
   3. what is missing → plan: search names / full text / read documents / tool
   4. gather       ONLY permission-scoped read-only SQL functions (user JWT):
                    assistant_find_files · assistant_search_content ·
                    assistant_get_document · assistant_get_content ·
                    assistant_file_stats · assistant_my_shares
   5. reason       retrieval.ts: passages (articles, pages, table rows), BM25 +
                    phrase/heading/file-name signals, quantities with units,
                    superlatives, conflicts between sources, confidence,
                    prompt-injection detection · compare.ts: fact alignment
   6. answer       quotes with [n] sources, conflicts, “not enough evidence”
                    warnings, ask back when ambiguous; optional model wording
   7. act          actions.ts: proposals only (signed token) → user confirms →
                    POST /api/assistant/action runs with the user's permissions
Feedback  POST /api/assistant/feedback (👍/👎, reason, correction)
Memory    GET/POST/PATCH/DELETE /api/assistant/memory
Evaluation src/lib/assistant/eval (npm run eval:assistant)
```

### Components

| System | Where | Rules or model |
|---|---|---|
| Memory: conversation | `context.ts` — ids of the last results, focus file, last search, current task; signed per user (HMAC) and re-validated every turn | rules |
| Memory: long-term | `memory.ts`, table `assistant_memories` (RLS, max 50/user): answer style, glossary terms, notes | rules |
| Knowledge | existing per-version index `file_contents` (TXT/MD/CSV/JSON/HTML, PDF text layer with pages, DOCX headings, XLSX sheets/rows, PPTX, ODF), chunked at question time | rules |
| Retrieval | full-text search in SQL → passage ranking in `retrieval.ts` (BM25, phrases, headings, file names, synonyms from tuning, conversation boost) | rules |
| Reasoning | intent + reference resolution + plan in `engine.ts`; quantities, superlatives, conflicts, confidence in `retrieval.ts` | rules |
| Tools | find, read, summarize, compare, Q&A, stats, export (XLSX/CSV/MD/TXT), create folder, rename, move, share (viewer/editor) | rules; writes need confirmation |
| Feedback | `assistant_feedback` (keywords + reason + optional correction, review status) | — |
| Evaluation | `eval/` cases + runner; `assistant_events` metrics; SQL reports | — |
| Cost control | local by default; model only if configured; per-user daily token budget; answer cache; only top passages sent | — |

Not implemented on purpose: vector database / embeddings (full-text +
passage ranking already passes the evaluation; embeddings would add a paid or
heavy service), automatic fine-tuning, deleting files, public sharing and bulk
permission changes through the assistant.

## Conversation and memory

* Follow-ups: “Tóm tắt file thứ hai”, “file cuối cùng”, “so sánh file 1 và
  file 3”, “cả hai file”, “nó / file đó / hợp đồng này”, “còn file đầu tiên thì
  sao?”, “chỉ file PDF thôi”, “Tóm tắt nghĩa vụ thanh toán” (topic inside the
  files being discussed), “So sánh với hợp đồng năm trước”, “Xuất bảng so sánh
  ra Excel”. When a reference is ambiguous (several results, no focus) or out
  of range, the assistant asks and offers buttons.
* The context holds ids and search parameters only — never names or content.
  The server signs it; a modified, forged or other user's context is checked
  id by id and anything the user cannot open is dropped. Every file is
  permission-checked again when it is used, so a revoked share stops working
  on the next question.
* Long-term memory, per user: “Hãy nhớ HĐ nghĩa là hợp đồng”, “Từ giờ trả lời
  ngắn gọn”, “Ghi nhớ: tôi phụ trách mảng hợp đồng miền Nam”, “Bạn nhớ gì về
  tôi?”, “Quên HĐ”, “Xóa toàn bộ bộ nhớ”; also the “Bộ nhớ” panel (view, add,
  edit, delete, forget all). A definition said in passing (“BCTC là viết tắt
  của báo cáo tài chính”) is only *proposed*; it is saved if the user presses
  “Ghi nhớ”.
* Used for: answer style (summary/answer length) and glossary (abbreviations
  are expanded before searching). Notes are only recalled when asked.
* Never stored: passwords, tokens, keys, OTP, card/ID/bank numbers, long
  random strings (refused with an explanation), file content, file ids.
  Notes expire after 180 days; preferences and terms until removed.

## Answers from documents

1. Search: full-text search over documents the user can open (OR of the
   question's keywords + synonyms), plus the files of the current conversation.
2. Read: up to 6 documents through `assistant_get_document` (permission check
   per file, current version only).
3. Rank passages; extract quantities (“45 ngày”, “120.000.000 VNĐ”, “8%”).
4. Answer: verbatim quotes with `[n]` sources (file, page, section); for “bao
   lâu / bao nhiêu / dài nhất…” the value itself; conflicting values across
   files are shown side by side; low evidence → warning; no evidence → “Tôi
   không tìm thấy thông tin này…” (nothing is invented).
5. Optional model: receives the question and the quoted passages only (never
   whole files, memory or other users' data), instruction-like sentences
   removed; its text is shown separately as “Diễn giải bởi mô hình AI”, with
   the quotes kept underneath.

Prompt injection: passages that look like instructions to an AI (“ignore
previous instructions”, “bỏ qua mọi hướng dẫn”, “share all files with…”,
`<system>`…) are flagged, hidden from quotes and model input, and a notice is
shown. Actions are only ever parsed from the user's own message.

## Tools and confirmation

| Tool | Example | Check |
|---|---|---|
| Create folder | “Tạo thư mục Báo cáo 2027” | `create_folder` RPC |
| Rename | “Đổi tên file thứ hai thành …” (extension kept) | `rename_file` RPC |
| Move | “Di chuyển file này vào thư mục Báo cáo” | folder looked up by name (RLS), `move_file` RPC |
| Share | “Chia sẻ file này với a@b.com (quyền chỉnh sửa)” | `share_file` RPC, warning shown |
| Export | “Xuất bảng so sánh / danh sách / tóm tắt ra Excel/CSV/Markdown” | content rebuilt at confirmation with current permissions; upload under the user's prefix + `register_file` (quota enforced) |
| Refused | delete, public sharing, bulk permission changes | explained, done in the normal UI |

Flow: the answer shows the exact scope (“Đổi tên “A” thành “B””) and a
signed token (HMAC, bound to the user, 10 minutes, single use per instance).
Nothing changes until “Xác nhận”. The action API verifies the token against
the session user and runs with the user's permissions; the database functions
decide what is allowed. Formula-like cells are neutralized in CSV/XLSX.

## Feedback, metrics and controlled improvement

* Each answer is logged in `assistant_events` (intent, method, result count,
  grounded, confidence, latency, model calls, estimated tokens, tuning
  version, error code) — **no question text, no content**.
* 👍/👎 with reason (sai thông tin, không tìm đúng file, không liên quan,
  thiếu nguồn, chưa đầy đủ) and an optional correction (secrets refused) go to
  `assistant_feedback` with the question's keywords only and status `new`.
* Feedback never changes shared behaviour by itself. Administrator loop:

```sql
-- quality per intent (questions, latency avg/p95, found rate, grounded rate,
-- helpful / unhelpful, model calls, tokens, errors)
select * from assistant_quality_report(30);
-- keywords that keep getting negative feedback -> candidate synonyms / rules / tests
select * from assistant_feedback_terms(30, 50);
```

  1. Write a candidate tuning file (weights, thresholds, synonyms), e.g.
     `{"version":"v2","synonyms":{"hoa don":["invoice","chung tu"]}}`.
  2. `npm run eval:assistant -- --set all --tuning tuning-v2.json` and compare
     with the current numbers (no case may regress; leak failures must be 0).
     Add the failing real-world questions as cases in `eval/cases.ts` first.
  3. Store and activate:
     `insert into assistant_tuning (version, config, eval_summary) values ('v2', '<json>', '<report>');`
     `select assistant_activate_tuning('v2');`
  4. Roll back: `select assistant_activate_tuning('v1');` (or
     `update assistant_tuning set active = false where active;` for the
     built-in defaults). Servers pick up the change within a minute.
  5. Mark reviewed feedback: `update assistant_feedback set status = 'applied' where …`.
* Retention: `select * from assistant_purge(180);` deletes events (and their
  feedback) older than 180 days and expired memories — schedule it (pg_cron
  or a monthly manual run).

## Evaluation

`npm run eval:assistant` replays multi-turn conversations against an
in-memory, permission-aware database (two users, owned/shared/private files,
conflicting contracts, a prompt-injection document, a scanned PDF) and
reports pass rates per capability, data-leak failures, latency and model
calls. `--set main|holdout|all`, `--engine <path>` (compare versions),
`--tuning <file>`, `--json <out>`, `--strict` (non-zero exit on failure).
The held-out set was written after the engine and never used for tuning.

Results (same cases, previous engine from `main` vs this version):

| Set | Before | After |
|---|---|---|
| main (33 cases / 85 checks) | 9 cases (27%) · 41 checks (48%) | 33 (100%) · 85 (100%) |
| held-out (19 / 33) | 2 (11%) · 6 (18%) | 18 (95%) · 32 (97%) |
| leak failures | 0 | 0 |
| model calls / tokens | 0 | 0 |

Per capability (main set, checks): context 48% → 100%, grounded Q&A 0% →
100%, conflicts 33% → 100%, memory 50% → 100%, tools 50% → 100%, injection
50% → 100%, security 75% → 100%. Engine latency (in-memory DB) avg ≈ 3 ms,
p95 ≈ 13 ms; real latency is dominated by the database (≈ 50–80 ms per answer
in the local end-to-end run). The remaining held-out failure is a known
limit: superlatives over spreadsheet cells without units (“tháng nào chi phí
cao nhất”).

`npm test` also runs the suite as a regression gate (main set must pass
fully, held-out ≥ 90%, zero leaks).

## Permissions (the important part)

* Every assistant SQL function is `security definer`, resolves the user with
  `auth.uid()` and starts from `assistant_accessible_files()`, which mirrors
  `has_file_access()` exactly: owner, direct file share, share on the folder or
  any ancestor folder, related users (legacy), public files, short-lived link
  grants. Trashed files are excluded.
* There is no admin query that is filtered afterwards. The chat API never uses
  the service role.
* `file_contents` has RLS (`has_file_access(file_id)`); users have no write
  privileges, so nobody can inject fake index text for someone else's file.
* Only the index of the file's **current version** is searchable; a new
  version is re-queued automatically. Revoking a share takes effect on the very
  next question: cached model answers are keyed by the retrieved passages, so
  they can only be served after the user's own permission-scoped retrieval
  returned those same passages.
* `assistant_get_content` / `assistant_get_document` return nothing — not
  even the name — when the user has no access, so IDs cannot be probed.
  `contextFileId` and the conversation context from the browser are only
  hints; access is re-checked in SQL.
* `assistant_memories`, `assistant_events`, `assistant_feedback` have RLS
  “own rows only”; users cannot change a feedback's review status; tuning is
  read-only for users (active version only); reports, activation and purge are
  service-role functions. Tested in `supabase/tests/20_assistant_memory.sql`.
* User text is never turned into SQL: terms are passed as parameters and
  matched with `position()` / `websearch_to_tsquery()`.
* Conversations live only in the browser tab (`sessionStorage`, keyed by user
  id) and are cleared on sign-out or with “Xóa lịch sử”. The server keeps no
  chat transcript: only event metadata, feedback and the memories the user
  asked for.
* File content is treated as untrusted data: it is never executed, and the
  optional LLM prompt marks it as data and forbids following instructions in it.

## File summaries ("AI tóm tắt")

Open it from a file's `⋯` menu, from the preview or details dialog, or with
"Tóm tắt chi tiết" on a chat summary card. The dialog shows the file name, a
length switch (Ngắn gọn / Ý chính / Chi tiết), progress steps, then
Tổng quan · Các ý chính · Thông tin chi tiết · Việc cần thực hiện · Kết luận,
with page numbers for PDFs. Buttons: copy, re-summarize (re-reads the file),
open file, plus "Hỏi về nội dung file" (answers quote the matching passages).

Pipeline (`POST /api/assistant/summarize`, `src/lib/assistant/file-summary.ts`):

1. The user comes from the session cookie; the body only carries `fileId`
   (UUID), `length`, `refresh` and an optional `question` (≤ 300 chars).
2. `assistant_get_document(file_id)` (migration 0017, `security definer`,
   `auth.uid()`) returns the row **only if** the caller can read the file
   (same rules as `has_file_access`). Unknown and forbidden files get the same
   404, so nothing leaks. Revoking a share takes effect on the next request.
3. The text comes from the existing per-version `file_contents` index. If the
   file was updated (new version) or never indexed, it is extracted again
   once, then reused: unchanged files are never re-read.
4. Extraction: TXT/MD/CSV/JSON/HTML…, PDF (text layer, page by page),
   DOCX (headings kept), XLSX/ODS (sheet name, columns, rows), PPTX/ODP.
   A PDF without text gets "cần OCR"; images, legacy `.doc/.xls/.ppt` and
   binaries get "chưa hỗ trợ". Nothing is invented when reading fails.
5. Summary (`src/lib/assistant/digest.ts`), local and free: sentences are
   copied verbatim (numbers, dates and names unchanged) and picked across up
   to 8 parts of the document so long files are covered to the end. Tables
   get per-column statistics computed from the data. The UI says
   "Trích xuất tự động · không dùng AI bên ngoài".
6. Only if an admin configured the optional model (below), documents are
   summarized by it in chunks (map → reduce) with the content marked as
   untrusted data. Its result is cached in memory per file **version** and
   length, after the permission check; failures fall back to the local
   summary.

The route never edits, deletes or shares anything, sends `Cache-Control:
no-store`, is rate limited (20/min/user) and stops after 55 s.

## Setup

1. Run the migrations `supabase/migrations/202608280016_assistant_search.sql`,
   `202608280017_assistant_get_document.sql` and
   `202608280018_assistant_memory_feedback.sql` in the Supabase SQL editor
   (after 0001–0015). 0018 only adds tables/functions (memory, events,
   feedback, tuning); without it chat still works but memory, feedback and
   metrics are disabled. Paste the whole file (open the GitHub "Raw" view,
   Ctrl+A) — a truncated paste fails with "unterminated dollar-quoted string". It only **adds** a table,
   indexes and functions; existing tables, policies and access rules are not
   modified. It enables the `unaccent` extension (accent-insensitive Vietnamese
   search) if needed.
2. `SUPABASE_SERVICE_ROLE_KEY` must be set on the server (already required for
   public links). Without it, search by name/type/date/sharing still works, but
   content indexing is disabled and the chatbox says so.
3. Deploy. Existing files are indexed progressively (on content questions or
   with the "index now" button, 8 files per click); new uploads are indexed
   automatically.

### Optional language model (off by default)

Only summaries, file Q&A and chat answers can use a model, and only when all of these are set:

| Variable | Example |
|---|---|
| `ASSISTANT_LLM_BASE_URL` | `http://localhost:11434/v1` (Ollama), any OpenAI-compatible URL |
| `ASSISTANT_LLM_MODEL` | `qwen2.5:7b-instruct` |
| `ASSISTANT_LLM_API_KEY` | optional (cloud providers) |
| `ASSISTANT_LLM_ALLOW_FILE_CONTENT` | must be `true` to send file text to the model |

With a cloud provider, file text leaves your infrastructure and usage is
billed by that provider. Without these variables nothing is sent anywhere and
the assistant shows "Xử lý cục bộ · không dùng AI bên ngoài".

Other knobs:

| Variable | Default | Meaning |
|---|---|---|
| `ASSISTANT_MAX_INDEX_MB` | 15 | larger files are marked `too_large` and not downloaded |
| `ASSISTANT_LLM_DAILY_TOKENS` | 50000 | estimated model tokens per user per day (UTC); above it the assistant answers locally |
| `ASSISTANT_ACTION_SECRET` | derived from `SUPABASE_SERVICE_ROLE_KEY` | key for signing action tokens and the conversation context (≥ 16 chars). Without either, tools are disabled |

Cost: with no model configured every answer costs 0 tokens. With a model, a
chat answer sends the question + up to 5 quoted passages (≈ 300–1,500 input
tokens, ≤ 350 output); identical question+passages are cached per server
instance. A local model (Ollama/LM Studio, e.g. a 7B instruct model) needs
≈ 6–8 GB RAM and runs at a few seconds per answer on CPU; nothing else needs
extra resources (no vector DB, no queue).

## Operations

* Index status per file: `select status, count(*) from file_contents group by 1;`
  (`indexed`, `empty` = no text e.g. scanned PDF, `unsupported`, `too_large`,
  `failed`).
* Re-index everything (e.g. after improving extractors):
  `delete from file_contents;` — files are re-queued automatically.
* Rate limits (per server instance): chat 30 requests/min/user, indexing
  20 requests/min/user. Questions are limited to 500 characters; results are
  paginated 8 at a time (max 50 per query).
* Logs contain only failure codes — never questions, file names or content.

## Tests

* `npm run eval:assistant` — evaluation suite (see above).
* `npm test` — unit tests: conversation references, memory rules and secret
  detection, chunking, quantities, ranking, conflicts, injection, comparison,
  XLSX/CSV export (read back by the extractor), signed tokens and context,
  export rebuilt with the confirming user's permissions, plus intent parsing (all example questions from the
  brief), extraction (DOCX/XLSX/PPTX/PDF/HTML), summaries, engine behaviour
  (no DB/model calls for greetings, only whitelisted functions, no leaks for
  inaccessible files, LLM fallback), rate limiting.
* `npm run test:db` — applies `supabase/schema.sql` + all migrations to a
  throwaway PostgreSQL (with the Supabase stubs in `supabase/tests`) and runs
  `supabase/tests/10_assistant_permissions.sql` and
  `20_assistant_memory.sql` (memory/event/feedback isolation, 50-item limit,
  review status, tuning activation and rollback, reports for service role
  only, cascade on account deletion). The first file has 35 isolation checks with
  four users (owner, folder-share inheritance, direct share then revoke,
  public files, trash, outdated versions, index write protection, anonymous
  calls, and parity with `has_file_access()` for every user), plus the
  `assistant_get_document` checks (owner, stranger, folder share, revoke,
  outdated version).
  Requires `psql` and PostgreSQL 15+ with `pg_trgm`, `unaccent`, `pgcrypto`:
  `PGHOST=… PGPORT=… PGUSER=postgres npm run test:db`.

## Limits

* Intent understanding is rule-based (Vietnamese + English). Unusual phrasing
  may fall back to a keyword search or a clarifying question. Open-ended
  reasoning (“why”, “what should we do”) is limited to quoting relevant
  passages unless a model is configured.
* Answers are always in Vietnamese.
* Superlatives work on values with units (days, money, %); not yet on bare
  spreadsheet numbers. Conflict detection compares values with the same unit.
* The per-instance caches (model answers, used action tokens, rate limits)
  are best-effort on serverless platforms; signatures and database checks
  are not.
* Content search is keyword full-text (accent-insensitive), not semantic;
  "similar documents" compares top keywords. No embeddings/vector DB yet.
* Scanned PDFs/images have no text layer (no OCR). Legacy `.doc/.xls/.ppt`
  binaries are not supported.
* Up to 200,000 characters of text are indexed per file; summaries of longer
  files say they only cover the first part.
* Local summaries are extractive (selected sentences), not rewritten prose.
* The per-instance rate limiter is best-effort on serverless platforms.
