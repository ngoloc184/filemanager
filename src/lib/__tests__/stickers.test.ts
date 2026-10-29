import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { VI_KEYWORDS, byPopularity, searchStickers, suggestStickers, type Sticker } from "../stickers/suggest.ts";

const all = JSON.parse(readFileSync(new URL("../stickers/fluent.json", import.meta.url), "utf8")) as Sticker[];
const ids = (list: Sticker[]) => list.map((s) => s.id);

describe("sticker data", () => {
  it("has the whole Fluent set with unique ids", () => {
    assert.ok(all.length >= 1500, `only ${all.length} stickers`);
    assert.equal(new Set(ids(all)).size, all.length);
    assert.ok(all.every((s) => /^[a-z0-9-]{1,80}$/.test(s.id)), "ids match the database check");
  });

  it("only suggests stickers that exist", () => {
    const known = new Set(ids(all));
    const missing = Object.values(VI_KEYWORDS).flat().filter((id) => !known.has(id));
    assert.deepEqual(missing, []);
  });
});

describe("suggestStickers (like Zalo)", () => {
  it("understands Vietnamese with or without accents", () => {
    assert.ok(ids(suggestStickers("haha", all)).includes("face-with-tears-of-joy"));
    assert.ok(ids(suggestStickers("Cảm ơn bạn nhiều", all)).includes("folded-hands"));
    assert.ok(ids(suggestStickers("cam on", all)).includes("folded-hands"));
    assert.ok(ids(suggestStickers("buồn quá", all)).includes("loudly-crying-face"));
    assert.ok(ids(suggestStickers("ok", all)).includes("thumbs-up"));
  });

  it("turns an emoji into its sticker first", () => {
    assert.equal(suggestStickers("😂", all)[0]?.id, "face-with-tears-of-joy");
  });

  it("matches English names and keywords", () => {
    assert.ok(ids(suggestStickers("pizza", all)).includes("pizza"));
    assert.ok(ids(suggestStickers("thanks", all)).includes("folded-hands"));
  });

  it("stays quiet for long or unrelated text and caps the list", () => {
    assert.deepEqual(suggestStickers("", all), []);
    assert.deepEqual(suggestStickers("Gửi anh bản kế hoạch quý 4 trước thứ sáu nhé, cần duyệt gấp", all), []);
    assert.ok(suggestStickers("haha", all).length <= 8);
    // no partial-word hits ("ok" inside "book")
    assert.ok(!ids(suggestStickers("book", all)).includes("thumbs-up"));
  });
});

describe("searchStickers", () => {
  it("finds by Vietnamese words, English names and keywords", () => {
    assert.ok(ids(searchStickers("meo", all)).includes("cat-face"));
    assert.ok(ids(searchStickers("cá voi", all)).includes("spouting-whale"));
    assert.ok(ids(searchStickers("heart", all)).includes("red-heart"));
    assert.equal(searchStickers("", all).length, 0);
  });
});

describe("byPopularity", () => {
  it("puts the stickers people use most first", () => {
    const smileys = byPopularity(all.filter((s) => s.group === "smileys"));
    assert.equal(smileys[0].id, "face-with-tears-of-joy");
    const at = (id: string) => smileys.findIndex((s) => s.id === id);
    assert.ok(at("smiling-face-with-heart-eyes") < at("alien"), "popular faces come before rarely used ones");
    assert.ok(at("loudly-crying-face") < at("alien-monster"));
  });
});
