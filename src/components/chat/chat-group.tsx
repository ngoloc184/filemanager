"use client";

// Group screens inside the chat panel: create a group, and the info panel
// (name, picture, background, pins, members and roles, leave / disband).

import { useRef, useState } from "react";
import {
  ArrowLeft,
  Camera,
  Check,
  Crown,
  ImagePlus,
  Loader2,
  LogOut,
  Pencil,
  Pin,
  PinOff,
  Shield,
  ShieldOff,
  Trash2,
  UserMinus,
  UserPlus,
  X,
} from "lucide-react";
import { toast } from "sonner";
import { iconButton } from "@/components/chat/chat-file";
import { UserAvatar } from "@/components/chat/user-avatar";
import { canEditGroup, canManageMembers, chatTitle, personName } from "@/lib/chat-format";
import { BACKGROUND_PRESETS, backgroundStyle } from "@/lib/chat-themes";
import {
  addMembers,
  deleteGroup,
  leaveGroup,
  removeMember,
  renameGroup,
  setGroupAdminOnly,
  setGroupAvatar,
  setGroupBackground,
  setMemberRole,
  transferOwnership,
  type ChatMember,
  type ChatPin,
  type ChatSummary,
} from "@/lib/services/chat";
import { publicImageUrl, removePublicImage, uploadPublicImage } from "@/lib/services/profile";
import { getErrorMessage } from "@/lib/types/database";
import { cn } from "@/lib/utils";

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const input =
  "h-9 min-w-0 flex-1 rounded-lg border bg-background/60 px-3 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50";

