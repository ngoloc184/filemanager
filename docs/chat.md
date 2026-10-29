# Chat

Real-time messages with one person or a group, in a floating widget on every
page (the chat button bottom-right, next to the AI Assistant; the red badge
counts unread messages). Opening one widget closes the other.

**Expand** (⤢ in the header, as in Messenger): the chat fills most of the
screen, with the conversation list beside the open conversation on wide
screens; ⤡ shrinks it again. The choice is remembered in this browser.
Selected text in a message is shown in a strong colour (white on your own
messages, the brand colour on others'), so it is clear what will be copied.

## Conversations

* **Direct**: add someone by typing their e-mail at the top. Each pair of
  users has one conversation; adding them again opens it.
* **Notes to self**: the “Notes to self” button (or your own e-mail) keeps
  messages and files for yourself, without unread counts or “Seen”.
* **Groups**: **New group** → name + member e-mails (up to 200 members). The
  creator is the **owner**. The group header opens **Group info**:
  * picture, name and background (12 presets or an uploaded picture);
  * members: owners and **admins** add and remove members; only the owner
    appoints or dismisses admins, hands the group over (crown icon) or
    disbands it; nobody can remove the owner, and admins cannot remove
    other admins;
  * by default every member may change the name, picture, background and
    pins; the owner can restrict that to the owner and admins;
  * leave the group (the owner hands it over first, unless nobody else is
    left). Changes appear in the conversation as system lines (“Bob added
    Carol”).

## Messages

* **Send**: Enter sends, Shift+Enter adds a line (up to 4,000 characters);
  emoji from the 🙂 button; files from **My Files** or the device (stored in
  your **Chat** folder). Everyone in the conversation gets view access to a
  file you send; an existing share is never reduced. Only files you own or
  manage can be sent.
* **Pictures** (JPG, PNG, GIF, WebP, AVIF, SVG, BMP up to 10 MB) are shown
  in the message itself; click one to open it large, hover for download.
  Larger or other image types (HEIC, TIFF) show the usual file card. Links
  for all pictures on screen are requested together and reused for an hour.
* **Instant**: a message is shown the moment you press Enter and confirmed by
  the server a moment later (spinner); sends go out in order. If one fails it
  says “Not sent · Retry”.
* **Stickers**: the sticker button opens ~1,600 3D stickers in groups, with
  recently used ones first and a search box (Vietnamese or English: “vui”,
  “cảm ơn”, “cat”). While typing a short message, matching stickers are
  suggested above the box, like Zalo (“haha”, “cảm ơn”, “buồn quá”, “ok”, an
  emoji such as 😂); tapping one sends it instead of the words. The stickers
  are Microsoft Fluent Emoji (MIT license, `public/stickers/fluent/LICENSE.txt`),
  built with `node scripts/build-stickers.mjs <fluentui-emoji checkout>`;
  Vietnamese words are in `src/lib/stickers/suggest.ts`.
* **Reply**: hover a message → ↩. The quote above the reply jumps to the
  original.
* **@mention** (groups): type `@` and pick a member; their name is
  highlighted and they get a notification saying they were mentioned.
* **Reactions**: hover → 🙂+ → 👍 ❤️ 😆 😮 😭 😡 (one per person; the same
  emoji again removes it). Hover a reaction to see who reacted.
* **Pin**: hover → 📌 (up to 3 per conversation). Pins show in a bar at the
  top; click one to jump to it.
* **Copy**, **Unsend** (your own messages: text, file link, reactions and
  pins are removed for everyone).
* **Typing** (“Bob is typing…”) and **Seen** (direct: “Seen”; groups: the
  pictures of the members who read your last message).

## Profile

Click your name at the bottom of the sidebar to set a **display name** and a
**profile picture** (JPG, PNG, WebP or GIF up to 5 MB, resized in the browser
to 512 px WebP). Chats show the display name, or the e-mail when there is none.

## Notifications

After sign-in a prompt asks **“Get notified of new messages?”** (again a week
after “Later”, never once the browser was asked). **Turn on** asks the
browser for permission, turns notifications on for the account (the 🔔 in the
chat header switches them off and on, saved in `user_preferences`) and
subscribes this device to **Web Push**.

* New messages from others reach the device's notification center (Windows,
  macOS, Android, installed iPhone app) — also when the site is closed, as
  long as the browser itself is running. While the app is open they show as
  well, together with the in-app toast, except for the conversation being
  read.
* How it works: after a message is saved, the sender's app calls
  `POST /api/push/chat`; the server (service role) sends it once
  (`chat_push_log`) to the subscribed devices (`push_subscriptions`) of the
  other members who have notifications on, and drops devices the browser
  unsubscribed. `public/sw.js` shows the push and opens the conversation when
  clicked; it closes a push for the conversation on screen.
* Signing out removes this browser's subscription, so the next account on the
  same browser does not get the previous one's messages.
* Without VAPID keys (below) the app falls back to notifications shown by the
  open page only.
* iPhone: add the site to the Home Screen first (iOS 16.4+). [Inference] A
  message sent while the sender's tab is closing may miss its push (the call
  uses `keepalive`, but browsers can drop it).

## Setup

1. Run migrations `202608280025_chat.sql`, `202608280026_user_preferences.sql`,
   `202608280027_chat_groups.sql`, `202608280028_web_push.sql` and
   `202608280029_chat_stickers.sql` in order.
2. Web Push: run `npm run push:keys` and put the three printed lines
   (`NEXT_PUBLIC_VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT`) in
   `.env.local` and in the host's environment (Vercel → Settings →
   Environment Variables), together with `SUPABASE_SERVICE_ROLE_KEY`, then
   redeploy. Keep the private key secret.
3. Realtime: the migrations add `chat_messages`, `chat_members`,
   `chat_reactions` and `chat_pins` to the `supabase_realtime` publication
   (check Database → Publications if changes only appear after a reload).
   The app listens to INSERT and UPDATE events only: Realtime cannot filter
   DELETE events or check row-level security for them, so removed reactions
   are updates (`emoji = null`) and pins and group changes arrive as system
   messages. After a dropped connection (sleep, network change) or when the
   tab comes back, the open conversation and the list are reloaded.
4. Storage: migration 027 creates the public bucket `public-images` (5 MB,
   images only) with write policies for `users/<your id>/…` and
   `groups/<group id>/…`.
5. Optional hardening: in **Realtime → Settings**, turn off **Allow public
   access** so the typing channel (`typing:<conversation id>`) is limited to
   members by the policies in migration 027. Until then typing events of a
   conversation could be received by anyone who knows its id (they only
   contain a user id).

Free plan limits that apply: 200 concurrent Realtime connections and
2 million Realtime messages per month.

## Security

* Row-level security: only members can read a conversation, its members,
  messages, reactions and pins; Realtime applies the same policies.
* No direct writes: every change goes through functions that check
  membership and roles (`send_chat_message`, `react_chat_message`,
  `pin_chat_message`, `create_chat_group`, `remove_chat_member`, …);
  sending is limited to 30 messages per minute per user.
* Only members can be mentioned or replied to; a reply must be in the same
  conversation.
* File access goes through the normal sharing rules (`file_shares`), visible
  and revocable in the file's Share dialog.

Tests: `supabase/tests/90_chat.sql`, `95_user_preferences.sql`,
`97_chat_groups.sql`, and `src/lib/__tests__/chat-format.test.ts`,
`chat-groups.test.ts`, `chat-notify.test.ts`.
