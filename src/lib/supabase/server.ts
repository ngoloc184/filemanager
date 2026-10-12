import { createServerClient } from "@supabase/ssr";
import { cookies, headers } from "next/headers";
import {
  REMEMBER_COOKIE,
  authCookieOptions,
  isPersistentSession,
  secureCookies,
} from "@/lib/auth/cookie-policy";
import { clientIpFromHeaders } from "@/lib/auth/request-context";

type ServerClientOptions = {
  /**
   * Lifetime of the session cookies written by this client. Defaults to the
   * user's "Remember me" choice stored in the REMEMBER_COOKIE marker.
   */
  persistent?: boolean;
};

export async function createClient({ persistent }: ServerClientOptions = {}) {
  const cookieStore = await cookies();
  const clientIp = clientIpFromHeaders(await headers());

  return createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      // Auth calls are made from this server, so tell Supabase Auth which
      // client they are for (used for its per-IP rate limits when enabled).
      global: clientIp ? { headers: { "Sb-Forwarded-For": clientIp } } : undefined,
      cookies: {
        getAll() {
          return cookieStore.getAll();
        },
        setAll(cookiesToSet) {
          const policy = {
            persistent:
              persistent ?? isPersistentSession(cookieStore.get(REMEMBER_COOKIE)?.value),
            secure: secureCookies(),
          };
          try {
            cookiesToSet.forEach(({ name, value, options }) =>
              cookieStore.set(name, value, authCookieOptions(options, policy))
            );
          } catch {
            // setAll called from a Server Component — ignore
          }
        },
      },
    }
  );
}
