# AI Assistant (chatbox)

A floating assistant in the signed-in app (bottom-right, or `Ctrl/⌘ + J`) that
answers natural-language questions about the files **the current user is
allowed to see**: search by name, type, date, sharing scope or content,
statistics, "what did I share with X", local summaries and similar documents.

Design principles: **local-first, database-first, AI-optional**. Common
questions never call an external AI service and cost no tokens.

## Architecture

```
Chatbox UI (src/components/assistant/assistant-widget.tsx)
   │  POST /api/assistant/chat { message, page?, contextFileId? }
   ▼
Chat API (src/app/api/assistant/chat/route.ts)
   │  user from the session cookie (never from the request body)
   ▼
Engine (src/lib/assistant/engine.ts)
   ├─ Intent resolver (intent.ts) — rules, no LLM: find / content / stats /
   │  my_shares / summarize / similar / help / clarify / out_of_scope
   ├─ calls ONLY these read-only SQL functions, with the user's own JWT:
   │    assistant_find_files · assistant_search_content · assistant_file_stats
   │    assistant_my_shares  · assistant_get_content    · assistant_index_candidates
   ├─ Summaries: local extractive summary (summarize.ts); optional LLM
   └─ Response: structured JSON (files, shares, stats, summary, suggestions)

Indexer (src/lib/assistant/indexer.ts, POST /api/assistant/index)
   ├─ picks files the user can open whose current version is not indexed
   ├─ downloads the object WITH THE USER'S SESSION (storage policies apply)
   ├─ extracts text (extract.ts): TXT/MD/CSV/JSON/HTML/…, PDF (text layer),
   │  DOCX, XLSX, PPTX, ODT/ODS/ODP
   └─ writes public.file_contents with the service role (users cannot write)
```

Indexing is triggered automatically after every upload / new version, lazily
(up to 3 files) before content searches, and on demand from the chatbox
("Lập chỉ mục nội dung ngay").

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
  next question (no caches).
* `assistant_get_content` returns nothing — not even the name — when the user
  has no access, so IDs cannot be probed. `contextFileId` from the browser is
  only a hint; access is re-checked in SQL.
* User text is never turned into SQL: terms are passed as parameters and
  matched with `position()` / `websearch_to_tsquery()`.
* Conversations live only in the browser tab (`sessionStorage`, keyed by user
  id) and are cleared on sign-out. Nothing is stored server-side.
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

1. Run the migrations `supabase/migrations/202608280016_assistant_search.sql`
   then `202608280017_assistant_get_document.sql` in the Supabase SQL editor
   (after 0001–0015). Paste the whole file (open the GitHub "Raw" view,
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

Only summaries and file Q&A can use a model, and only when all of these are set:

| Variable | Example |
|---|---|
| `ASSISTANT_LLM_BASE_URL` | `http://localhost:11434/v1` (Ollama), any OpenAI-compatible URL |
| `ASSISTANT_LLM_MODEL` | `qwen2.5:7b-instruct` |
| `ASSISTANT_LLM_API_KEY` | optional (cloud providers) |
| `ASSISTANT_LLM_ALLOW_FILE_CONTENT` | must be `true` to send file text to the model |

With a cloud provider, file text leaves your infrastructure and usage is
billed by that provider. Without these variables nothing is sent anywhere and
the assistant shows "Xử lý cục bộ · không dùng AI bên ngoài".

Other knobs: `ASSISTANT_MAX_INDEX_MB` (default 15) — larger files are marked
`too_large` and not downloaded for indexing.

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

* `npm test` — unit tests: intent parsing (all example questions from the
  brief), extraction (DOCX/XLSX/PPTX/PDF/HTML), summaries, engine behaviour
  (no DB/model calls for greetings, only whitelisted functions, no leaks for
  inaccessible files, LLM fallback), rate limiting.
* `npm run test:db` — applies `supabase/schema.sql` + all migrations to a
  throwaway PostgreSQL (with the Supabase stubs in `supabase/tests`) and runs
  `supabase/tests/10_assistant_permissions.sql`: 35 isolation checks with
  four users (owner, folder-share inheritance, direct share then revoke,
  public files, trash, outdated versions, index write protection, anonymous
  calls, and parity with `has_file_access()` for every user), plus the
  `assistant_get_document` checks (owner, stranger, folder share, revoke,
  outdated version).
  Requires `psql` and PostgreSQL 15+ with `pg_trgm`, `unaccent`, `pgcrypto`:
  `PGHOST=… PGPORT=… PGUSER=postgres npm run test:db`.

## Limits

* Intent understanding is rule-based (Vietnamese + English). Unusual phrasing
  may fall back to a keyword search or a clarifying question.
* Content search is keyword full-text (accent-insensitive), not semantic;
  "similar documents" compares top keywords. No embeddings/vector DB yet.
* Scanned PDFs/images have no text layer (no OCR). Legacy `.doc/.xls/.ppt`
  binaries are not supported.
* Up to 200,000 characters of text are indexed per file; summaries of longer
  files say they only cover the first part.
* Local summaries are extractive (selected sentences), not rewritten prose.
* The per-instance rate limiter is best-effort on serverless platforms.
