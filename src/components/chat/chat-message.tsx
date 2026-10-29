"use client";

// One message: bubble with reply quote, @mentions, file, reactions and actions;
// system lines ("Bob added Carol"); the pinned messages bar.

import { useState } from "react";
import { AlertCircle, ChevronDown, Copy, Loader2, Pin, PinOff, Reply, RotateCcw, SmilePlus, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { FileBubble } from "@/components/chat/chat-file";
import { UserAvatar } from "@/components/chat/user-avatar";
import { REACTIONS, clockTime, groupReactions, mentionSegments, systemText } from "@/lib/chat-format";
import type { ChatMessage, ChatPin } from "@/lib/services/chat";
import type { PreviewableFile } from "@/lib/services/files";
import { cn } from "@/lib/utils";

export type Person = { name: string; avatar_path: string | null };

export function SystemRow({ m, myId, nameOf }: { m: ChatMessage; myId: string; nameOf: (id: string) => string }) {
  return (
    <p id={`msg-${m.id}`} className="mx-auto max-w-[85%] py-1 text-center text-[11px] text-muted-foreground">
      <span className="rounded-full bg-background/70 px-2.5 py-0.5 backdrop-blur">{systemText(m.meta, m.sender_id, nameOf, myId)}</span>
    </p>
  );
}

const actionButton = "rounded-md p-1 text-muted-foreground hover:bg-muted hover:text-foreground";

export function MessageRow({
  m,
  myId,
  isGroup,
  sender,
  showSender,
  nameOf,
  people,
  pinned,
  canPin,
  onReact,
  onReply,
  onPin,
  onUnsend,
  onRetry,
  onJump,
  onPreview,
}: {
  m: ChatMessage;
  myId: string;
  isGroup: boolean;
  sender: Person;
  /** first message of a run from this sender: show name and picture */
  showSender: boolean;
  nameOf: (id: string) => string;
  people: { id: string; name: string }[];
  pinned: boolean;
  canPin: boolean;
  onReact: (emoji: string) => void;
  onReply: () => void;
  onPin: (pin: boolean) => void;
  onUnsend: () => void;
  onRetry: () => void;
  onJump: (messageId: string) => void;
  onPreview: (file: PreviewableFile) => void;
}) {
  const [picker, setPicker] = useState(false);
  const mine = m.sender_id === myId;
  const reactions = groupReactions(m.reactions, myId);
  const live = !m.deleted_at && !m.pending && !m.failed;
  const mentionedMe = m.mentions.includes(myId);

  return (
    <div id={`msg-${m.id}`} className={cn("group/msg flex items-end gap-1.5", mine ? "justify-end" : "justify-start")}>
      {isGroup && !mine && (
        <div className="w-7 shrink-0">{showSender && <UserAvatar name={sender.name} path={sender.avatar_path} size="sm" className="h-7 w-7" />}</div>
      )}

      {/* narrower bubbles in the wide (expanded) chat, like Messenger */}
      <div className={cn("flex min-w-0 max-w-[80%] flex-col @2xl:max-w-[62%]", mine ? "items-end" : "items-start")}>
        {isGroup && !mine && showSender && <p className="mb-0.5 px-1 text-[11px] font-medium text-muted-foreground">{sender.name}</p>}

        <div className={cn("flex items-center gap-1", mine ? "flex-row-reverse" : "flex-row")}>
          <div
            className={cn(
              "min-w-0 space-y-1 rounded-2xl px-3 py-2 text-sm shadow-sm",
              // selected text must stand out from the bubble (the page-wide
              // selection colour is too close to the brand gradient)
              m.deleted_at
                ? "border border-dashed bg-background/60 italic text-muted-foreground shadow-none"
                : mine
                  ? "rounded-br-md bg-brand text-white selection:bg-white selection:text-[#5b21b6]"
                  : "rounded-bl-md bg-card/95 selection:bg-primary selection:text-primary-foreground",
              mentionedMe && !mine && !m.deleted_at && "ring-2 ring-amber-400/70",
              m.pending && "opacity-80"
            )}
          >
            {m.deleted_at ? (
              <p>Message unsent</p>
            ) : (
              <>
                {m.reply_to_id && (
                  <button
                    type="button"
                    onClick={() => m.reply_to_id && onJump(m.reply_to_id)}
                    className={cn(
                      "block w-full rounded-lg border-l-2 px-2 py-1 text-left text-xs",
                      mine ? "border-white/70 bg-white/15 text-white/90" : "border-primary bg-muted/70 text-muted-foreground"
                    )}
                  >
                    <span className="block font-medium">{m.reply_sender_id ? nameOf(m.reply_sender_id) : "Message"}</span>
                    <span className="line-clamp-2">
                      {m.reply_deleted ? "Message unsent" : m.reply_body ?? (m.reply_file_name ? `📎 ${m.reply_file_name}` : "…")}
                    </span>
                  </button>
                )}
                {m.file_name && <FileBubble message={m} mine={mine} onPreview={onPreview} />}
                {m.body && (
                  <p className="whitespace-pre-wrap break-words">
                    {mentionSegments(m.body, people).map((part, i) =>
                      part.userId ? (
                        <span
                          key={i}
                          className={cn(
                            "rounded px-0.5 font-semibold",
                            mine ? "bg-white/20" : part.userId === myId ? "bg-amber-400/25 text-foreground" : "text-primary"
                          )}
                        >
                          {part.text}
                        </span>
                      ) : (
                        <span key={i}>{part.text}</span>
                      )
                    )}
                  </p>
                )}
              </>
            )}
            <p className={cn("flex items-center justify-end gap-1 text-[10px]", mine && !m.deleted_at ? "text-white/70" : "text-muted-foreground")}>
              {pinned && <Pin className="h-2.5 w-2.5" />}
              {m.pending && <Loader2 className="h-2.5 w-2.5 animate-spin" />}
              {clockTime(m.created_at)}
            </p>
          </div>

          {live && (
            <div className="relative flex shrink-0 items-center opacity-0 transition-opacity focus-within:opacity-100 group-hover/msg:opacity-100">
              <button type="button" onClick={() => setPicker((p) => !p)} className={actionButton} aria-label="React" title="React">
                <SmilePlus className="h-3.5 w-3.5" />
              </button>
              <button type="button" onClick={onReply} className={actionButton} aria-label="Reply" title="Reply">
                <Reply className="h-3.5 w-3.5" />
              </button>
              {canPin && (
                <button type="button" onClick={() => onPin(!pinned)} className={actionButton} aria-label={pinned ? "Unpin" : "Pin"} title={pinned ? "Unpin" : "Pin"}>
                  {pinned ? <PinOff className="h-3.5 w-3.5" /> : <Pin className="h-3.5 w-3.5" />}
                </button>
              )}
              {m.body && (
                <button
                  type="button"
                  onClick={() => void navigator.clipboard?.writeText(m.body ?? "").then(() => toast.success("Copied"))}
                  className={actionButton}
                  aria-label="Copy text"
                  title="Copy text"
                >
                  <Copy className="h-3.5 w-3.5" />
                </button>
              )}
              {mine && (
                <button type="button" onClick={onUnsend} className={cn(actionButton, "hover:text-destructive")} aria-label="Unsend message" title="Unsend">
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              )}
              {picker && (
                <div
                  className={cn(
                    "absolute bottom-full z-10 mb-1 flex gap-0.5 rounded-full border bg-popover px-1.5 py-1 shadow-xl",
                    mine ? "right-0" : "left-0"
                  )}
                >
                  {REACTIONS.map((emoji) => (
                    <button
                      key={emoji}
                      type="button"
                      onClick={() => {
                        setPicker(false);
                        onReact(emoji);
                      }}
                      className="flex h-8 w-8 items-center justify-center rounded-full text-lg transition-transform hover:scale-125"
                      aria-label={`React ${emoji}`}
                    >
                      {emoji}
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>

        {m.failed && (
          <button type="button" onClick={onRetry} className="mt-0.5 flex items-center gap-1 text-[11px] text-destructive hover:underline">
            <AlertCircle className="h-3 w-3" />
            Not sent. <RotateCcw className="h-3 w-3" /> Retry
          </button>
        )}

        {reactions.length > 0 && !m.deleted_at && (
          <div className={cn("-mt-1 flex flex-wrap gap-1", mine ? "justify-end pr-1" : "pl-1")}>
            {reactions.map((r) => (
              <button
                key={r.emoji}
                type="button"
                onClick={() => onReact(r.emoji)}
                title={r.userIds.map((id) => (id === myId ? "You" : nameOf(id))).join(", ")}
                className={cn(
                  "flex items-center gap-0.5 rounded-full border bg-popover px-1.5 py-0.5 text-xs shadow-sm",
                  r.mine && "border-primary/50 bg-primary/10"
                )}
              >
                <span>{r.emoji}</span>
                {r.count > 1 && <span className="text-[10px] text-muted-foreground">{r.count}</span>}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

/** Pinned messages above the conversation; click one to jump to it. */
export function PinnedBar({
  pins,
  nameOf,
  canPin,
  onJump,
  onUnpin,
}: {
  pins: ChatPin[];
  nameOf: (id: string) => string;
  canPin: boolean;
  onJump: (messageId: string) => void;
  onUnpin: (messageId: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  if (!pins.length) return null;
  const shown = expanded ? pins : pins.slice(0, 1);
  return (
    <div className="border-b bg-background/80 backdrop-blur">
      {shown.map((p) => (
        <div key={p.message_id} className="flex items-center gap-2 px-3 py-1.5 text-xs">
          <Pin className="h-3.5 w-3.5 shrink-0 text-primary" />
          <button type="button" onClick={() => onJump(p.message_id)} className="min-w-0 flex-1 text-left">
            <span className="font-medium">{nameOf(p.sender_id)}: </span>
            <span className="text-muted-foreground">{p.body ?? (p.file_name ? `📎 ${p.file_name}` : "Message unsent")}</span>
          </button>
          {canPin && expanded && (
            <button type="button" onClick={() => onUnpin(p.message_id)} className="rounded p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground" aria-label="Unpin">
              <PinOff className="h-3.5 w-3.5" />
            </button>
          )}
        </div>
      ))}
      {pins.length > 1 && (
        <button
          type="button"
          onClick={() => setExpanded((e) => !e)}
          className="flex w-full items-center justify-center gap-1 pb-1 text-[11px] text-muted-foreground hover:text-foreground"
        >
          {expanded ? "Show less" : `${pins.length} pinned messages`}
          <ChevronDown className={cn("h-3 w-3 transition-transform", expanded && "rotate-180")} />
        </button>
      )}
    </div>
  );
}
