"use client";

// Floating chat (bottom-right, next to the AI Assistant): a launcher with the
// unread count, the list of conversations (people and groups), a field to
// start a chat with anyone by e-mail, group creation, and the conversation
// itself — all in one panel.
//
// Speed: a message shows up the moment it is sent (its id is chosen here and
// confirmed by the server), sends go out in order, and incoming changes are
// applied straight from the Realtime event instead of reloading the thread.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { toast } from "sonner";
import { ArrowLeft, Check, CheckCheck, Info, Loader2, Maximize2, MessagesSquare, Minimize2, Minus, NotebookPen, Plus, Users, X } from "lucide-react";
import { PreviewDialog } from "@/components/files/file-dialogs";
import { announceWidget, onOtherWidget } from "@/components/floating-widgets";
import { NotificationBanner, NotificationToggle, useChatNotifications } from "@/components/chat/chat-notifications";
import { Composer, type MentionCandidate } from "@/components/chat/chat-composer";
import { FilePicker, iconButton } from "@/components/chat/chat-file";
import { InfoView, NewGroupView } from "@/components/chat/chat-group";
import { MessageRow, PinnedBar, SystemRow } from "@/components/chat/chat-message";
import { UserAvatar } from "@/components/chat/user-avatar";
import {
  createGroup,
  deleteMessage,
  joinTyping,
  listChats,
  listMembers,
  listMessages,
  listPins,
  markRead,
  pinMessage,
  reactToMessage,
  sendMessage,
  sendUploads,
  startChat,
  subscribeToChats,
  subscribeToConversation,
  unpinMessage,
  unreadCount,
  type ChatMember,
  type ChatMessage,
  type ChatMessageEvent,
  type ChatPin,
  type ChatSummary,
} from "@/lib/services/chat";
import type { PreviewableFile } from "@/lib/services/files";
import { publicImageUrl, useMyProfile } from "@/lib/services/profile";
import { canEditGroup, chatTitle, groupByDay, listTime, mergeMessages, messagePreview, personName, toTime } from "@/lib/chat-format";
import { notificationContent, notifyChannels } from "@/lib/chat-notify";
import { backgroundStyle } from "@/lib/chat-themes";
import { notificationPermission, onNotificationClick, pageActive, showSystemNotification } from "@/lib/system-notifications";
import { getErrorMessage } from "@/lib/types/database";
import { cn } from "@/lib/utils";

const PAGE = 50;
const OPEN_EVENT = "fm:open-chat";
const EXPANDED_KEY = "fm:chat-expanded";

type View = "list" | "thread" | "picker" | "new-group" | "info";

/** Opens the chat widget, optionally on a conversation or with an e-mail filled in. */
export function openChat(target: { conversationId?: string; email?: string } = {}): void {
  window.dispatchEvent(new CustomEvent(OPEN_EVENT, { detail: target }));
}

