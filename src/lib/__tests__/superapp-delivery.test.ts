import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  IMMUTABLE_CACHE_CONTROL,
  SHORT_CACHE_CONTROL,
  cacheHeadersFor,
  contentTypeFor,
  requestedVersion,
} from "../superapp-delivery.ts";
import { superAppStoragePath } from "../superapp.ts";

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

describe("requestedVersion", () => {
  it("returns a valid v parameter", () => {
    assert.equal(requestedVersion(new URL("https://x.test/superapp/a.json?v=0.2.0")), "0.2.0");
  });

  it("ignores a missing, empty or malformed v", () => {
    for (const url of [
      "https://x.test/superapp/a.json",
      "https://x.test/superapp/a.json?v=",
      "https://x.test/superapp/a.json?v=latest",
      "https://x.test/superapp/a.json?v=0.2",
    ]) {
      assert.equal(requestedVersion(new URL(url)), null, url);
    }
  });
});

describe("cacheHeadersFor", () => {
  it("caches an exact version snapshot for a year", () => {
    const headers = cacheHeadersFor(true);
    assert.equal(headers["Cache-Control"], IMMUTABLE_CACHE_CONTROL);
    assert.equal(headers["Vercel-CDN-Cache-Control"], "max-age=31536000");
  });

  it("uses only a short CDN cache for fallback or unversioned content", () => {
    const headers = cacheHeadersFor(false);
    assert.equal(headers["Cache-Control"], SHORT_CACHE_CONTROL);
    assert.equal(headers["Vercel-CDN-Cache-Control"], undefined);
  });
});

describe("superAppStoragePath", () => {
  it("keeps each version in its own folder", () => {
    assert.equal(superAppStoragePath("a.json", "0.2.0"), "superapp-v/0.2.0/a.json");
    assert.equal(superAppStoragePath("a.json", "0.3.0"), "superapp-v/0.3.0/a.json");
  });

  it("keeps the legacy path for unversioned files", () => {
    assert.equal(superAppStoragePath("a.json"), "superapp/a.json");
    assert.equal(superAppStoragePath("a.json", null), "superapp/a.json");
  });
});
