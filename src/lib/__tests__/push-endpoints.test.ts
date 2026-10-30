import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { isAllowedPushEndpoint, PUSH_ENDPOINT_PATTERN } from "../push/endpoints.ts";

describe("isAllowedPushEndpoint", () => {
  it("accepts the browsers' push services", () => {
    for (const url of [
      "https://fcm.googleapis.com/fcm/send/dXk1:APA91bH",
      "https://updates.push.services.mozilla.com/wpush/v2/gAAAAAB",
      "https://push.services.mozilla.com/wpush/v1/abc",
      "https://wns2-par02p.notify.windows.com/w/?token=BQYAAAB",
      "https://web.push.apple.com/QGfJv4d",
    ]) {
      assert.equal(isAllowedPushEndpoint(url), true, url);
      assert.match(url, PUSH_ENDPOINT_PATTERN);
    }
  });

  it("rejects plain http, other hosts and look-alikes", () => {
    for (const url of [
      "http://fcm.googleapis.com/fcm/send/abc",
      "https://evil.com/fcm/send/abc",
      "https://fcm.googleapis.com.evil.com/fcm/send/abc",
      "https://evilfcm.googleapis.com/fcm/send/abc",
      "https://fcm.googleapis.com@evil.com/x",
      "https://user:pass@fcm.googleapis.com/x",
      "https://fcm.googleapis.com:8443/x",
      "https://notify.windows.com/w/",
      "https://web.push.apple.com.evil.com/x",
      "https://fcm.googleapis.com",
    ]) {
      assert.equal(isAllowedPushEndpoint(url), false, url);
    }
  });

  it("rejects values that are not URLs", () => {
    for (const url of ["not a url", "", "fcm.googleapis.com/fcm/send/abc", "javascript:alert(1)"]) {
      assert.equal(isAllowedPushEndpoint(url), false, url);
    }
  });
});
