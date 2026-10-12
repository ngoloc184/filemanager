import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  isValidEmail,
  normalizeEmail,
  normalizeOtp,
  passwordProblemMessage,
  passwordProblems,
} from "../auth/validation.ts";
import { safeNextPath } from "../auth/redirect.ts";
import {
  REMEMBER_ME_MAX_AGE,
  authCookieOptions,
  isPersistentSession,
} from "../auth/cookie-policy.ts";
import { authErrorCode, authErrorMessage, isKnownAuthErrorCode } from "../auth/errors.ts";
import { consumeAll, createMemoryRateLimitStore } from "../auth/rate-limit.ts";
import { accountNotice, loginNotice } from "../auth/notices.ts";
import { authenticatedRecently, parseAmr } from "../auth/amr.ts";

describe("email normalisation and validation", () => {
  it("trims and lower-cases addresses", () => {
    assert.equal(normalizeEmail("  User.Name+Tag@Example.COM \n"), "user.name+tag@example.com");
    assert.equal(normalizeEmail(undefined), "");
    assert.equal(normalizeEmail(42), "");
  });

  it("accepts any provider, not only Gmail", () => {
    for (const email of [
      "someone@gmail.com",
      "a.b-c+d@company.vn",
      "x@sub.domain.edu.vn",
      "first_last@outlook.com",
    ]) {
      assert.equal(isValidEmail(normalizeEmail(email)), true, email);
    }
  });

  it("rejects malformed addresses", () => {
    for (const email of [
      "",
      "plainaddress",
      "@example.com",
      "user@",
      "user@localhost",
      "user@@example.com",
      "user@exa mple.com",
      "user..dots@example.com",
      ".user@example.com",
      "user@-example.com",
      "user@example.c",
      `${"a".repeat(65)}@example.com`,
    ]) {
      assert.equal(isValidEmail(normalizeEmail(email)), false, email);
    }
  });
});

describe("password policy", () => {
  it("requires length, lower, upper and digit", () => {
    assert.deepEqual(passwordProblems("Abcdefg1"), []);
    assert.deepEqual(passwordProblems("abc"), ["length", "uppercase", "digit"]);
    assert.ok(passwordProblems("ABCDEFG1").includes("lowercase"));
    assert.ok(passwordProblems("abcdefgh1").includes("uppercase"));
    assert.ok(passwordProblems("Abcdefgh").includes("digit"));
  });

  it("limits the byte length bcrypt can use", () => {
    assert.ok(passwordProblems(`Aa1${"x".repeat(70)}`).includes("maxBytes"));
    // Multi-byte characters count in bytes.
    assert.ok(passwordProblems(`Aa1${"ệ".repeat(24)}`).includes("maxBytes"));
  });

  it("refuses the e-mail address as password", () => {
    assert.ok(passwordProblems("User@Example.com1", "user@example.com1").includes("notEmail"));
  });

  it("produces one message for the first problem", () => {
    assert.equal(passwordProblemMessage([]), null);
    assert.match(passwordProblemMessage(["length"]) ?? "", /8 ký tự/);
    assert.match(passwordProblemMessage(["maxBytes", "length"]) ?? "", /quá dài/);
  });

  it("normalises one-time codes", () => {
    assert.equal(normalizeOtp(" 123 456 "), "123456");
    assert.equal(normalizeOtp("12345"), null);
    assert.equal(normalizeOtp("12345a"), null);
    assert.equal(normalizeOtp(undefined), null);
  });
});

describe("safeNextPath (open-redirect protection)", () => {
  it("keeps same-origin paths with query and hash", () => {
    assert.equal(safeNextPath("/dashboard"), "/dashboard");
    assert.equal(safeNextPath("/shared?folder=1#top"), "/shared?folder=1#top");
    assert.equal(safeNextPath("/account?linked=google"), "/account?linked=google");
  });

  it("rejects external and tricky destinations", () => {
    for (const value of [
      "https://evil.example",
      "//evil.example/path",
      "/\\evil.example",
      "\\\\evil.example",
      "javascript:alert(1)",
      "/foo\nbar",
      "dashboard",
      "",
      null,
      undefined,
      42,
    ]) {
      assert.equal(safeNextPath(value), "/dashboard", String(value));
    }
  });

  it("never returns to auth pages", () => {
    assert.equal(safeNextPath("/login"), "/dashboard");
    assert.equal(safeNextPath("/register?x=1"), "/dashboard");
    assert.equal(safeNextPath("/auth/callback?code=1"), "/dashboard");
    assert.equal(safeNextPath("/api/auth/token"), "/dashboard");
    assert.equal(safeNextPath("/loginx"), "/loginx");
  });

  it("uses the provided fallback", () => {
    assert.equal(safeNextPath("https://x.y", "/reset-password"), "/reset-password");
  });
});

describe("session cookie policy", () => {
  const supabaseDefaults = { path: "/", sameSite: "lax" as const, httpOnly: false, maxAge: 400 * 24 * 3600 };

  it("hardens cookies and applies the remember-me lifetime", () => {
    const options = authCookieOptions(supabaseDefaults, { persistent: true, secure: true });
    assert.equal(options.httpOnly, true);
    assert.equal(options.secure, true);
    assert.equal(options.sameSite, "lax");
    assert.equal(options.maxAge, REMEMBER_ME_MAX_AGE);
  });

  it("uses browser-session cookies without remember-me", () => {
    const options = authCookieOptions(
      { ...supabaseDefaults, expires: new Date() },
      { persistent: false, secure: false }
    );
    assert.equal(options.maxAge, undefined);
    assert.equal(options.expires, undefined);
    assert.equal(options.httpOnly, true);
    assert.equal(options.secure, false);
  });

  it("keeps deletions as deletions", () => {
    const options = authCookieOptions({ ...supabaseDefaults, maxAge: 0 }, { persistent: true, secure: true });
    assert.equal(options.maxAge, 0);
  });

  it("is persistent unless the user opted out", () => {
    assert.equal(isPersistentSession(undefined), true);
    assert.equal(isPersistentSession("1"), true);
    assert.equal(isPersistentSession("0"), false);
  });
});