/** E-mail chips: type an address and press Enter or comma. */
function EmailChips({ emails, onChange, suggestions }: { emails: string[]; onChange: (emails: string[]) => void; suggestions: string[] }) {
  const [value, setValue] = useState("");
  const add = (raw: string) => {
    const parts = raw.split(/[\s,;]+/).map((e) => e.trim().toLowerCase()).filter(Boolean);
    const bad = parts.filter((e) => !EMAIL.test(e));
    if (bad.length) toast.error(`Invalid e-mail: ${bad.join(", ")}`);
    const good = parts.filter((e) => EMAIL.test(e) && !emails.includes(e));
    if (good.length) onChange([...emails, ...good]);
    setValue("");
  };
  const quick = suggestions.filter((s) => !emails.includes(s.toLowerCase())).slice(0, 8);
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-1.5 rounded-lg border bg-background/60 p-1.5 focus-within:border-ring">
        {emails.map((e) => (
          <span key={e} className="flex items-center gap-1 rounded-full bg-primary/10 px-2 py-0.5 text-xs text-primary">
            {e}
            <button type="button" onClick={() => onChange(emails.filter((x) => x !== e))} aria-label={`Remove ${e}`}>
              <X className="h-3 w-3" />
            </button>
          </span>
        ))}
        <input
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if ((e.key === "Enter" || e.key === "," || e.key === " ") && value.trim()) {
              e.preventDefault();
              add(value);
            } else if (e.key === "Backspace" && !value && emails.length) {
              onChange(emails.slice(0, -1));
            }
          }}
          onBlur={() => value.trim() && add(value)}
          placeholder={emails.length ? "Add more…" : "Member e-mails, press Enter"}
          aria-label="Member e-mails"
          className="h-7 min-w-[8rem] flex-1 bg-transparent px-1 text-sm outline-none"
        />
      </div>
      {quick.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {quick.map((s) => (
            <button key={s} type="button" onClick={() => onChange([...emails, s.toLowerCase()])} className="rounded-full border px-2 py-0.5 text-[11px] text-muted-foreground hover:border-primary/40 hover:text-foreground">
              + {s}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export function NewGroupView({
  suggestions,
  onBack,
  onCreate,
}: {
  suggestions: string[];
  onBack: () => void;
  onCreate: (title: string, emails: string[]) => Promise<void>;
}) {
  const [title, setTitle] = useState("");
  const [emails, setEmails] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  return (
    <>
      <header className="flex items-center gap-2 border-b px-3 py-2.5">
        <button type="button" onClick={onBack} className={iconButton} aria-label="Back to chats">
          <ArrowLeft className="h-4 w-4" />
        </button>
        <p className="text-sm font-semibold">New group</p>
      </header>
      <form
        className="flex-1 space-y-4 overflow-y-auto p-4"
        onSubmit={async (e) => {
          e.preventDefault();
          if (!title.trim() || !emails.length || busy) return;
          setBusy(true);
          try {
            await onCreate(title.trim(), emails);
          } catch (err) {
            toast.error(getErrorMessage(err));
          } finally {
            setBusy(false);
          }
        }}
      >
        <label className="block space-y-1.5">
          <span className="text-xs font-medium">Group name</span>
          <input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={100} placeholder="e.g. Marketing team" autoFocus className={cn(input, "w-full")} />
        </label>
        <div className="space-y-1.5">
          <span className="text-xs font-medium">Members</span>
          <EmailChips emails={emails} onChange={setEmails} suggestions={suggestions} />
          <p className="text-[11px] text-muted-foreground">You become the group owner. Members need an account.</p>
        </div>
        <button
          type="submit"
          disabled={!title.trim() || !emails.length || busy}
          className="flex h-10 w-full items-center justify-center gap-2 rounded-xl bg-brand text-sm font-medium text-white disabled:opacity-40"
        >
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <UserPlus className="h-4 w-4" />}
          Create group
        </button>
      </form>
    </>
  );
}

const ROLE_LABEL = { owner: "Owner", admin: "Admin", member: "" } as const;

export function InfoView({
  chat,
  members,
  pins,
  myId,
  nameOf,
  onBack,
  onChanged,
  onLeft,
  onJump,
  onUnpin,
}: {
  chat: ChatSummary;
  members: ChatMember[];
  pins: ChatPin[];
  myId: string;
  nameOf: (id: string) => string;
  onBack: () => void;
  onChanged: () => void;
  onLeft: () => void;
  onJump: (messageId: string) => void;
  onUnpin: (messageId: string) => void;
}) {
  const isGroup = chat.kind === "group";
  const editable = isGroup && canEditGroup(chat.my_role, chat.admin_only);
  const manager = isGroup && canManageMembers(chat.my_role);
  const owner = chat.my_role === "owner";
  const [renaming, setRenaming] = useState(false);
  const [title, setTitle] = useState(chat.title ?? "");
  const [adding, setAdding] = useState<string[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const avatarRef = useRef<HTMLInputElement>(null);
  const bgRef = useRef<HTMLInputElement>(null);

  const run = async (key: string, action: () => Promise<unknown>, done?: string) => {
    setBusy(key);
    try {
      await action();
      if (done) toast.success(done);
      onChanged();
      return true;
    } catch (err) {
      toast.error(getErrorMessage(err));
      return false;
    } finally {
      setBusy(null);
    }
  };

  const uploadTo = async (file: File | undefined, kind: "avatar" | "background") => {
    if (!file) return;
    const old = kind === "avatar" ? chat.avatar_path : chat.background?.startsWith("image:") ? chat.background.slice(6) : null;
    await run(kind, async () => {
      const path = await uploadPublicImage(`groups/${chat.id}`, file, kind === "avatar" ? 512 : 1600);
      if (kind === "avatar") await setGroupAvatar(chat.id, path);
      else await setGroupBackground(chat.id, `image:${path}`);
      void removePublicImage(old);
    });
  };

  const other = chat.kind === "direct" ? members.find((m) => m.user_id !== myId) ?? members[0] : null;

  return (
    <>
      <header className="flex items-center gap-2 border-b px-3 py-2.5">
        <button type="button" onClick={onBack} className={iconButton} aria-label="Back to the conversation">
          <ArrowLeft className="h-4 w-4" />
        </button>
        <p className="text-sm font-semibold">{isGroup ? "Group info" : "Conversation info"}</p>
      </header>

      <div className="flex-1 space-y-5 overflow-y-auto p-4">
        {/* identity */}
        <div className="flex flex-col items-center gap-2 text-center">
          <button
            type="button"
            disabled={!editable || busy !== null}
            onClick={() => avatarRef.current?.click()}
            className="group relative rounded-full disabled:cursor-default"
            aria-label={editable ? "Change group picture" : undefined}
          >
            <UserAvatar
              name={isGroup ? chat.title : personName({ email: other?.email ?? null, display_name: other?.display_name })}
              path={isGroup ? chat.avatar_path : other?.avatar_path}
              group={isGroup}
              size="lg"
            />
            {editable && (
              <span className="absolute inset-0 flex items-center justify-center rounded-full bg-black/45 text-white opacity-0 transition-opacity group-hover:opacity-100">
                {busy === "avatar" ? <Loader2 className="h-5 w-5 animate-spin" /> : <Camera className="h-5 w-5" />}
              </span>
            )}
          </button>
          <input ref={avatarRef} type="file" accept="image/*" className="hidden" onChange={(e) => {
            const f = e.target.files?.[0];
            e.target.value = "";
            void uploadTo(f, "avatar");
          }} />
          {renaming ? (
            <form
              className="flex w-full gap-1.5"
              onSubmit={async (e) => {
                e.preventDefault();
                if (await run("rename", () => renameGroup(chat.id, title))) setRenaming(false);
              }}
            >
              <input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={100} autoFocus className={input} aria-label="Group name" />
              <button type="submit" disabled={!title.trim() || busy !== null} className="rounded-lg bg-brand px-2.5 text-white disabled:opacity-40" aria-label="Save name">
                {busy === "rename" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}
              </button>
            </form>
          ) : (
            <div className="flex items-center gap-1">
              <p className="text-base font-semibold">{chatTitle(chat, myId)}</p>
              {editable && (
                <button type="button" onClick={() => setRenaming(true)} className={iconButton} aria-label="Rename group">
                  <Pencil className="h-3.5 w-3.5" />
                </button>
              )}
            </div>
          )}
          <p className="text-xs text-muted-foreground">{isGroup ? `${members.length} members` : other?.email}</p>
        </div>

        {/* background */}
        {isGroup && (
          <section className="space-y-2">
            <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Background</p>
            <div className="grid grid-cols-7 gap-1.5">
              <button
                type="button"
                disabled={!editable || busy !== null}
                onClick={() => void run("bg", () => setGroupBackground(chat.id, null))}
                className={cn("aspect-square rounded-lg border bg-background text-[9px] text-muted-foreground disabled:opacity-60", !chat.background && "ring-2 ring-primary")}
                title="Default"
              >
                None
              </button>
              {BACKGROUND_PRESETS.map((p) => (
                <button
                  key={p.key}
                  type="button"
                  disabled={!editable || busy !== null}
                  onClick={() => void run("bg", () => setGroupBackground(chat.id, `preset:${p.key}`))}
                  style={backgroundStyle(`preset:${p.key}`, () => "") ?? undefined}
                  className={cn("aspect-square rounded-lg border bg-background disabled:opacity-60", chat.background === `preset:${p.key}` && "ring-2 ring-primary")}
                  title={p.label}
                  aria-label={`Background ${p.label}`}
                />
              ))}
              <button
                type="button"
                disabled={!editable || busy !== null}
                onClick={() => bgRef.current?.click()}
                style={chat.background?.startsWith("image:") ? { backgroundImage: `url("${publicImageUrl(chat.background.slice(6))}")`, backgroundSize: "cover" } : undefined}
                className={cn(
                  "flex aspect-square items-center justify-center rounded-lg border border-dashed text-muted-foreground disabled:opacity-60",
                  chat.background?.startsWith("image:") && "ring-2 ring-primary"
                )}
                title="Upload a picture"
                aria-label="Upload a background picture"
              >
                {busy === "background" ? <Loader2 className="h-4 w-4 animate-spin" /> : <ImagePlus className="h-4 w-4" />}
              </button>
            </div>
            <input ref={bgRef} type="file" accept="image/*" className="hidden" onChange={(e) => {
              const f = e.target.files?.[0];
              e.target.value = "";
              void uploadTo(f, "background");
            }} />
            {!editable && <p className="text-[11px] text-muted-foreground">Only the owner and admins can change the group.</p>}
          </section>
        )}

        {/* pins */}
        <section className="space-y-1.5">
          <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Pinned messages ({pins.length}/3)</p>
          {pins.length === 0 ? (
            <p className="text-xs text-muted-foreground">Hover a message and choose <Pin className="inline h-3 w-3" /> to pin it.</p>
          ) : (
            pins.map((p) => (
              <div key={p.message_id} className="flex items-center gap-2 rounded-lg border bg-background/60 px-2.5 py-1.5 text-xs">
                <button type="button" onClick={() => onJump(p.message_id)} className="min-w-0 flex-1 truncate text-left">
                  <span className="font-medium">{nameOf(p.sender_id)}: </span>
                  {p.body ?? (p.file_name ? `📎 ${p.file_name}` : "")}
                </button>
                {(!isGroup || editable) && (
                  <button type="button" onClick={() => onUnpin(p.message_id)} className={iconButton} aria-label="Unpin">
                    <PinOff className="h-3.5 w-3.5" />
                  </button>
                )}
              </div>
            ))
          )}
        </section>

        {/* members */}
        {isGroup && (
          <section className="space-y-2">
            <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Members ({members.length})</p>
            {manager && (
              <form
                className="space-y-1.5"
                onSubmit={async (e) => {
                  e.preventDefault();
                  if (!adding.length) return;
                  const ok = await run("add", async () => {
                    const n = await addMembers(chat.id, adding);
                    toast.success(n ? `Added ${n} member${n > 1 ? "s" : ""}` : "Already in the group");
                  });
                  if (ok) setAdding([]);
                }}
              >
                <EmailChips emails={adding} onChange={setAdding} suggestions={[]} />
                {adding.length > 0 && (
                  <button type="submit" disabled={busy !== null} className="flex h-8 w-full items-center justify-center gap-1.5 rounded-lg bg-brand text-xs font-medium text-white disabled:opacity-40">
                    {busy === "add" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <UserPlus className="h-3.5 w-3.5" />}
                    Add to group
                  </button>
                )}
              </form>
            )}
            <div className="divide-y rounded-xl border bg-background/50">
              {members.map((m) => {
                const name = personName({ email: m.email, display_name: m.display_name });
                const me = m.user_id === myId;
                const canRemove = manager && !me && m.role !== "owner" && (owner || m.role === "member");
                return (
                  <div key={m.user_id} className="flex items-center gap-2.5 px-2.5 py-2">
                    <UserAvatar name={name} path={m.avatar_path} size="sm" />
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium">
                        {name}
                        {me && <span className="text-muted-foreground"> (you)</span>}
                      </p>
                      {ROLE_LABEL[m.role] && (
                        <p className="flex items-center gap-1 text-[11px] text-muted-foreground">
                          {m.role === "owner" ? <Crown className="h-3 w-3 text-amber-500" /> : <Shield className="h-3 w-3 text-primary" />}
                          {ROLE_LABEL[m.role]}
                        </p>
                      )}
                    </div>
                    {owner && !me && (
                      <>
                        <button
                          type="button"
                          disabled={busy !== null}
                          onClick={() => void run(`role-${m.user_id}`, () => setMemberRole(chat.id, m.user_id, m.role === "admin" ? "member" : "admin"))}
                          className={iconButton}
                          title={m.role === "admin" ? "Remove as admin" : "Make admin"}
                          aria-label={m.role === "admin" ? `Remove ${name} as admin` : `Make ${name} an admin`}
                        >
                          {m.role === "admin" ? <ShieldOff className="h-3.5 w-3.5" /> : <Shield className="h-3.5 w-3.5" />}
                        </button>
                        <button
                          type="button"
                          disabled={busy !== null}
                          onClick={() => {
                            if (window.confirm(`Make ${name} the group owner? You will become an admin.`)) {
                              void run(`owner-${m.user_id}`, () => transferOwnership(chat.id, m.user_id), `${name} is now the owner`);
                            }
                          }}
                          className={iconButton}
                          title="Make owner"
                          aria-label={`Make ${name} the owner`}
                        >
                          <Crown className="h-3.5 w-3.5" />
                        </button>
                      </>
                    )}
                    {canRemove && (
                      <button
                        type="button"
                        disabled={busy !== null}
                        onClick={() => {
                          if (window.confirm(`Remove ${name} from the group?`)) void run(`remove-${m.user_id}`, () => removeMember(chat.id, m.user_id));
                        }}
                        className={cn(iconButton, "hover:text-destructive")}
                        title="Remove from group"
                        aria-label={`Remove ${name}`}
                      >
                        <UserMinus className="h-3.5 w-3.5" />
                      </button>
                    )}
                  </div>
                );
              })}
            </div>
          </section>
        )}

        {/* settings and leaving */}
        {isGroup && (
          <section className="space-y-2">
            {owner && (
              <label className="flex cursor-pointer items-start gap-2.5 rounded-xl border bg-background/50 p-3">
                <input
                  type="checkbox"
                  checked={chat.admin_only}
                  disabled={busy !== null}
                  onChange={(e) => void run("admin-only", () => setGroupAdminOnly(chat.id, e.target.checked))}
                  className="mt-0.5 h-4 w-4 accent-[var(--primary)]"
                />
                <span className="text-xs">
                  <span className="block font-medium">Only the owner and admins can change the group</span>
                  <span className="text-muted-foreground">Name, picture, background and pinned messages.</span>
                </span>
              </label>
            )}
            <button
              type="button"
              disabled={busy !== null}
              onClick={async () => {
                if (owner && members.length > 1) {
                  toast.error("Make another member the owner first (crown icon), then leave.");
                  return;
                }
                if (!window.confirm("Leave this group?")) return;
                if (await run("leave", () => leaveGroup(chat.id), "You left the group")) onLeft();
              }}
              className="flex w-full items-center gap-2 rounded-xl border px-3 py-2 text-sm text-destructive hover:bg-destructive/10"
            >
              <LogOut className="h-4 w-4" />
              Leave group
            </button>
            {owner && (
              <button
                type="button"
                disabled={busy !== null}
                onClick={async () => {
                  if (!window.confirm("Disband the group? It is deleted for everyone, with all its messages.")) return;
                  const ok = await run(
                    "delete",
                    async () => {
                      // pictures can only be removed while the group exists
                      await removePublicImage(chat.avatar_path);
                      if (chat.background?.startsWith("image:")) await removePublicImage(chat.background.slice(6));
                      await deleteGroup(chat.id);
                    },
                    "Group disbanded"
                  );
                  if (ok) onLeft();
                }}
                className="flex w-full items-center gap-2 rounded-xl border border-destructive/40 px-3 py-2 text-sm text-destructive hover:bg-destructive/10"
              >
                <Trash2 className="h-4 w-4" />
                Disband group
              </button>
            )}
          </section>
        )}
      </div>
    </>
  );
}
