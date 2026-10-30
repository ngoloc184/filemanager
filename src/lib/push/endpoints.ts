// Push services a subscription may point at (unit-tested). The server only
// ever sends to these hosts, so a stored subscription cannot turn the push
// sender into a request forger. Same pattern as the push_subscriptions check
// in supabase/migrations/202608280030_security_hardening.sql.

/** Chrome/Android (FCM), Firefox (Mozilla autopush), Edge (WNS), Safari (Apple). */
export const PUSH_ENDPOINT_PATTERN =
  /^https:\/\/(fcm\.googleapis\.com|[a-z0-9.-]*push\.services\.mozilla\.com|[a-z0-9.-]+\.notify\.windows\.com|web\.push\.apple\.com)\//;

const PUSH_HOST_PATTERN =
  /^(fcm\.googleapis\.com|[a-z0-9.-]*push\.services\.mozilla\.com|[a-z0-9.-]+\.notify\.windows\.com|web\.push\.apple\.com)$/;

/** True when `url` is an https URL on one of the allowed push services. */
export function isAllowedPushEndpoint(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  return (
    parsed.protocol === "https:" &&
    !parsed.username &&
    !parsed.password &&
    !parsed.port &&
    PUSH_HOST_PATTERN.test(parsed.hostname) &&
    PUSH_ENDPOINT_PATTERN.test(url)
  );
}
