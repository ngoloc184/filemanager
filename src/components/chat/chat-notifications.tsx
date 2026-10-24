"use client";

// System notifications for new chat messages: the account switch (stored in
// user_preferences), this browser's permission, the bell button and a banner
// when the account has them on but this device has not allowed them yet.

import { useCallback, useEffect, useRef, useState } from "react";
import { Bell, BellOff, Loader2 } from "lucide-react";
import { toast } from "sonner";
import type { NotifyPermission } from "@/lib/chat-notify";
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

export type ChatNotifications = ReturnType<typeof useChatNotifications>;

export function useChatNotifications(userId: string) {
  const [enabled, setEnabled] = useState(false);
  const [permission, setPermission] = useState<NotifyPermission>("unsupported");
  const [saving, setSaving] = useState(false);
  // read by realtime callbacks that outlive a render
  const live = useRef({ enabled });
  useEffect(() => {
    live.current = { enabled };
  }, [enabled]);

  useEffect(() => {
    let cancelled = false;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setPermission(notificationPermission());
    getChatNotifications(userId)
      .then((on) => {
        if (cancelled) return;
        setEnabled(on);
        if (on && notificationPermission() === "granted") void notificationWorker();
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
    if (result === "granted") {
      void notificationWorker();
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
    if (await save(true)) toast.success("Chat notifications are on. New messages show up even when this tab is in the background.");
  }, [enabled, save, allowHere]);

  return { enabled, permission, saving, toggle, allowHere, live };
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
