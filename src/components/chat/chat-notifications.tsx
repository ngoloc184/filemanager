"use client";

// Device notifications for new chat messages: the account switch (stored in
// user_preferences), this browser's permission and Web Push subscription, the
// bell button, a banner when the account has them on but this device has not
// allowed them yet, and a prompt after sign-in that asks once a week.

import { useCallback, useEffect, useRef, useState } from "react";
import { Bell, BellOff, BellRing, Loader2, X } from "lucide-react";
import { toast } from "sonner";
import type { NotifyPermission } from "@/lib/chat-notify";
import { ensurePushSubscription } from "@/lib/push-client";
import { getChatNotifications, setChatNotifications } from "@/lib/services/preferences";
import {
  notificationPermission,
  notificationWorker,
  requestNotificationPermission,
} from "@/lib/system-notifications";
import { getErrorMessage } from "@/lib/types/database";
import { cn } from "@/lib/utils";

const BLOCKED = "Notifications are blocked for this site. Allow them in your browser's site settings, then try again.";
const UNSUPPORTED = "This browser can't show notifications. On iPhone, add this site to the Home Screen first.";
const SNOOZE_KEY = "fm:notify-prompt-snoozed-until";
const SNOOZE_MS = 7 * 24 * 60 * 60 * 1000;

function snoozed(): boolean {
  try {
    return Number(window.localStorage.getItem(SNOOZE_KEY) ?? 0) > Date.now();
  } catch {
    return false;
  }
}

export type ChatNotifications = ReturnType<typeof useChatNotifications>;

