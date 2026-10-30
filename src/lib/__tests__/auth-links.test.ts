import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  authErrorMessage,
  confirmRedirect,
  failedOutcome,
  failurePath,
  flowOf,
  isSameOriginPost,
  nextFromSearch,
  outcomeMessage,
  passwordProblem,
  requestOrigin,
  safeNext,
  withNext,
} from "../auth-links.ts";

describe("confirmRedirect", () => {
  it("points at /auth/confirm with the flow and where to continue", () => {
    const signup = new URL(confirmRedirect("https://files.example.com", "signup"));
    assert.equal(signup.pathname, "/auth/confirm");
    assert.equal(signup.searchParams.get("flow"), "signup");
    assert.equal(signup.searchParams.get("next"), "/dashboard");
    const recovery = new URL(confirmRedirect("https://files.example.com", "recovery"));
    assert.equal(recovery.searchParams.get("next"), "/forgot-password?step=password");
  });

  it("returns a sign-up to the requested page, never a reset", () => {
    const origin = "https://files.example.com";
    const signup = new URL(confirmRedirect(origin, "signup", "/invite/abc?x=1"));
    assert.equal(signup.searchParams.get("next"), "/invite/abc?x=1");
    const recovery = new URL(confirmRedirect(origin, "recovery", "/invite/abc"));
    assert.equal(recovery.searchParams.get("next"), "/forgot-password?step=password");
    for (const unsafe of ["//evil.com", "https://evil.com", "", null, undefined]) {
      const url = new URL(confirmRedirect(origin, "signup", unsafe));
      assert.equal(url.searchParams.get("next"), "/dashboard", JSON.stringify(unsafe));
    }
  });
});

describe("nextFromSearch", () => {
  const next = (value: string) => nextFromSearch(new URLSearchParams({ next: value }));

  it("accepts same-site paths with their query", () => {
    assert.equal(next("/invite/abc"), "/invite/abc");
    assert.equal(next("/documents?view=overdue"), "/documents?view=overdue");
    // as the middleware writes it: encoded in the login URL
    assert.equal(nextFromSearch(new URLSearchParams("next=%2Fdocuments%3Fview%3Doverdue")), "/documents?view=overdue");
  });

  it("rejects other sites, backslashes and control characters", () => {
    for (const evil of ["//evil.com", "https://evil.com", "/\\evil", "/\tevil", "/\n/evil.com", "/x\u0000", "/x\u007f", "evil", ""]) {
      assert.equal(next(evil), null, JSON.stringify(evil));
    }
  });

  it("is null without a next parameter", () => {
    assert.equal(nextFromSearch(new URLSearchParams()), null);
    assert.equal(nextFromSearch(null), null);
  });
});

describe("withNext", () => {
  it("keeps the next parameter on auth links", () => {
    assert.equal(withNext("/register", "/invite/abc"), "/register?next=%2Finvite%2Fabc");
    assert.equal(withNext("/forgot-password?email=a%40b.c", "/recent"), "/forgot-password?email=a%40b.c&next=%2Frecent");
    assert.equal(withNext("/login", null), "/login");
  });
});

describe("failedOutcome", () => {
  it("treats a sign-up link opened in another browser as confirmed", () => {
    assert.equal(failedOutcome({ flow: "signup", hadCode: true, errorCode: null }), "confirmed");
    assert.equal(failedOutcome({ flow: null, hadCode: true, errorCode: null }), "confirmed");
  });
  it("asks for the same browser for a password reset", () => {
    assert.equal(failedOutcome({ flow: "recovery", hadCode: true, errorCode: null }), "other-browser");
  });
  it("reports expired and invalid links", () => {
    assert.equal(failedOutcome({ flow: "signup", hadCode: false, errorCode: "otp_expired" }), "expired");
    assert.equal(failedOutcome({ flow: "signup", hadCode: false, errorCode: "access_denied" }), "invalid");
    assert.equal(failedOutcome({ flow: null, hadCode: false, errorCode: null }), "invalid");
  });
});

describe("passwordProblem", () => {
  it("checks length and confirmation", () => {
    assert.match(passwordProblem("123", "123") ?? "", /at least 6/);
    assert.match(passwordProblem("secret1", "secret2") ?? "", /do not match/);
    assert.equal(passwordProblem("secret1", "secret1"), null);
  });
});

