import { useSyncExternalStore } from "react";
import type { AuthChangeEvent, Session } from "@supabase/supabase-js";
import { createClient } from "@/lib/supabase/client";
import { getErrorMessage } from "@/lib/types/database";

/** Public bucket for profile pictures, group pictures and backgrounds. */
export const PUBLIC_IMAGES = "public-images";

export type MyProfile = { id: string; email: string; display_name: string | null; avatar_path: string | null };

function profileError(error: unknown): Error {
  const code = (error as { code?: string } | null)?.code;
  const message = getErrorMessage(error);
  if (code === "PGRST202" || /could not find the function/i.test(message)) {
    return new Error("Profiles are not set up yet. Run migration 202608280027_chat_groups.sql.");
  }
  return new Error(message);
}

/** Public URL of an image path (no request: built from the project URL). */
export function publicImageUrl(path: string | null | undefined): string | null {
  if (!path) return null;
  return createClient().storage.from(PUBLIC_IMAGES).getPublicUrl(path).data.publicUrl;
}

/**
 * Shrinks a picture in the browser before upload (fast to send and to show):
 * longest side `max` px, WebP. GIFs and images that fail to decode go as is.
 */
export async function shrinkImage(file: File, max: number): Promise<Blob> {
  if (!file.type.startsWith("image/")) throw new Error("Choose an image file.");
  if (file.type === "image/gif") return file;
  try {
    const bitmap = await createImageBitmap(file);
    const scale = Math.min(1, max / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(bitmap.width * scale);
    canvas.height = Math.round(bitmap.height * scale);
    canvas.getContext("2d")?.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    bitmap.close();
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/webp", 0.86));
    return blob ?? file;
  } catch {
    return file;
  }
}

const MAX_UPLOAD = 5 * 1024 * 1024;

/** Uploads a picture under `folder` ("users/<id>" or "groups/<id>"); returns its path. */
export async function uploadPublicImage(folder: string, file: File, max = 512): Promise<string> {
  const blob = await shrinkImage(file, max);
  if (blob.size > MAX_UPLOAD) throw new Error("The picture is larger than 5 MB.");
  const ext = blob.type === "image/webp" ? "webp" : blob.type === "image/png" ? "png" : blob.type === "image/gif" ? "gif" : "jpg";
  const path = `${folder}/${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}.${ext}`;
  const { error } = await createClient()
    .storage.from(PUBLIC_IMAGES)
    .upload(path, blob, { contentType: blob.type || file.type, cacheControl: "31536000", upsert: false });
  if (error) throw new Error(getErrorMessage(error));
  return path;
}

/** Best effort: an old picture that is no longer used. */
export async function removePublicImage(path: string | null | undefined): Promise<void> {
  if (!path) return;
  await createClient().storage.from(PUBLIC_IMAGES).remove([path]).catch(() => undefined);
}

export async function getMyProfile(): Promise<MyProfile | null> {
  const { data, error } = await createClient().rpc("get_my_profile");
  if (error) throw profileError(error);
  return ((data ?? []) as MyProfile[])[0] ?? null;
}

export async function updateMyProfile(displayName: string | null, avatarPath: string | null): Promise<void> {
  const { error } = await createClient().rpc("update_my_profile", { p_display_name: displayName, p_avatar_path: avatarPath });
  if (error) throw profileError(error);
}

// ---------------------------------------------------------------- shared store (sidebar, chat, dialog)

let profile: MyProfile | null = null;
let loading: Promise<void> | null = null;
let watchingAuth = false;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());

export function loadMyProfile(force = false): Promise<void> {
  if (!loading || force) {
    const request = getMyProfile()
      .then((p) => {
        // a sign-out or another account meanwhile: this answer is stale
        if (loading !== request) return;
        profile = p;
        emit();
      })
      .catch(() => undefined);
    loading = request;
  }
  return loading;
}

/** Another account in the same tab (sign out, sign in) must not see this profile. */
function watchAuth() {
  if (watchingAuth) return;
  watchingAuth = true;
  createClient().auth.onAuthStateChange((_event: AuthChangeEvent, session: Session | null) => {
    const id = session?.user?.id ?? null;
    if (profile?.id === id && loading) return;
    profile = null;
    loading = null;
    emit();
    if (id && listeners.size) void loadMyProfile();
  });
}

export function setMyProfileLocal(next: MyProfile) {
  profile = next;
  emit();
}

/** My profile, loaded once and shared; null until loaded. */
export function useMyProfile(): MyProfile | null {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      watchAuth();
      void loadMyProfile();
      return () => listeners.delete(listener);
    },
    () => profile,
    () => null
  );
}
