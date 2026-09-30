import "server-only";
import { cache } from "react";
import { redirect } from "next/navigation";
import type { User } from "@supabase/supabase-js";
import { createClient } from "@/lib/supabase/server";

/** The minimal user shape handed to Client Components. */
export type SessionUser = { id: string; email?: string };

/**
 * Returns the authenticated user for the current request.
 * Wrapped in React `cache` so layouts and pages rendered for the same request
 * share a single round-trip to Supabase Auth.
 */
export const getCurrentUser = cache(async (): Promise<User | null> => {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  return user;
});

/** Returns the authenticated user or redirects to the login page. */
export async function requireUser(): Promise<SessionUser> {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  return { id: user.id, email: user.email ?? undefined };
}