describe("safeNext", () => {
  it("allows same-site paths only", () => {
    assert.equal(safeNext("/forgot-password?step=password"), "/forgot-password?step=password");
    assert.equal(safeNext("https://evil.example"), "/dashboard");
    assert.equal(safeNext("//evil.example/x"), "/dashboard");
    assert.equal(safeNext("/\\evil.example"), "/dashboard");
    assert.equal(safeNext(null), "/dashboard");
  });

  it("is not fooled by characters URL parsers drop", () => {
    for (const evil of ["/\t/evil.com", "/\n/evil.com", "/\r/evil.com", "/\t\t/evil.com", "/%2F/evil.com/../x"]) {
      const out = safeNext(evil);
      assert.equal(new URL(out, "https://app.example").origin, "https://app.example", JSON.stringify(evil));
    }
    assert.equal(safeNext("/\t/evil.com"), "/dashboard");
  });

  it("is not fooled by dot segments that collapse to //host", () => {
    for (const evil of ["/..//evil.com", "/.//evil.com", "/a/..//evil.com", "/%2e%2e//evil.com", "/.%2e//evil.com"]) {
      const out = safeNext(evil);
      assert.equal(new URL(out, "https://app.example").origin, "https://app.example", JSON.stringify(evil));
    }
    assert.equal(safeNext("/..//evil.com"), "/dashboard");
  });
});

describe("request origin", () => {
  const headers = (init: Record<string, string>) => new Headers(init);

  it("uses the public host behind a proxy, not the server's own address", () => {
    const h = headers({ host: "localhost:3000", "x-forwarded-host": "files.example.com", "x-forwarded-proto": "https" });
    assert.equal(requestOrigin(h, "http://localhost:3000"), "https://files.example.com");
    assert.equal(requestOrigin(headers({ host: "127.0.0.1:3000" }), "http://localhost:3000"), "http://127.0.0.1:3000");
    assert.equal(requestOrigin(headers({ host: "bad host/x" }), "http://localhost:3000"), "http://localhost:3000");
  });

  it("accepts same-origin posts only", () => {
    const expected = "https://files.example.com";
    assert.equal(isSameOriginPost(headers({ origin: expected }), expected), true);
    assert.equal(isSameOriginPost(headers({ "sec-fetch-site": "same-origin" }), expected), true);
    assert.equal(isSameOriginPost(headers({ origin: "https://evil.example", "sec-fetch-site": "cross-site" }), expected), false);
    assert.equal(isSameOriginPost(headers({ origin: "null" }), expected), false);
    assert.equal(isSameOriginPost(headers({}), expected), false);
  });
});

describe("failure handling", () => {
  it("routes failures to the page that can help", () => {
    assert.equal(failurePath("recovery", "expired"), "/forgot-password?error=expired");
    assert.equal(failurePath("signup", "confirmed"), "/login?notice=confirmed");
    assert.equal(failurePath(null, "invalid"), "/login?error=invalid");
  });

  it("keeps a sign-up link's next page through sign-in, never a reset's", () => {
    assert.equal(failurePath("signup", "confirmed", "/invite/abc"), "/login?notice=confirmed&next=%2Finvite%2Fabc");
    assert.equal(failurePath(null, "expired", "/recent"), "/login?error=expired&next=%2Frecent");
    assert.equal(failurePath("signup", "confirmed", "/dashboard"), "/login?notice=confirmed");
    assert.equal(failurePath("signup", "invalid", "//evil.com"), "/login?error=invalid");
    assert.equal(failurePath("recovery", "expired", "/invite/abc"), "/forgot-password?error=expired");
  });

  it("knows the flow from the parameter or the token type", () => {
    assert.equal(flowOf("recovery", "email"), "recovery");
    assert.equal(flowOf(null, "recovery"), "recovery");
    assert.equal(flowOf(null, "email"), "signup");
    assert.equal(flowOf("evil", null), null);
  });

  it("tells sign-up users that a used link may just mean they are confirmed", () => {
    assert.match(outcomeMessage("invalid", "signup"), /just sign in/);
    assert.match(outcomeMessage("invalid", "recovery"), /Request a new e-mail/);
    // Supabase reports a used link as otp_expired
    assert.match(outcomeMessage("expired", "signup"), /already used[\s\S]*just sign in/);
    assert.match(outcomeMessage("expired", "recovery"), /already used/);
  });
});

describe("authErrorMessage", () => {
  it("explains common Supabase errors", () => {
    assert.match(authErrorMessage({ message: "Email rate limit exceeded" }), /Too many e-mails/);
    assert.match(authErrorMessage({ code: "email_address_not_authorized", message: "Email address not authorized" }), /not configured/);
    assert.match(authErrorMessage({ message: "Email not confirmed" }), /Click the link/);
    assert.match(authErrorMessage({ message: "Auth session missing!" }), /link has expired/);
    assert.match(authErrorMessage({ message: "Invalid login credentials" }), /Wrong e-mail or password/);
  });
});