export function useChatNotifications(userId: string) {
  const [enabled, setEnabled] = useState(false);
  const [permission, setPermission] = useState<NotifyPermission>("unsupported");
  const [saving, setSaving] = useState(false);
  /** this device has a Web Push subscription (notifications also with the app closed) */
  const [push, setPush] = useState(false);
  const [promptOpen, setPromptOpen] = useState(false);
  // read by realtime callbacks that outlive a render
  const live = useRef({ enabled, push });
  useEffect(() => {
    live.current = { enabled, push };
  }, [enabled, push]);

  useEffect(() => {
    let cancelled = false;
    const current = notificationPermission();
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setPermission(current);
    // after sign-in: offer notifications once a week until the browser was asked
    setPromptOpen(current === "default" && !snoozed());
    getChatNotifications(userId)
      .then(async (on) => {
        if (cancelled) return;
        setEnabled(on);
        if (on && notificationPermission() === "granted") {
          void notificationWorker();
          // renew this device's subscription for the signed-in account
          const subscribed = await ensurePushSubscription();
          if (!cancelled) setPush(subscribed);
        }
      })
      .catch(() => undefined);
    // the permission can change in the browser's settings while the app is open
    let status: PermissionStatus | null = null;
    navigator.permissions
      ?.query({ name: "notifications" })
      .then((s) => {
        if (cancelled) return;
        status = s;
        s.onchange = () => setPermission(notificationPermission());
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
      if (status) status.onchange = null;
    };
  }, [userId]);

  const save = useCallback(
    async (on: boolean) => {
      setSaving(true);
      try {
        await setChatNotifications(userId, on);
        setEnabled(on);
        return true;
      } catch (err) {
        toast.error(getErrorMessage(err));
        return false;
      } finally {
        setSaving(false);
      }
    },
    [userId]
  );

  /** Asks this browser for permission (from a click). */
  const allowHere = useCallback(async () => {
    const result = await requestNotificationPermission();
    setPermission(result);
    setPromptOpen(false);
    if (result === "granted") {
      void notificationWorker();
      void ensurePushSubscription().then(setPush);
      return true;
    }
    toast.error(result === "unsupported" ? UNSUPPORTED : BLOCKED);
    return false;
  }, []);

  const toggle = useCallback(async () => {
    if (enabled) {
      if (await save(false)) toast.success("Chat notifications are off.");
      return;
    }
    // ask first: the permission prompt only works directly after the click
    if (notificationPermission() !== "granted" && !(await allowHere())) return;
    if (!(await save(true))) return;
    const subscribed = await ensurePushSubscription();
    setPush(subscribed);
    toast.success(
      subscribed
        ? "Chat notifications are on for this device, also when the app is closed."
        : "Chat notifications are on. They show up while the app is open in a tab."
    );
  }, [enabled, save, allowHere]);

  /** "Later": ask again in a week. */
  const snooze = useCallback(() => {
    setPromptOpen(false);
    try {
      window.localStorage.setItem(SNOOZE_KEY, String(Date.now() + SNOOZE_MS));
    } catch {
      // not remembered: asked again next visit
    }
  }, []);

  /** "Turn on" in the prompt: permission, account switch and push in one click. */
  const enableFromPrompt = useCallback(async () => {
    setPromptOpen(false);
    if (enabled) {
      if (await allowHere()) setPush(await ensurePushSubscription());
      return;
    }
    await toggle();
  }, [enabled, allowHere, toggle]);

  return { enabled, permission, saving, push, promptOpen, toggle, allowHere, snooze, enableFromPrompt, live };
}

/** Bell in the chat header: turns system notifications on or off for the account. */
export function NotificationToggle({ notifications, className }: { notifications: ChatNotifications; className?: string }) {
  const { enabled, permission, saving, toggle } = notifications;
  const label = enabled ? "Turn off message notifications" : "Turn on message notifications";
  return (
    <button
      type="button"
      onClick={() => void toggle()}
      disabled={saving}
      aria-pressed={enabled}
      aria-label={label}
      title={permission === "unsupported" && !enabled ? UNSUPPORTED : label}
      className={cn(
        "relative rounded-lg p-1.5 hover:bg-muted disabled:opacity-50",
        enabled ? "text-primary" : "text-muted-foreground hover:text-foreground",
        className
      )}
    >
      {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : enabled ? <Bell className="h-4 w-4" /> : <BellOff className="h-4 w-4" />}
      {enabled && permission !== "granted" && (
        <span className="absolute right-1 top-1 h-1.5 w-1.5 rounded-full bg-amber-500" aria-hidden="true" />
      )}
    </button>
  );
}

/** The account has notifications on, but this browser has not allowed them. */
export function NotificationBanner({ notifications }: { notifications: ChatNotifications }) {
  const { enabled, permission, allowHere } = notifications;
  if (!enabled || permission === "granted") return null;
  return (
    <div className="flex items-center gap-2 border-b bg-amber-500/10 px-4 py-2 text-xs text-amber-800 dark:text-amber-200">
      <Bell className="h-3.5 w-3.5 shrink-0" />
      {permission === "default" ? (
        <>
          <p className="min-w-0 flex-1">Message notifications are on for your account.</p>
          <button type="button" onClick={() => void allowHere()} className="shrink-0 font-semibold underline-offset-2 hover:underline">
            Allow on this device
          </button>
        </>
      ) : (
        <p className="min-w-0 flex-1">{permission === "denied" ? BLOCKED : UNSUPPORTED}</p>
      )}
    </div>
  );
}

/** After sign-in: "Turn on message notifications on this device?" */
export function NotificationPrompt({ notifications, hidden }: { notifications: ChatNotifications; hidden?: boolean }) {
  const { promptOpen, permission, snooze, enableFromPrompt } = notifications;
  if (!promptOpen || permission !== "default" || hidden) return null;
  return (
    <div
      role="dialog"
      aria-label="Message notifications"
      className="fixed bottom-24 right-5 z-[61] w-[min(22rem,calc(100vw-2.5rem))] rounded-2xl border bg-popover/95 p-4 shadow-2xl backdrop-blur-xl"
    >
      <div className="flex items-start gap-3">
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-brand text-white shadow-lg shadow-primary/30">
          <BellRing className="h-4 w-4" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold">Get notified of new messages?</p>
          <p className="mt-0.5 text-xs text-muted-foreground">
            Messages show up on this device like in other chat apps, also when this site is closed. Your browser will ask for permission.
          </p>
        </div>
        <button type="button" onClick={snooze} className="rounded-md p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground" aria-label="Not now">
          <X className="h-4 w-4" />
        </button>
      </div>
      <div className="mt-3 flex justify-end gap-2">
        <button type="button" onClick={snooze} className="rounded-lg px-3 py-1.5 text-xs font-medium text-muted-foreground hover:bg-muted hover:text-foreground">
          Later
        </button>
        <button
          type="button"
          onClick={() => void enableFromPrompt()}
          className="rounded-lg bg-brand px-3 py-1.5 text-xs font-medium text-white shadow-md shadow-primary/30"
        >
          Turn on
        </button>
      </div>
    </div>
  );
}
