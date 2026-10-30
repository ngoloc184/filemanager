import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { isCronAuthorized } from "../cron-auth.ts";

const SECRET = "s3cr3t-value-for-tests";

describe("isCronAuthorized", () => {
  it("refuses everything when no secret is configured", () => {
    for (const secret of [undefined, ""]) {
      assert.equal(isCronAuthorized(new Headers(), secret), false);
      assert.equal(isCronAuthorized(new Headers({ authorization: "Bearer " }), secret), false);
      assert.equal(isCronAuthorized(new Headers({ "x-cron-secret": "" }), secret), false);
      assert.equal(isCronAuthorized(new Headers({ authorization: "Bearer undefined" }), secret), false);
    }
  });

  it("refuses a request without the secret or with a wrong one", () => {
    assert.equal(isCronAuthorized(new Headers(), SECRET), false);
    assert.equal(isCronAuthorized(new Headers({ authorization: "Bearer wrong-value-for-tests!" }), SECRET), false);
    assert.equal(isCronAuthorized(new Headers({ "x-cron-secret": "wrong-value-for-tests!" }), SECRET), false);
    // the bare secret is not a valid Authorization header
    assert.equal(isCronAuthorized(new Headers({ authorization: SECRET }), SECRET), false);
    assert.equal(isCronAuthorized(new Headers({ authorization: `Basic ${SECRET}` }), SECRET), false);
    // and "Bearer <secret>" is not a valid x-cron-secret
    assert.equal(isCronAuthorized(new Headers({ "x-cron-secret": `Bearer ${SECRET}` }), SECRET), false);
  });

  it("accepts Authorization: Bearer <secret> (Vercel Cron)", () => {
    assert.equal(isCronAuthorized(new Headers({ authorization: `Bearer ${SECRET}` }), SECRET), true);
  });

  it("accepts x-cron-secret: <secret>", () => {
    assert.equal(isCronAuthorized(new Headers({ "x-cron-secret": SECRET }), SECRET), true);
  });

  it("accepts one valid header even when the other is wrong", () => {
    const headers = new Headers({ authorization: "Bearer nope", "x-cron-secret": SECRET });
    assert.equal(isCronAuthorized(headers, SECRET), true);
  });

  it("returns false without throwing when the lengths differ", () => {
    for (const value of ["x", `${SECRET}x`, SECRET.slice(0, -1), "é".repeat(40)]) {
      assert.doesNotThrow(() => isCronAuthorized(new Headers({ "x-cron-secret": value }), SECRET));
      assert.equal(isCronAuthorized(new Headers({ "x-cron-secret": value }), SECRET), false);
      assert.equal(isCronAuthorized(new Headers({ authorization: `Bearer ${value}` }), SECRET), false);
    }
  });
});
