"use client";

// Message box: text with @mentions and emoji, stickers (picker and Zalo-style
// suggestions while typing), reply preview, files.

import { useMemo, useRef, useState } from "react";
import { FolderOpen, Loader2, Paperclip, Reply, SendHorizontal, Smile, Sticker as StickerIcon, X } from "lucide-react";
import { iconButton } from "@/components/chat/chat-file";
import { StickerImage, StickerPicker } from "@/components/chat/sticker-picker";
import { UserAvatar } from "@/components/chat/user-avatar";
import { rememberSticker, useStickers } from "@/lib/stickers/load";
import { suggestStickers } from "@/lib/stickers/suggest";
import { activeMentions, filterMembers, mentionQuery } from "@/lib/chat-format";
import type { ChatMessage } from "@/lib/services/chat";
import { cn } from "@/lib/utils";

export type MentionCandidate = { user_id: string; name: string; email: string | null; avatar_path: string | null };

const EMOJI = [
  "😀", "😁", "😂", "🤣", "😊", "😍", "😘", "😎", "🤔", "😴", "😅", "😉",
  "🙂", "🙃", "😇", "🥰", "😢", "😭", "😡", "😱", "🤗", "🤩", "😏", "😬",
  "👍", "👎", "👏", "🙏", "💪", "👌", "✌️", "🤝", "👀", "🎉", "🔥", "✨",
  "❤️", "💜", "💙", "💯", "✅", "❌", "⭐", "☕", "🍀", "🎂", "🐳", "🚀",
];