function newId(): string {
  const c: Crypto = globalThis.crypto;
  if (typeof c.randomUUID === "function") return c.randomUUID();
  // non-secure contexts (plain http on a LAN address) have no randomUUID
  const b = c.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/** A message built from a Realtime event (file details come with the next fetch). */
function messageFromEvent(ev: ChatMessageEvent, current: ChatMessage[]): ChatMessage {
  const reply = ev.reply_to_id ? current.find((m) => m.id === ev.reply_to_id) : undefined;
  return {
    id: ev.id,
    sender_id: ev.sender_id,
    kind: ev.kind,
    meta: ev.meta,
    body: ev.body,
    mentions: ev.mentions,
    file_id: null,
    file_name: ev.file_name,
    file_size: null,
    file_mime: null,
    file_folder_id: null,
    file_version_id: null,
    file_available: false,
    reply_to_id: ev.reply_to_id,
    reply_sender_id: reply?.sender_id ?? null,
    reply_body: reply?.body ?? null,
    reply_file_name: reply?.file_name ?? null,
    reply_deleted: reply ? Boolean(reply.deleted_at) : null,
    reactions: [],
    created_at: ev.created_at,
    deleted_at: ev.deleted_at,
  };
}

function typingText(names: string[]): string | null {
  if (!names.length) return null;
  if (names.length === 1) return `${names[0]} is typing…`;
  if (names.length === 2) return `${names[0]} and ${names[1]} are typing…`;
  return "Several people are typing…";
}

export function ChatWidget({ userId, email: myEmail }: { userId: string; email?: string }) {
  const [open, setOpen] = useState(false);
  const [otherOpen, setOtherOpen] = useState(false);
  // large window with the list beside the conversation (like Messenger)
  const [expanded, setExpanded] = useState(false);
  const [view, setView] = useState<View>("list");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [unread, setUnread] = useState(0);

  const [chats, setChats] = useState<ChatSummary[] | null>(null);
  const [chatsError, setChatsError] = useState<string | null>(null);
  const [email, setEmail] = useState("");
  const [starting, setStarting] = useState(false);

  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [members, setMembers] = useState<ChatMember[]>([]);
  const [pins, setPins] = useState<ChatPin[]>([]);
  const [threadLoading, setThreadLoading] = useState(false);
  const [threadError, setThreadError] = useState<string | null>(null);
  const [hasOlder, setHasOlder] = useState(false);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [replyTo, setReplyTo] = useState<ChatMessage | null>(null);
  const [typing, setTyping] = useState<Record<string, number>>({});
  const [upload, setUpload] = useState<{ done: number; total: number } | null>(null);
  const [previewFile, setPreviewFile] = useState<PreviewableFile | null>(null);

  const me = useMyProfile();
  const bottomRef = useRef<HTMLDivElement>(null);
  // names of everyone seen so far (notifications for conversations not open)
  const knownNames = useRef(new Map<string, string>());
  const typingRef = useRef<{ typing: () => void; leave: () => void } | null>(null);
  const sendQueue = useRef<Promise<void>>(Promise.resolve());
  // values read by realtime callbacks that outlive a render
  const live = useRef({ open, view, selectedId, chats, members, messages, hasOlder });
  useEffect(() => {
    live.current = { open, view, selectedId, chats, members, messages, hasOlder };
  }, [open, view, selectedId, chats, members, messages, hasOlder]);
  const notifications = useChatNotifications(userId);

  useEffect(() => {
    const names = knownNames.current;
    for (const c of chats ?? []) {
      if (c.kind === "direct" && c.other_id) names.set(c.other_id, personName({ email: c.other_email, display_name: c.other_name }));
      if (c.last_sender_id && c.last_sender_name) names.set(c.last_sender_id, c.last_sender_name);
    }
    for (const m of members) names.set(m.user_id, personName(m));
  }, [chats, members]);

  const selected = chats?.find((c) => c.id === selectedId) ?? null;
  const isGroup = selected?.kind === "group";
  const threadVisible = open && (view === "thread" || view === "info" || view === "picker") && selectedId !== null;

  // ---------------------------------------------------------------- names
  const nameOf = useCallback(
    (id: string): string => {
      if (id === userId) return personName({ email: me?.email ?? myEmail ?? null, display_name: me?.display_name });
      const member = members.find((m) => m.user_id === id);
      if (member) return personName(member);
      const direct = chats?.find((c) => c.kind === "direct" && c.other_id === id);
      if (direct) return personName({ email: direct.other_email, display_name: direct.other_name });
      return "Someone";
    },
    [userId, me, myEmail, members, chats]
  );
  const people = useMemo(() => members.map((m) => ({ id: m.user_id, name: personName(m) })), [members]);
  const mentionCandidates: MentionCandidate[] = useMemo(
    () =>
      isGroup
        ? members.filter((m) => m.user_id !== userId).map((m) => ({ user_id: m.user_id, name: personName(m), email: m.email, avatar_path: m.avatar_path }))
        : [],
    [isGroup, members, userId]
  );

  // ---------------------------------------------------------------- data
  const refreshUnread = useCallback(async () => setUnread(await unreadCount()), []);

  const loadChats = useCallback(async () => {
    try {
      setChats(await listChats());
      setChatsError(null);
    } catch (err) {
      setChatsError(getErrorMessage(err));
      setChats((prev) => prev ?? []);
    }
  }, []);

  const refreshThread = useCallback(async (conversationId: string) => {
    const latest = await listMessages(conversationId, null, PAGE);
    if (live.current.selectedId !== conversationId) return;
    // merged by id: messages still on their way to the server stay
    setMessages((prev) => mergeMessages(prev, latest));
  }, []);

  const reloadMembers = useCallback(async (conversationId: string) => {
    const rows = await listMembers(conversationId).catch(() => null);
    if (rows && live.current.selectedId === conversationId) setMembers(rows);
  }, []);

  const reloadPins = useCallback(async (conversationId: string) => {
    const rows = await listPins(conversationId).catch(() => null);
    if (rows && live.current.selectedId === conversationId) setPins(rows);
  }, []);

  const markedRead = useRef<{ id: string; at: number } | null>(null);
  const readTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  /**
   * Marks the conversation read, at most about once a second, and only when a
   * message from someone else is newer than my last read (every read is a
   * write that all members receive as a receipt).
   */
  const read = useCallback(
    (conversationId: string) => {
      if (readTimer.current) clearTimeout(readTimer.current);
      readTimer.current = setTimeout(() => {
        const { members: people, messages: list, chats: all } = live.current;
        if (live.current.selectedId !== conversationId) return;
        const mine = people.find((m) => m.user_id === userId);
        const lastRead = Math.max(toTime(mine?.last_read_at), markedRead.current?.id === conversationId ? markedRead.current.at : 0);
        const newest = list.reduce((t, m) => (m.sender_id !== userId && m.kind === "message" ? Math.max(t, toTime(m.created_at)) : t), 0);
        const listed = all?.find((c) => c.id === conversationId)?.unread ?? 0;
        if (newest <= lastRead && listed === 0) return;
        // server times only: the browser clock may be off
        markedRead.current = { id: conversationId, at: newest };
        void markRead(conversationId)
          .then(() => {
            setChats((prev) => prev?.map((c) => (c.id === conversationId ? { ...c, unread: 0 } : c)) ?? prev);
            void refreshUnread();
          })
          .catch(() => undefined);
      }, 600);
    },
    [refreshUnread, userId]
  );

  const patchMessage = useCallback((id: string, patch: Partial<ChatMessage> | ((m: ChatMessage) => Partial<ChatMessage>)) => {
    setMessages((prev) => prev.map((m) => (m.id === id ? { ...m, ...(typeof patch === "function" ? patch(m) : patch) } : m)));
  }, []);

  useEffect(() => {
    try {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      if (window.localStorage.getItem(EXPANDED_KEY) === "1") setExpanded(true);
    } catch {
      // storage unavailable (private mode): start collapsed
    }
  }, []);

  const toggleExpanded = () => {
    setExpanded((prev) => {
      try {
        window.localStorage.setItem(EXPANDED_KEY, prev ? "0" : "1");
      } catch {
        // not remembered
      }
      return !prev;
    });
  };

  // ---------------------------------------------------------------- widgets & opening
  useEffect(() => {
    announceWidget("chat", open);
  }, [open]);

  useEffect(
    () =>
      onOtherWidget("chat", (otherIsOpen) => {
        setOtherOpen(otherIsOpen);
        if (otherIsOpen) setOpen(false);
      }),
    []
  );

  const openConversation = useCallback((id: string) => {
    setSelectedId(id);
    setView("thread");
    setOpen(true);
  }, []);

  useEffect(() => {
    const onOpen = (event: Event) => {
      const { conversationId, email: to } = (event as CustomEvent<{ conversationId?: string; email?: string }>).detail ?? {};
      if (conversationId) openConversation(conversationId);
      else {
        if (to) setEmail(to);
        setView("list");
        setOpen(true);
      }
    };
    window.addEventListener(OPEN_EVENT, onOpen);
    return () => window.removeEventListener(OPEN_EVENT, onOpen);
  }, [openConversation]);

  // ---------------------------------------------------------------- realtime: every conversation
  useEffect(() => {
    // initial unread count, then live: new messages anywhere update the badge
    // and the list; a new message from someone else shows a toast when it is
    // not on screen, and a system notification (if turned on) when the user
    // is not looking at the app
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void refreshUnread();
    let timer: ReturnType<typeof setTimeout> | null = null;
    const refreshSoon = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        void refreshUnread();
        if (live.current.open) void loadChats();
      }, 250);
    };

    const describe = async (row: ChatMessageEvent) => {
      let chat = (live.current.chats ?? []).find((c) => c.id === row.conversation_id);
      let sender = knownNames.current.get(row.sender_id) ?? null;
      // a new conversation, or a sender we have not seen yet: ask once
      if (!chat || !sender) {
        const fresh = (await listChats().catch(() => [])).find((c) => c.id === row.conversation_id);
        chat = fresh ?? chat;
        if (!sender && fresh?.last_sender_id === row.sender_id) sender = fresh.last_sender_name;
      }
      return notificationContent({
        senderEmail: sender,
        body: row.body,
        fileName: row.file_name,
        group: chat?.kind === "group" ? chat.title : null,
        mentioned: row.mentions.includes(userId),
      });
    };

    const unsubscribe = subscribeToChats(userId, {
      onListChange: refreshSoon,
      onResync: refreshSoon,
      onMessage: (row) => {
        refreshSoon();
        if (row.kind !== "message") return;
        const onScreen = live.current.open && live.current.view !== "list" && live.current.selectedId === row.conversation_id;
        const channels = notifyChannels({
          event: row.event,
          senderId: row.sender_id,
          myId: userId,
          onScreen,
          pageActive: pageActive(),
          enabled: notifications.live.current.enabled,
          permission: notificationPermission(),
        });
        if (!channels.toast && !channels.system) return;
        void describe(row)
          .then(async (content) => {
            if (channels.toast) {
              toast(content.title, {
                description: content.body,
                action: { label: "Open", onClick: () => openConversation(row.conversation_id) },
              });
            }
            if (channels.system) {
              await showSystemNotification({ ...content, tag: `chat-${row.id}`, conversationId: row.conversation_id }, () =>
                openConversation(row.conversation_id)
              );
            }
          })
          .catch(() => undefined);
      },
    });
    return () => {
      if (timer) clearTimeout(timer);
      unsubscribe();
    };
  }, [userId, refreshUnread, loadChats, openConversation, notifications.live]);

  useEffect(() => {
    // a system notification was clicked (service worker), or the app was
    // opened from one (?chat=<conversation id>)
    const chat = new URLSearchParams(window.location.search).get("chat");
    if (chat) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      openConversation(chat);
      const url = new URL(window.location.href);
      url.searchParams.delete("chat");
      window.history.replaceState(null, "", url);
    }
    return onNotificationClick(openConversation);
  }, [openConversation]);

  useEffect(() => {
    // the list is loaded when the panel opens
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (open) void loadChats();
  }, [open, loadChats]);

  // ---------------------------------------------------------------- realtime: the open conversation
  useEffect(() => {
    if (!selectedId) return;
    let cancelled = false;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setMessages([]);
    setMembers([]);
    setPins([]);
    setReplyTo(null);
    setTyping({});
    setThreadError(null);
    setThreadLoading(true);
    listMessages(selectedId, null, PAGE)
      .then((rows) => {
        if (cancelled) return;
        // merged: messages sent or received while loading stay
        setMessages((prev) => mergeMessages(prev, rows));
        setHasOlder(rows.length === PAGE);
        live.current = { ...live.current, hasOlder: rows.length === PAGE };
      })
      .catch((err) => !cancelled && setThreadError(getErrorMessage(err)))
      .finally(() => !cancelled && setThreadLoading(false));
    void reloadMembers(selectedId);
    void reloadPins(selectedId);

    const id = selectedId;
    let listTimer: ReturnType<typeof setTimeout> | null = null;
    const refreshList = () => {
      if (listTimer) clearTimeout(listTimer);
      listTimer = setTimeout(() => void loadChats(), 300);
    };
    const resync = () => {
      void refreshThread(id).catch(() => undefined);
      void reloadMembers(id);
      void reloadPins(id);
      refreshList();
    };

    const offConversation = subscribeToConversation(id, {
      onResync: resync,
      onMessage: (ev) => {
        if (ev.event === "UPDATE") {
          // unsent: text, file, reactions and pins go away
          if (ev.deleted_at) {
            patchMessage(ev.id, { deleted_at: ev.deleted_at, body: null, file_id: null, file_available: false, reactions: [] });
            void reloadPins(id);
          }
          return;
        }
        if (ev.kind === "message" && ev.file_id) {
          // file details (size, access) come from the server
          void refreshThread(id).catch(() => undefined);
        } else {
          setMessages((prev) => {
            const existing = prev.find((m) => m.id === ev.id);
            if (existing) return mergeMessages(prev, [{ ...existing, created_at: ev.created_at, pending: false, failed: false }]);
            return mergeMessages(prev, [messageFromEvent(ev, prev)]);
          });
        }
        // group changes arrive as system messages
        const change = ev.kind === "system" ? ev.meta?.type ?? "" : "";
        if (["add", "remove", "leave", "role", "owner"].includes(change)) {
          void reloadMembers(id);
          refreshList();
        }
        if (["rename", "avatar", "background", "admin_only"].includes(change)) refreshList();
        if (change === "pin" || change === "unpin") void reloadPins(id);
        if (ev.sender_id !== userId) {
          setTyping((prev) => {
            if (!(ev.sender_id in prev)) return prev;
            const next = { ...prev };
            delete next[ev.sender_id];
            return next;
          });
          const visible = live.current.open && live.current.view !== "list" && document.visibilityState === "visible";
          if (visible && ev.kind === "message") read(id);
        }
      },
      onReaction: (row) => {
        patchMessage(row.message_id, (m) => {
          const others = m.reactions.filter((r) => r.user_id !== row.user_id);
          return { reactions: row.emoji ? [...others, { emoji: row.emoji, user_id: row.user_id }] : others };
        });
      },
      onMember: (row) => {
        // read receipts ("Seen"); a changed role needs the full list
        const current = live.current.members.find((m) => m.user_id === row.user_id);
        if (!current || current.role !== row.role) {
          void reloadMembers(id);
          return;
        }
        setMembers((prev) => prev.map((m) => (m.user_id === row.user_id ? { ...m, last_read_at: row.last_read_at } : m)));
      },
    });

    const typingChannel = joinTyping(id, userId, (from) => setTyping((prev) => ({ ...prev, [from]: Date.now() + 4000 })));
    typingRef.current = typingChannel;

    // back to the tab: catch up and mark what is now on screen as read
    const onVisible = () => {
      if (document.visibilityState !== "visible") return;
      resync();
      if (live.current.open && live.current.view !== "list") read(id);
    };
    document.addEventListener("visibilitychange", onVisible);

    return () => {
      cancelled = true;
      if (listTimer) clearTimeout(listTimer);
      document.removeEventListener("visibilitychange", onVisible);
      offConversation();
      typingChannel.leave();
      typingRef.current = null;
    };
  }, [selectedId, userId, read, refreshThread, reloadMembers, reloadPins, patchMessage, loadChats]);

  // the conversation is gone (removed from the group, group disbanded); a
  // conversation not listed yet (opened from a notification) is not "gone"
  const listedBefore = useRef<string | null>(null);
  useEffect(() => {
    if (!selectedId || chats === null || view === "list" || view === "new-group") return;
    if (chats.some((c) => c.id === selectedId)) {
      listedBefore.current = selectedId;
      return;
    }
    if (listedBefore.current !== selectedId) return;
    listedBefore.current = null;
    setSelectedId(null);
    setView("list");
    toast("This conversation is no longer available");
  }, [chats, selectedId, view]);

  // "… is typing" fades after a few seconds without news
  const typingIds = Object.keys(typing);
  useEffect(() => {
    if (!typingIds.length) return;
    const timer = setInterval(() => {
      const now = Date.now();
      setTyping((prev) => Object.fromEntries(Object.entries(prev).filter(([, until]) => until > now)));
    }, 1000);
    return () => clearInterval(timer);
  }, [typingIds.length]);

  // opening a conversation (or coming back to it) marks it read on the server
  useEffect(() => {
    if (threadVisible && selectedId) read(selectedId);
  }, [threadVisible, selectedId, read]);

  const lastMessageId = messages[messages.length - 1]?.id;
  useEffect(() => {
    if (view === "thread") bottomRef.current?.scrollIntoView({ block: "end" });
  }, [lastMessageId, view]);

  // ---------------------------------------------------------------- actions
  const start = async (address = email) => {
    const value = address.trim();
    if (!value || starting) return;
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) {
      toast.error("Invalid email format");
      return;
    }
    setStarting(true);
    try {
      const id = await startChat(value);
      setEmail("");
      await loadChats();
      openConversation(id);
    } catch (err) {
      toast.error(getErrorMessage(err));
    } finally {
      setStarting(false);
    }
  };

  /** Sends in order; the message is already on screen. */
  const deliver = useCallback(
    (conversationId: string, m: ChatMessage) => {
      sendQueue.current = sendQueue.current.then(async () => {
        try {
          await sendMessage(conversationId, m.body, null, { id: m.id, replyTo: m.reply_to_id, mentions: m.mentions });
          patchMessage(m.id, { pending: false, failed: false });
        } catch (err) {
          // a retry of a message that did reach the server
          if (/duplicate key/i.test(getErrorMessage(err))) {
            patchMessage(m.id, { pending: false, failed: false });
            return;
          }
          patchMessage(m.id, { pending: false, failed: true });
          toast.error(getErrorMessage(err));
          // e.g. removed from the group meanwhile: the list tells
          void loadChats();
        }
      });
    },
    [patchMessage, loadChats]
  );

  const send = (text: string, mentions: string[]) => {
    if (!selectedId) return;
    const m: ChatMessage = {
      id: newId(),
      sender_id: userId,
      kind: "message",
      meta: null,
      body: text,
      mentions,
      file_id: null,
      file_name: null,
      file_size: null,
      file_mime: null,
      file_folder_id: null,
      file_version_id: null,
      file_available: false,
      reply_to_id: replyTo?.id ?? null,
      reply_sender_id: replyTo?.sender_id ?? null,
      reply_body: replyTo?.body ?? null,
      reply_file_name: replyTo?.file_name ?? null,
      reply_deleted: replyTo ? false : null,
      reactions: [],
      // never before the last message (the browser clock may be behind);
      // the server's time replaces it when the message comes back
      created_at: new Date(Math.max(Date.now(), toTime(messages[messages.length - 1]?.created_at) + 1)).toISOString(),
      deleted_at: null,
      pending: true,
    };
    setMessages((prev) => [...prev, m]);
    setReplyTo(null);
    deliver(selectedId, m);
  };

  const retry = (m: ChatMessage) => {
    if (!selectedId) return;
    patchMessage(m.id, { pending: true, failed: false });
    deliver(selectedId, m);
  };

  const sendFiles = async (files: File[]) => {
    if (!selectedId || !files.length) return;
    setUpload({ done: 0, total: files.length });
    try {
      const result = await sendUploads(userId, selectedId, files, (done, total) => setUpload({ done, total }));
      if (result.failed.length) toast.error(`Could not send ${result.failed.length} file(s): ${result.failed[0]}`);
      await refreshThread(selectedId);
    } catch (err) {
      toast.error(getErrorMessage(err));
    } finally {
      setUpload(null);
    }
  };

  const unsend = async (m: ChatMessage) => {
    if (!window.confirm("Unsend this message? It will be removed for everyone.")) return;
    try {
      await deleteMessage(m.id);
      patchMessage(m.id, { deleted_at: new Date().toISOString(), body: null, file_id: null, file_available: false, reactions: [] });
    } catch (err) {
      toast.error(getErrorMessage(err));
    }
  };

  const react = async (m: ChatMessage, emoji: string) => {
    const before = m.reactions;
    const mineNow = before.find((r) => r.user_id === userId)?.emoji;
    const others = before.filter((r) => r.user_id !== userId);
    patchMessage(m.id, { reactions: mineNow === emoji ? others : [...others, { emoji, user_id: userId }] });
    try {
      await reactToMessage(m.id, emoji);
    } catch (err) {
      patchMessage(m.id, { reactions: before });
      toast.error(getErrorMessage(err));
    }
  };

  const pin = async (messageId: string, on: boolean) => {
    try {
      await (on ? pinMessage(messageId) : unpinMessage(messageId));
      if (selectedId) void reloadPins(selectedId);
    } catch (err) {
      toast.error(getErrorMessage(err));
    }
  };

  const loadOlder = useCallback(async () => {
    const { selectedId: id, messages: current } = live.current;
    const oldest = current.find((m) => !m.pending && !m.failed);
    if (!id || !oldest) return false;
    setLoadingOlder(true);
    try {
      const older = await listMessages(id, oldest.created_at, PAGE);
      setMessages((prev) => mergeMessages(older, prev));
      setHasOlder(older.length === PAGE);
      // right away, so a caller looping over pages (jumpTo) sees the new cursor
      live.current = { ...live.current, messages: mergeMessages(older, current), hasOlder: older.length === PAGE };
      return older.length > 0;
    } catch (err) {
      toast.error(getErrorMessage(err));
      return false;
    } finally {
      setLoadingOlder(false);
    }
  }, []);

  /** Scrolls to a message, loading older pages when it is not on screen yet. */
  const jumpTo = async (messageId: string) => {
    setView("thread");
    for (let attempt = 0; attempt < 8; attempt++) {
      await new Promise((r) => requestAnimationFrame(() => r(null)));
      const el = document.getElementById(`msg-${messageId}`);
      if (el) {
        el.scrollIntoView({ block: "center", behavior: "smooth" });
        el.classList.add("animate-pulse");
        setTimeout(() => el.classList.remove("animate-pulse"), 1600);
        return;
      }
      if (!live.current.hasOlder || !(await loadOlder())) break;
    }
    toast("That message is no longer available");
  };

  // ---------------------------------------------------------------- derived
  const groups = useMemo(() => groupByDay(messages), [messages]);
  const lastMine = [...messages].reverse().find((m) => m.sender_id === userId && m.kind === "message" && !m.deleted_at && !m.pending);
  const seenBy = lastMine ? members.filter((m) => m.user_id !== userId && toTime(m.last_read_at) >= toTime(lastMine.created_at)) : [];
  const typingNames = typingText(typingIds.map(nameOf));
  const pinnedIds = useMemo(() => new Set(pins.map((p) => p.message_id)), [pins]);
  const canPin = !selected || !isGroup || canEditGroup(selected.my_role, selected.admin_only);
  const background = backgroundStyle(selected?.background, (p) => publicImageUrl(p) ?? "");
  const memberById = useMemo(() => new Map(members.map((m) => [m.user_id, m])), [members]);
  const suggestions = useMemo(
    () => (chats ?? []).filter((c) => c.kind === "direct" && c.other_id !== userId && c.other_email).map((c) => c.other_email!),
    [chats, userId]
  );
  const selfChat = selected?.kind === "direct" && selected.other_id === userId;

  // ---------------------------------------------------------------- panes
  // the open conversation and its screens (null: nothing selected)
  const mainPane =
    view === "picker" && selectedId ? (
      <FilePicker
        userId={userId}
        onBack={() => setView("thread")}
        onPick={async (file) => {
          await sendMessage(selectedId, null, file.id);
          await refreshThread(selectedId);
          setView("thread");
        }}
      />
    ) : view === "new-group" ? (
      <NewGroupView
        suggestions={suggestions}
        onBack={() => setView("list")}
        onCreate={async (title, emails) => {
          const id = await createGroup(title, emails);
          await loadChats();
          openConversation(id);
        }}
      />
    ) : view === "info" && selected ? (
      <InfoView
        key={selected.id}
        chat={selected}
        members={members}
        pins={pins}
        myId={userId}
        nameOf={nameOf}
        onBack={() => setView("thread")}
        onChanged={() => {
          void loadChats();
          if (selectedId) void reloadMembers(selectedId);
        }}
        onLeft={() => {
          setSelectedId(null);
          setView("list");
          void loadChats();
        }}
        onJump={(id) => void jumpTo(id)}
        onUnpin={(id) => void pin(id, false)}
      />
    ) : (view === "thread" || view === "info") && selectedId ? (
      <>
        <header className="flex items-center gap-2 border-b px-3 py-2.5">
          <button type="button" onClick={() => setView("list")} className={cn(iconButton, expanded && "md:hidden")} aria-label="Back to chats">
            <ArrowLeft className="h-4 w-4" />
          </button>
          <button type="button" onClick={() => selected && setView("info")} className="flex min-w-0 flex-1 items-center gap-2 text-left">
            <UserAvatar
              name={selected ? chatTitle(selected, userId) : null}
              path={isGroup ? selected?.avatar_path : selected?.other_avatar}
              group={isGroup}
              size="sm"
            />
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm font-semibold">{selected ? chatTitle(selected, userId) : "…"}</span>
              <span className="block truncate text-[11px] text-muted-foreground">
                {typingNames ?? (isGroup ? `${selected?.member_count ?? members.length} members` : selfChat ? "Notes to self" : selected?.other_email ?? "")}
              </span>
            </span>
          </button>
          <button type="button" onClick={() => setView("info")} disabled={!selected} className={iconButton} aria-label="Conversation info" title="Info">
            <Info className="h-4 w-4" />
          </button>
          {/* side by side, the window buttons are in the list's header */}
          <div className={cn("flex items-center", expanded && "md:hidden")}>
            <button
              type="button"
              onClick={toggleExpanded}
              className={cn(iconButton, "hidden sm:block")}
              aria-label={expanded ? "Shrink chat" : "Expand chat"}
              aria-pressed={expanded}
              title={expanded ? "Shrink" : "Expand"}
            >
              {expanded ? <Minimize2 className="h-4 w-4" /> : <Maximize2 className="h-4 w-4" />}
            </button>
            <button type="button" onClick={() => setOpen(false)} className={cn(iconButton, "hidden sm:block")} aria-label="Minimize">
              <Minus className="h-4 w-4" />
            </button>
            <button type="button" onClick={() => setOpen(false)} className={iconButton} aria-label="Close">
              <X className="h-4 w-4" />
            </button>
          </div>
        </header>

        <PinnedBar pins={pins} nameOf={nameOf} canPin={canPin} onJump={(id) => void jumpTo(id)} onUnpin={(id) => void pin(id, false)} />

        <div className="@container relative flex-1 overflow-y-auto px-3 py-3" style={background ?? undefined}>
          {threadLoading ? (
            <div className="flex h-full items-center justify-center">
              <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
            </div>
          ) : threadError ? (
            <p className="text-center text-sm text-destructive">{threadError}</p>
          ) : messages.length === 0 ? (
            <p className="pt-10 text-center text-sm text-muted-foreground">{selfChat ? "Keep notes and files for yourself here." : "Say hello 👋"}</p>
          ) : (
            <div className="space-y-3">
              {hasOlder && (
                <div className="flex justify-center">
                  <button
                    type="button"
                    onClick={() => void loadOlder()}
                    disabled={loadingOlder}
                    className="inline-flex items-center gap-1 rounded-full border bg-background/80 px-3 py-1 text-xs text-muted-foreground hover:text-foreground"
                  >
                    {loadingOlder && <Loader2 className="h-3 w-3 animate-spin" />}
                    Load older messages
                  </button>
                </div>
              )}
              {groups.map((group) => (
                <div key={group.label + group.items[0].id} className="space-y-1.5">
                  <p className="py-1 text-center text-[10px] font-medium uppercase tracking-wider text-muted-foreground/80">
                    <span className="rounded-full bg-background/70 px-2 py-0.5 backdrop-blur">{group.label}</span>
                  </p>
                  {group.items.map((m, i) => {
                    if (m.kind === "system") return <SystemRow key={m.id} m={m} myId={userId} nameOf={nameOf} />;
                    const prev = group.items[i - 1];
                    const member = memberById.get(m.sender_id);
                    return (
                      <MessageRow
                        key={m.id}
                        m={m}
                        myId={userId}
                        isGroup={isGroup}
                        sender={{ name: nameOf(m.sender_id), avatar_path: member?.avatar_path ?? null }}
                        showSender={!prev || prev.sender_id !== m.sender_id || prev.kind === "system"}
                        nameOf={nameOf}
                        people={people}
                        pinned={pinnedIds.has(m.id)}
                        canPin={canPin}
                        onReact={(emoji) => void react(m, emoji)}
                        onReply={() => setReplyTo(m)}
                        onPin={(on) => void pin(m.id, on)}
                        onUnsend={() => void unsend(m)}
                        onRetry={() => retry(m)}
                        onJump={(id) => void jumpTo(id)}
                        onPreview={setPreviewFile}
                      />
                    );
                  })}
                </div>
              ))}
              {lastMine && !selfChat && (
                <div className="flex items-center justify-end gap-1 text-[11px] text-muted-foreground">
                  {isGroup ? (
                    seenBy.length ? (
                      <>
                        <span className="mr-0.5">Seen by</span>
                        {seenBy.slice(0, 5).map((m) => (
                          <span key={m.user_id} title={personName(m)}>
                            <UserAvatar name={personName(m)} path={m.avatar_path} size="xs" />
                          </span>
                        ))}
                        {seenBy.length > 5 && <span>+{seenBy.length - 5}</span>}
                      </>
                    ) : (
                      <>
                        <Check className="h-3.5 w-3.5" />
                        Sent
                      </>
                    )
                  ) : seenBy.length ? (
                    <>
                      <CheckCheck className="h-3.5 w-3.5 text-primary" />
                      Seen
                    </>
                  ) : (
                    <>
                      <Check className="h-3.5 w-3.5" />
                      Sent
                    </>
                  )}
                </div>
              )}
            </div>
          )}
          <div ref={bottomRef} />
        </div>

        {typingNames && (
          <p className="flex items-center gap-1.5 border-t bg-background/60 px-4 py-1 text-[11px] text-muted-foreground">
            <span className="flex gap-0.5">
              <span className="h-1 w-1 animate-bounce rounded-full bg-current [animation-delay:-0.3s]" />
              <span className="h-1 w-1 animate-bounce rounded-full bg-current [animation-delay:-0.15s]" />
              <span className="h-1 w-1 animate-bounce rounded-full bg-current" />
            </span>
            {typingNames}
          </p>
        )}

        <Composer
          key={selectedId}
          members={mentionCandidates}
          replyTo={replyTo}
          replyName={replyTo ? nameOf(replyTo.sender_id) : ""}
          onCancelReply={() => setReplyTo(null)}
          onSend={send}
          onTyping={() => typingRef.current?.typing()}
          onUpload={(files) => void sendFiles(files)}
          onPickFile={() => setView("picker")}
          upload={upload}
        />
      </>
    ) : null;

  // conversations, start a chat, new group
  const listPane = (
    <>
      <header className="flex items-center gap-3 border-b px-4 py-3">
        <span className="flex h-9 w-9 items-center justify-center rounded-2xl bg-brand text-white shadow-lg shadow-primary/30">
          <MessagesSquare className="h-4 w-4" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold">Chat</p>
          <p className="truncate text-[11px] text-muted-foreground">Messages, groups and files, in real time</p>
        </div>
        <NotificationToggle notifications={notifications} />
        <button
          type="button"
          onClick={toggleExpanded}
          className={cn(iconButton, "hidden sm:block")}
          aria-label={expanded ? "Shrink chat" : "Expand chat"}
          aria-pressed={expanded}
          title={expanded ? "Shrink" : "Expand"}
        >
          {expanded ? <Minimize2 className="h-4 w-4" /> : <Maximize2 className="h-4 w-4" />}
        </button>
        <button type="button" onClick={() => setOpen(false)} className={cn(iconButton, "hidden sm:block")} aria-label="Minimize">
          <Minus className="h-4 w-4" />
        </button>
        <button type="button" onClick={() => setOpen(false)} className={iconButton} aria-label="Close">
          <X className="h-4 w-4" />
        </button>
      </header>
      <NotificationBanner notifications={notifications} />

      <form
        className="flex gap-2 border-b p-3"
        onSubmit={(e) => {
          e.preventDefault();
          void start();
        }}
      >
        <input
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="Add someone: user@example.com"
          aria-label="Email to chat with"
          className="h-9 min-w-0 flex-1 rounded-lg border bg-background/60 px-3 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
        />
        <button
          type="submit"
          disabled={!email.trim() || starting}
          aria-label="Start chat"
          className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-brand text-white disabled:opacity-40"
        >
          {starting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
        </button>
      </form>
      <div className="flex border-b text-xs text-muted-foreground">
        <button
          type="button"
          onClick={() => setView("new-group")}
          className="flex flex-1 items-center justify-center gap-1.5 px-4 py-2 transition-colors hover:bg-muted/50 hover:text-foreground"
        >
          <Users className="h-3.5 w-3.5" />
          New group
        </button>
        {myEmail && (
          <button
            type="button"
            onClick={() => void start(myEmail)}
            disabled={starting}
            className="flex flex-1 items-center justify-center gap-1.5 border-l px-4 py-2 transition-colors hover:bg-muted/50 hover:text-foreground"
          >
            <NotebookPen className="h-3.5 w-3.5" />
            Notes to self
          </button>
        )}
      </div>

      <div className="flex-1 overflow-y-auto">
        {chats === null ? (
          <div className="space-y-2 p-3">
            {Array.from({ length: 4 }).map((_, i) => (
              <div key={i} className="h-14 animate-pulse rounded-xl bg-muted/40" />
            ))}
          </div>
        ) : chatsError ? (
          <p className="p-4 text-sm text-destructive">{chatsError}</p>
        ) : chats.length === 0 ? (
          <div className="flex flex-col items-center px-6 py-12 text-center">
            <MessagesSquare className="mb-3 h-12 w-12 text-muted-foreground/50" />
            <p className="text-sm font-medium">No conversations yet</p>
            <p className="mt-1 text-xs text-muted-foreground">Add someone by e-mail above, or create a group.</p>
          </div>
        ) : (
          <div className="divide-y">
            {chats.map((c) => (
              <button
                key={c.id}
                type="button"
                onClick={() => openConversation(c.id)}
                className={cn("flex w-full items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-muted/50", c.id === selectedId && "bg-muted/40")}
              >
                <UserAvatar name={chatTitle(c, userId)} path={c.kind === "group" ? c.avatar_path : c.other_avatar} group={c.kind === "group"} />
                <div className="min-w-0 flex-1">
                  <div className="flex items-baseline gap-2">
                    <p className={cn("min-w-0 flex-1 truncate text-sm", c.unread ? "font-semibold" : "font-medium")}>
                      {chatTitle(c, userId)}
                      {c.kind === "group" && <span className="ml-1 text-[11px] font-normal text-muted-foreground">· {c.member_count}</span>}
                    </p>
                    <span className="shrink-0 text-[11px] text-muted-foreground">{listTime(c.last_message_at)}</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <p className={cn("min-w-0 flex-1 truncate text-xs", c.unread ? "text-foreground" : "text-muted-foreground")}>{messagePreview(c, userId)}</p>
                    {c.unread > 0 && (
                      <span className="flex h-5 min-w-5 shrink-0 items-center justify-center rounded-full bg-brand px-1.5 text-[10px] font-semibold text-white">
                        {c.unread > 99 ? "99+" : c.unread}
                      </span>
                    )}
                  </div>
                </div>
              </button>
            ))}
          </div>
        )}
      </div>
    </>
  );

  // ---------------------------------------------------------------- render
  return (
    <>
      {/* Launcher, left of the AI Assistant's */}
      <AnimatePresence>
        {!open && !otherOpen && (
          <motion.button
            type="button"
            onClick={() => {
              setView(selectedId ? "thread" : "list");
              setOpen(true);
            }}
            initial={{ scale: 0, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            exit={{ scale: 0, opacity: 0 }}
            whileHover={{ scale: 1.06 }}
            whileTap={{ scale: 0.94 }}
            transition={{ type: "spring", stiffness: 400, damping: 22 }}
            aria-label={unread ? `Open chat (${unread} unread)` : "Open chat"}
            title="Chat"
            className="fixed bottom-5 right-[5.5rem] z-[60] flex h-14 w-14 items-center justify-center rounded-full border bg-card/90 text-primary shadow-2xl shadow-primary/20 backdrop-blur"
          >
            <MessagesSquare className="h-6 w-6" />
            {unread > 0 && (
              <span className="absolute -right-0.5 -top-0.5 flex h-5 min-w-5 items-center justify-center rounded-full bg-destructive px-1 text-[10px] font-semibold text-white shadow">
                {unread > 99 ? "99+" : unread}
              </span>
            )}
          </motion.button>
        )}
      </AnimatePresence>

      {/* Panel */}
      <AnimatePresence>
        {open && (
          <motion.section
            role="dialog"
            aria-label="Chat"
            initial={{ opacity: 0, scale: 0.9, y: 24 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.92, y: 24 }}
            transition={{ type: "spring", stiffness: 380, damping: 32 }}
            style={{ transformOrigin: "bottom right" }}
            className={cn(
              "fixed inset-0 z-[60] flex flex-col overflow-hidden bg-popover/95 backdrop-blur-2xl sm:inset-auto sm:bottom-5 sm:right-5 sm:rounded-3xl sm:border sm:shadow-[0_30px_80px_-20px_rgb(0_0_0/0.45)] sm:transition-[width,height] sm:duration-300",
              expanded
                ? "sm:h-[calc(100vh-2.5rem)] sm:w-[min(1100px,calc(100vw-2.5rem))]"
                : "sm:h-[min(680px,calc(100vh-7rem))] sm:w-[420px]"
            )}
          >
            {expanded ? (
              <div className="flex min-h-0 flex-1">
                <div className="hidden w-[340px] shrink-0 flex-col border-r md:flex">{listPane}</div>
                <div className="flex min-w-0 flex-1 flex-col">
                  {mainPane ?? (
                    <>
                      <div className="flex min-h-0 flex-1 flex-col md:hidden">{listPane}</div>
                      <div className="hidden flex-1 flex-col items-center justify-center gap-2 px-8 text-center md:flex">
                        <MessagesSquare className="h-12 w-12 text-muted-foreground/40" />
                        <p className="text-sm font-medium">Select a conversation</p>
                        <p className="text-xs text-muted-foreground">Or start one by e-mail, or create a group, on the left.</p>
                      </div>
                    </>
                  )}
                </div>
              </div>
            ) : (
              mainPane ?? listPane
            )}
          </motion.section>
        )}
      </AnimatePresence>

      {previewFile && (
        <PreviewDialog
          open
          className="z-[70]"
          onOpenChange={(o) => {
            if (!o) setPreviewFile(null);
          }}
          file={previewFile}
        />
      )}
    </>
  );
}
