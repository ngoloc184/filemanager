# Chat

Real-time direct messages between two users, in a floating widget on every
page (the chat button bottom-right, next to the AI Assistant; the red badge
counts unread messages). Opening one widget closes the other.

* **Start**: the widget lists the people you chatted with; add someone new by
  typing their e-mail at the top. Each pair of users has one conversation;
  adding them again opens it.
* **Notes to self**: type your own e-mail (or use the “Notes to self” button)
  to keep messages and files for yourself; it is listed as “… (you)”, without
  unread counts or “Seen”.
* **Send**: text (Enter sends, Shift+Enter adds a line, up to 4,000
  characters), a file from **My Files**, or files uploaded from the device
  (stored in your **Chat** folder). Sending a file gives the other person view
  access to it; an existing share is never reduced. Only files you own or
  manage can be sent.
* **Real time**: new messages, unsends and “Seen” appear without reloading
  (Supabase Realtime, `postgres_changes`). The chat button shows the number of
  unread messages, and a toast (“Open”) appears when a message arrives while
  that conversation is not on screen.
* **Unsend**: hover your message → trash icon; the text and file link are
  removed for both people.
* From code: `openChat({ email })` or `openChat({ conversationId })`
  (`src/components/chat/chat-widget.tsx`) opens the widget.

## Setup

Run migration `202608280025_chat.sql`. It adds `chat_messages` and
`chat_members` to the `supabase_realtime` publication (Realtime is on by
default in Supabase projects; check Database → Publications if messages only
appear after a reload). Free plan limits that apply: 200 concurrent Realtime
connections and 2 million Realtime messages per month.

## Security

* Row-level security: only the two members can read a conversation, its
  members and its messages; Realtime applies the same policies, so events of
  other conversations are never delivered.
* No direct writes: `start_chat`, `send_chat_message`, `delete_chat_message`
  and `mark_chat_read` check membership; sending is limited to 30 messages per
  minute per user.
* File access goes through the normal sharing rules (`file_shares`), visible
  and revocable in the file's Share dialog.

Tests: `supabase/tests/90_chat.sql` (membership, outsiders, file sharing
without downgrades, unread counts, unsend, rate limit) and
`src/lib/__tests__/chat-format.test.ts`.
