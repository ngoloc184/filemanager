import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  IMMUTABLE_CACHE_CONTROL,
  SHORT_CACHE_CONTROL,
  cacheHeadersFor,
  contentTypeFor,
} from "../superapp-delivery.ts";

describe("contentTypeFor", () => {
  it("maps mini-app extensions regardless of the stored type", () => {
    assert.equal(contentTypeFor("transfer-android-mf-manifest.json", "application/octet-stream"), "application/json");
    assert.equal(contentTypeFor("transfer-android-container.js.bundle", "application/octet-stream"), "application/javascript");
    assert.equal(contentTypeFor("APP.BUNDLE", ""), "application/javascript");
  });

  it("falls back to the stored mime type", () => {
    assert.equal(contentTypeFor("logo.png", "image/png"), "image/png");
    assert.equal(contentTypeFor("noext", ""), "application/octet-stream");
  });
});

describe("cacheHeadersFor", () => {
  it("caches versioned URLs for a year", () => {
    const headers = cacheHeadersFor(new URL("https://x.test/superapp/a.json?v=0.2.0"));
    assert.equal(headers["Cache-Control"], IMMUTABLE_CACHE_CONTROL);
  });

  it("uses a short CDN cache without v (or with an empty v)", () => {
    for (const url of ["https://x.test/superapp/a.json", "https://x.test/superapp/a.json?v="]) {
      assert.equal(cacheHeadersFor(new URL(url))["Cache-Control"], SHORT_CACHE_CONTROL);
    }
  });
});
