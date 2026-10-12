"use client";

import { createClient as createSupabaseClient, type SupabaseClient } from "@supabase/supabase-js";

// The session lives in HttpOnly cookies the browser cannot read. Data calls
// (PostgREST, Storage) authenticate with a short-lived access token fetched
// from GET /api/auth/token; the refresh token never reaches JavaScript.
// Sign-in, sign-up and sign-out go through Server Actions instead of
// `supabase.auth`, which is unavailable on this client.

const TOKEN_ENDPOINT = "/api/auth/token";
/** Fetch a fresh token this long before the current one expires. */
const REFRESH_MARGIN_MS = 60_000;

let cachedClient: SupabaseClient | null = null;
let cachedToken: { value: string; refreshAt: number } | null = null;
let pendingToken: Promise<string | null> | null = null;
let hadSession = false;

function handleSessionLost() {
  // The session ended while this page was open (signed out in another tab,
  // revoked, or expired): send the user back to sign in.
  if (!hadSession) return;
  hadSession = false;
  const next = `${window.location.pathname}${window.location.search}`;
  window.location.replace(`/login?reason=expired&next=${encodeURIComponent(next)}`);
}

async function requestAccessToken(): Promise<string | null> {
  const response = await fetch(TOKEN_ENDPOINT, {
    credentials: "same-origin",
    cache: "no-store",
    headers: { Accept: "application/json" },
  });
  if (response.status === 401) {
    cachedToken = null;
    handleSessionLost();
    return null;
  }
  if (!response.ok) {
    throw new Error("Could not load the session. Please reload the page.");
  }
  const { accessToken, expiresIn } = (await response.json()) as {
    accessToken: string;
    expiresIn: number;
  };
  // Relative lifetime, so a skewed client clock does not matter.
  cachedToken = {
    value: accessToken,
    refreshAt: Date.now() + expiresIn * 1000 - REFRESH_MARGIN_MS,
  };
  hadSession = true;
  return accessToken;
}

/** Current access token, or null when signed out (requests then use the anon key). */
export async function getAccessToken(): Promise<string | null> {
  if (cachedToken && Date.now() < cachedToken.refreshAt) return cachedToken.value;
  pendingToken ??= requestAccessToken().finally(() => {
    pendingToken = null;
  });
  return pendingToken;
}

/** Forgets the cached token (call before signing out). */
export function resetBrowserSession(): void {
  cachedToken = null;
  hadSession = false;
}

export function createClient() {
  if (!cachedClient) {
    cachedClient = createSupabaseClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
      { accessToken: getAccessToken }
    );
  }
  return cachedClient;
}