describe("auth error messages", () => {
  it("maps Supabase error codes", () => {
    assert.equal(authErrorCode({ code: "invalid_credentials", status: 400 }), "invalid_credentials");
    assert.match(authErrorMessage({ code: "invalid_credentials" }), /không đúng/);
    assert.match(authErrorMessage({ code: "email_not_confirmed" }), /chưa được xác minh/);
  });

  it("recognises legacy messages and network failures", () => {
    assert.equal(authErrorCode({ message: "Invalid login credentials", status: 400 }), "invalid_credentials");
    assert.equal(authErrorCode({ message: "User already registered" }), "user_already_exists");
    assert.equal(authErrorCode({ name: "AuthRetryableFetchError", status: 0 }), "network");
    assert.equal(authErrorCode({ status: 429 }), "over_request_rate_limit");
  });

  it("never echoes unknown provider text", () => {
    const message = authErrorMessage({ message: "<script>internal detail</script>" });
    assert.doesNotMatch(message, /script|internal/);
    assert.equal(isKnownAuthErrorCode("<b>hi</b>"), false);
  });
});

describe("rate limiting", () => {
  it("blocks after the limit and resets after the window", async () => {
    let now = 0;
    const store = createMemoryRateLimitStore(() => now);
    const rule = { limit: 2, windowSeconds: 60 };

    assert.equal((await store.hit("k", rule, true)).allowed, true);
    assert.equal((await store.hit("k", rule, true)).allowed, true);
    const blocked = await store.hit("k", rule, true);
    assert.equal(blocked.allowed, false);
    assert.equal(blocked.retryAfterSeconds, 60);

    now = 30_000;
    assert.equal((await store.hit("k", rule, false)).retryAfterSeconds, 30);

    now = 61_000;
    assert.equal((await store.hit("k", rule, false)).allowed, true);
    assert.equal((await store.hit("k", rule, true)).allowed, true);
  });

  it("peeking does not count as an attempt", async () => {
    const store = createMemoryRateLimitStore(() => 0);
    const rule = { limit: 1, windowSeconds: 60 };
    for (let i = 0; i < 5; i += 1) assert.equal((await store.hit("p", rule, false)).allowed, true);
    assert.equal((await store.hit("p", rule, true)).allowed, true);
    assert.equal((await store.hit("p", rule, false)).allowed, false);
    await store.reset("p");
    assert.equal((await store.hit("p", rule, false)).allowed, true);
  });

  it("consumeAll counts every key and reports the strictest", async () => {
    let now = 0;
    const store = createMemoryRateLimitStore(() => now);
    const strict = { limit: 1, windowSeconds: 600 };
    const loose = { limit: 10, windowSeconds: 60 };
    await consumeAll(store, [{ key: "ip", rule: loose }, { key: "mail", rule: strict }]);
    now = 1000;
    const result = await consumeAll(store, [{ key: "ip", rule: loose }, { key: "mail", rule: strict }]);
    assert.equal(result.allowed, false);
    assert.equal(result.retryAfterSeconds, 599);
  });
});

describe("redirect notices", () => {
  it("only shows whitelisted texts", () => {
    assert.equal(loginNotice({ reason: "expired" })?.tone, "info");
    assert.equal(loginNotice({ message: "signed_out" })?.tone, "success");
    assert.equal(loginNotice({ message: "<img src=x>" }), null);
    const injected = loginNotice({ error: "Click here: evil.example" });
    assert.equal(injected?.tone, "error");
    assert.doesNotMatch(injected?.message ?? "", /evil/);
    assert.match(loginNotice({ error: "access_denied" })?.message ?? "", /hủy/);
  });

  it("covers account page results", () => {
    assert.equal(accountNotice({ linked: "google" })?.tone, "success");
    assert.equal(accountNotice({ email: "pending" })?.tone, "info");
    assert.equal(accountNotice({ error: "identity_already_exists" })?.tone, "error");
    assert.equal(accountNotice({}), null);
  });
});

describe("session authentication methods (amr)", () => {
  const now = 1_800_000_000;

  it("ignores malformed entries", () => {
    assert.deepEqual(parseAmr(undefined), []);
    assert.deepEqual(parseAmr([{ method: "password" }, null, { method: "otp", timestamp: 5 }]), [
      { method: "otp", timestamp: 5 },
    ]);
  });

  it("accepts only recent recovery sessions for password resets", () => {
    const recovery = [{ method: "recovery", timestamp: now - 600 }];
    assert.equal(authenticatedRecently(recovery, 3600, ["recovery"], now), true);
    assert.equal(authenticatedRecently(recovery, 300, ["recovery"], now), false);
    assert.equal(authenticatedRecently([{ method: "password", timestamp: now }], 3600, ["recovery"], now), false);
    // A timestamp from the future is not trusted.
    assert.equal(authenticatedRecently([{ method: "recovery", timestamp: now + 3600 }], 3600, ["recovery"], now), false);
  });

  it("checks for any recent sign-in when no method is given", () => {
    assert.equal(authenticatedRecently([{ method: "oauth", timestamp: now - 100 }], 86400, undefined, now), true);
    assert.equal(authenticatedRecently([{ method: "oauth", timestamp: now - 90000 }], 86400, undefined, now), false);
  });
});
