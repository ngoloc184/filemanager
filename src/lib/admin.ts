import "server-only";
import { cache } from "react";
import { notFound } from "next/navigation";
import { requireUser, type SessionUser } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";

/**
 * Whether the signed-in user is a site admin (public.app_admins, appointed
 * by SQL; 202608280044_custom_stickers.sql). False when signed out, when the
 * migration is missing or on any other error. Cached per request, so the
 * layout and the page share one round-trip.
 */
export const isAppAdmin = cache(async (): Promise<boolean> => {
  try {
    const supabase = await createClient();
    const { data, error } = await supabase.rpc("is_app_admin");
    return !error && data === true;
  } catch {
    return false;
  }
});

/**
 * The signed-in site admin. Redirects to the login page when signed out and
 * answers 404 to everyone else, so admin pages do not reveal they exist.
 */
export async function requireAppAdmin(): Promise<SessionUser> {
  const user = await requireUser();
  if (!(await isAppAdmin())) notFound();
  return user;
}
