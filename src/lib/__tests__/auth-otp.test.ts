import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { authErrorMessage, cleanOtp, isOtpComplete, passwordProblem, safeNext } from "../auth-otp.ts";

describe("OTP input", () => {
  it("keeps digits only, up to 10", () => {
    assert.equal(cleanOtp(" 123 456 "), "123456");
    assert.equal(cleanOtp("Mã của bạn: 987-654"), "987654");
    assert.equal(cleanOtp("12345678901234"), "1234567890");
  });

  it("needs 6 to 10 digits", () => {
    assert.equal(isOtpComplete("12345"), false);
    assert.equal(isOtpComplete("123456"), true);
    assert.equal(isOtpComplete("12345678"), true);
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
});

describe("authErrorMessage", () => {
  it("explains common Supabase errors", () => {
    assert.match(authErrorMessage({ code: "otp_expired", message: "Token has expired or is invalid" }), /wrong or has expired/);
    assert.match(authErrorMessage({ message: "Email rate limit exceeded" }), /Too many e-mails/);
    assert.match(authErrorMessage({ code: "email_address_not_authorized", message: "Email address not authorized" }), /not configured/);
    assert.match(authErrorMessage({ message: "Email not confirmed" }), /not confirmed/);
    assert.match(authErrorMessage({ message: "Invalid login credentials" }), /Wrong e-mail or password/);
    assert.equal(authErrorMessage({ message: "Other" }), "Other");
  });
});
