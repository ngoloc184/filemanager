import "server-only";
import { headers } from "next/headers";

/** Reads the client IP from proxy headers (set by Vercel / the load balancer). */
export function clientIpFromHeaders(headerStore: Headers): string | null {
  const forwarded = headerStore.get("x-forwarded-for");
  const first = forwarded?.split(",")[0]?.trim();
  if (first) return first;
  return headerStore.get("x-real-ip")?.trim() || null;
}

export async function getClientIp(): Promise<string> {
  return clientIpFromHeaders(await headers()) ?? "unknown";
}

/**
 * Absolute origin used in e-mail links and OAuth redirect URLs. Prefer the
 * configured SITE_URL so links never depend on a client-supplied Host header;
 * Supabase additionally rejects redirect URLs outside its allow-list.
 */
export async function getSiteOrigin(): Promise<string> {
  const configured = process.env.SITE_URL;
  if (configured) {
    try {
      return new URL(configured).origin;
    } catch {
      console.warn("[auth] SITE_URL is not a valid URL; falling back to the request host.");
    }
  }
  const headerStore = await headers();
  const host = headerStore.get("x-forwarded-host") ?? headerStore.get("host") ?? "localhost:3000";
  const proto =
    headerStore.get("x-forwarded-proto")?.split(",")[0]?.trim() ||
    (process.env.NODE_ENV === "production" ? "https" : "http");
  return `${proto}://${host}`;
}

/**
 * CSRF guard for form POSTs to route handlers (Server Actions get the same
 * check from Next.js): the browser's Origin must match the host it posted to.
 */
export function isSameOriginRequest(request: Request): boolean {
  const origin = request.headers.get("origin");
  const host = request.headers.get("x-forwarded-host") ?? request.headers.get("host");
  if (origin) {
    try {
      return new URL(origin).host === host;
    } catch {
      return false;
    }
  }
  const fetchSite = request.headers.get("sec-fetch-site");
  return !fetchSite || fetchSite === "same-origin" || fetchSite === "none";
}