export function Composer({
  members,
  replyTo,
  replyName,
  onCancelReply,
  onSend,
  onSendSticker,
  onTyping,
  onUpload,
  onPickFile,
  upload,
}: {
  members: MentionCandidate[];
  replyTo: ChatMessage | null;
  replyName: string;
  onCancelReply: () => void;
  onSend: (text: string, mentions: string[]) => void;
  onSendSticker: (id: string) => void;
  onTyping: () => void;
  onUpload: (files: File[]) => void;
  onPickFile: () => void;
  upload: { done: number; total: number } | null;
}) {
  const [draft, setDraft] = useState("");
  const [caret, setCaret] = useState(0);
  const [picked, setPicked] = useState<{ id: string; name: string }[]>([]);
  const [emojiOpen, setEmojiOpen] = useState(false);
  const [stickerOpen, setStickerOpen] = useState(false);
  const [highlight, setHighlight] = useState(0);
  // the sticker list loads the first time it is needed
  const stickers = useStickers(stickerOpen || draft.trim().length > 0);
  const textRef = useRef<HTMLTextAreaElement>(null);
  const uploadRef = useRef<HTMLInputElement>(null);

  const query = members.length ? mentionQuery(draft, caret) : null;
  const suggestions = useMemo(() => (query ? filterMembers(members, query.query).slice(0, 6) : []), [members, query]);
  const showMentions = suggestions.length > 0;
  const stickerHints = useMemo(
    () => (stickers && !showMentions && !emojiOpen && !stickerOpen ? suggestStickers(draft, stickers) : []),
    [stickers, draft, showMentions, emojiOpen, stickerOpen]
  );

  const syncCaret = () => setCaret(textRef.current?.selectionStart ?? draft.length);

  const insertAt = (text: string, start: number, end: number) => {
    const next = draft.slice(0, start) + text + draft.slice(end);
    setDraft(next);
    const position = start + text.length;
    setCaret(position);
    requestAnimationFrame(() => {
      textRef.current?.focus();
      textRef.current?.setSelectionRange(position, position);
    });
  };

  const pickMention = (m: MentionCandidate) => {
    if (!query) return;
    insertAt(`@${m.name} `, query.start, caret);
    setPicked((prev) => (prev.some((p) => p.id === m.user_id) ? prev : [...prev, { id: m.user_id, name: m.name }]));
    setHighlight(0);
  };

  const sendSticker = (id: string, fromHint = false) => {
    onSendSticker(id);
    rememberSticker(id);
    setStickerOpen(false);
    // like Zalo: the words a suggested sticker replaces are not sent as well
    if (fromHint) {
      setDraft("");
      setPicked([]);
      setCaret(0);
    }
    requestAnimationFrame(() => textRef.current?.focus());
  };

  const send = () => {
    const text = draft.trim();
    if (!text) return;
    onSend(text, activeMentions(text, picked));
    setDraft("");
    setPicked([]);
    setCaret(0);
    setEmojiOpen(false);
  };

  return (
    <footer className="relative border-t p-2.5">
      {upload && (
        <p className="mb-2 flex items-center gap-1.5 text-xs text-muted-foreground">
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
          Sending files {upload.done}/{upload.total}…
        </p>
      )}
      {replyTo && (
        <div className="mb-2 flex items-start gap-2 rounded-xl border-l-2 border-primary bg-muted/60 px-3 py-1.5 text-xs">
          <Reply className="mt-0.5 h-3.5 w-3.5 shrink-0 text-primary" />
          <div className="min-w-0 flex-1">
            <p className="font-medium">Replying to {replyName}</p>
            <p className="truncate text-muted-foreground">
              {replyTo.body ?? (replyTo.file_name ? `📎 ${replyTo.file_name}` : replyTo.meta?.sticker ? "Sticker" : "")}
            </p>
          </div>
          <button type="button" onClick={onCancelReply} className="rounded p-0.5 hover:bg-muted" aria-label="Cancel reply">
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      )}

      {stickerOpen && <StickerPicker stickers={stickers} onPick={(id) => sendSticker(id)} onClose={() => setStickerOpen(false)} />}

      {stickerHints.length > 0 && (
        <div className="absolute bottom-full left-2.5 right-2.5 mb-1 flex gap-1 overflow-x-auto rounded-2xl border bg-popover/95 p-1.5 shadow-xl backdrop-blur" aria-label="Suggested stickers">
          {stickerHints.map((sticker) => (
            <button
              key={sticker.id}
              type="button"
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => sendSticker(sticker.id, true)}
              className="h-14 w-14 shrink-0 rounded-xl p-1 transition-transform hover:scale-110 hover:bg-muted/60"
              title={`Send ${sticker.name}`}
              aria-label={`Send sticker ${sticker.name}`}
            >
              <StickerImage id={sticker.id} className="h-full w-full" />
            </button>
          ))}
        </div>
      )}

      {showMentions && (
        <div role="listbox" aria-label="Mention someone" className="absolute bottom-full left-2.5 right-2.5 mb-1 overflow-hidden rounded-xl border bg-popover shadow-xl">
          {suggestions.map((m, i) => (
            <button
              key={m.user_id}
              type="button"
              role="option"
              aria-selected={i === highlight}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => pickMention(m)}
              className={cn("flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm", i === highlight ? "bg-muted" : "hover:bg-muted/60")}
            >
              <UserAvatar name={m.name} path={m.avatar_path} size="xs" />
              <span className="min-w-0 flex-1 truncate">{m.name}</span>
              {m.email && m.email !== m.name && <span className="truncate text-xs text-muted-foreground">{m.email}</span>}
            </button>
          ))}
        </div>
      )}

      {emojiOpen && (
        <div className="absolute bottom-full left-2.5 mb-1 grid w-[17rem] grid-cols-8 gap-0.5 rounded-xl border bg-popover p-2 shadow-xl">
          {EMOJI.map((e) => (
            <button
              key={e}
              type="button"
              onMouseDown={(ev) => ev.preventDefault()}
              onClick={() => {
                const el = textRef.current;
                insertAt(e, el?.selectionStart ?? draft.length, el?.selectionEnd ?? draft.length);
              }}
              className="flex h-8 w-8 items-center justify-center rounded-lg text-lg hover:bg-muted"
              aria-label={`Insert ${e}`}
            >
              {e}
            </button>
          ))}
        </div>
      )}

      <input
        ref={uploadRef}
        type="file"
        multiple
        className="hidden"
        onChange={(e) => {
          const files = Array.from(e.target.files ?? []);
          e.target.value = "";
          if (files.length) onUpload(files);
        }}
      />
      <div className="flex items-end gap-1 rounded-2xl border bg-background/70 p-1.5 focus-within:border-primary/40">
        <button type="button" onClick={() => uploadRef.current?.click()} disabled={upload !== null} className={iconButton} title="Upload from device" aria-label="Upload from device">
          <Paperclip className="h-4 w-4" />
        </button>
        <button type="button" onClick={onPickFile} disabled={upload !== null} className={iconButton} title="Send from My Files" aria-label="Send from My Files">
          <FolderOpen className="h-4 w-4" />
        </button>
        <button
          type="button"
          onClick={() => {
            setEmojiOpen((o) => !o);
            setStickerOpen(false);
          }}
          className={cn(iconButton, emojiOpen && "bg-muted text-foreground")}
          title="Emoji"
          aria-label="Emoji"
          aria-expanded={emojiOpen}
        >
          <Smile className="h-4 w-4" />
        </button>
        <button
          type="button"
          onClick={() => {
            setStickerOpen((o) => !o);
            setEmojiOpen(false);
          }}
          className={cn(iconButton, stickerOpen && "bg-muted text-foreground")}
          title="Stickers"
          aria-label="Stickers"
          aria-expanded={stickerOpen}
        >
          <StickerIcon className="h-4 w-4" />
        </button>
        <textarea
          ref={textRef}
          value={draft}
          onChange={(e) => {
            setDraft(e.target.value);
            setCaret(e.target.selectionStart ?? e.target.value.length);
            setHighlight(0);
            if (e.target.value.trim()) onTyping();
          }}
          onSelect={syncCaret}
          onKeyDown={(e) => {
            if (e.nativeEvent.isComposing) return;
            if (showMentions) {
              if (e.key === "ArrowDown" || e.key === "ArrowUp") {
                e.preventDefault();
                const step = e.key === "ArrowDown" ? 1 : -1;
                setHighlight((h) => (h + step + suggestions.length) % suggestions.length);
                return;
              }
              if (e.key === "Enter" || e.key === "Tab") {
                e.preventDefault();
                pickMention(suggestions[Math.min(highlight, suggestions.length - 1)]);
                return;
              }
            }
            if (e.key === "Escape") {
              if (stickerOpen) setStickerOpen(false);
              else if (emojiOpen) setEmojiOpen(false);
              else if (replyTo) onCancelReply();
              return;
            }
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              send();
            }
          }}
          rows={1}
          maxLength={4000}
          placeholder={members.length ? "Message… (@ to mention)" : "Message…"}
          aria-label="Message"
          autoFocus
          className="max-h-32 min-h-[2rem] min-w-0 flex-1 resize-none bg-transparent py-1.5 text-sm outline-none placeholder:text-muted-foreground [field-sizing:content]"
        />
        <button
          type="button"
          onClick={send}
          disabled={!draft.trim()}
          aria-label="Send"
          className="flex h-8 w-8 shrink-0 items-center justify-center rounded-xl bg-brand text-white transition-opacity disabled:opacity-40"
        >
          <SendHorizontal className="h-4 w-4" />
        </button>
      </div>
    </footer>
  );
}
