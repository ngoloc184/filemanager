import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { displayUrl, normalizeUrl, validateLink } from "../saved-links.ts";

describe("normalizeUrl", () => {
  it("keeps http and https URLs", () => {
    assert.equal(normalizeUrl("https://example.com/a?b=1#c"), "https://example.com/a?b=1#c");
    assert.equal(normalizeUrl("  http://example.com  "), "http://example.com/");
  });

  it("adds https:// when the scheme is missing", () => {
    assert.equal(normalizeUrl("example.com/report"), "https://example.com/report");
    assert.equal(normalizeUrl("localhost:3000/x"), "https://localhost:3000/x");
  });

  it("rejects non-web schemes and junk", () => {
    assert.equal(normalizeUrl("javascript:alert(1)"), null);
    assert.equal(normalizeUrl("JavaScript:alert(1)"), null);
    assert.equal(normalizeUrl("data:text/html,hi"), null);
    assert.equal(normalizeUrl("mailto:a@b.c"), null);
    assert.equal(normalizeUrl("ftp://example.com"), null);
    assert.equal(normalizeUrl("not a url"), null);
    assert.equal(normalizeUrl(""), null);
    assert.equal(normalizeUrl("https://"), null);
  });

  it("rejects URLs longer than the database allows", () => {
    assert.equal(normalizeUrl(`https://example.com/${"a".repeat(2100)}`), null);
  });
});

describe("validateLink", () => {
  it("returns the trimmed title and normalized URL", () => {
    assert.deepEqual(
      validateLink({ title: "  Link cập nhật tiến độ mỗi ngày ", url: "example.com/daily" }),
      { ok: true, value: { title: "Link cập nhật tiến độ mỗi ngày", url: "https://example.com/daily" } }
    );
  });

  it("reports which field is wrong", () => {
    assert.equal(validateLink({ title: " ", url: "https://a.b" }).ok, false);
    const badUrl = validateLink({ title: "x", url: "javascript:alert(1)" });
    assert.equal(badUrl.ok, false);
    if (!badUrl.ok) assert.equal(badUrl.field, "url");
    const longTitle = validateLink({ title: "t".repeat(201), url: "https://a.b" });
    if (!longTitle.ok) assert.equal(longTitle.field, "title");
    else assert.fail("long title accepted");
  });
});

describe("displayUrl", () => {
  it("drops the scheme and www", () => {
    assert.equal(displayUrl("https://www.example.com/"), "example.com");
    assert.equal(displayUrl("https://example.com:8080/a?b=1"), "example.com:8080/a?b=1");
  });
});
