import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  STICKER_GROUPS,
  VI_KEYWORDS,
  availableRecents,
  buildStickerSet,
  byPopularity,
  searchStickers,
  stickerUrl,
  suggestStickers,
  type Sticker,
  type StickerCatalogInput,
} from "../stickers/suggest.ts";

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

describe("stickerUrl", () => {
  it("serves built-in stickers from the app and custom ones from the public bucket", () => {
    const before = process.env.NEXT_PUBLIC_SUPABASE_URL;
    process.env.NEXT_PUBLIC_SUPABASE_URL = "https://demo.supabase.co/";
    try {
      assert.equal(stickerUrl("red-heart"), "/stickers/fluent/red-heart.webp");
      assert.equal(stickerUrl("cs-abc123xyz9"), "https://demo.supabase.co/storage/v1/object/public/stickers/cs-abc123xyz9");
      // only a well-formed custom id goes to the bucket
      assert.equal(stickerUrl("cs-short"), "/stickers/fluent/cs-short.webp");
    } finally {
      if (before === undefined) delete process.env.NEXT_PUBLIC_SUPABASE_URL;
      else process.env.NEXT_PUBLIC_SUPABASE_URL = before;
    }
  });
});

const catalog: StickerCatalogInput = {
  packs: [
    {
      id: "p1",
      name: "Mèo Ú",
      cover_sticker_id: "cs-meo0000002",
      stickers: [
        { id: "cs-meo0000001", name: "Mèo cười", keywords: ["haha", "vui vẻ", "cười"] },
        { id: "cs-meo0000002", name: "Mèo khóc", keywords: ["buồn", "huhu"] },
        { id: "not-a-custom-id", name: "Bad", keywords: ["haha"] },
      ],
    },
    { id: "p2", name: "Empty", cover_sticker_id: null, stickers: [] },
    {
      id: "p3",
      name: "Office",
      cover_sticker_id: "cs-gone000000",
      stickers: [{ id: "cs-office0001", name: "Deadline", keywords: ["chạy deadline", "gấp"] }],
    },
  ],
  hiddenGroups: ["food", "symbols"],
};

describe("buildStickerSet", () => {
  const set = buildStickerSet(all, catalog);

  it("puts custom packs first, in order, as their own groups", () => {
    assert.deepEqual(set.stickers.slice(0, 3).map((s) => [s.id, s.group]), [
      ["cs-meo0000001", "pack:p1"],
      ["cs-meo0000002", "pack:p1"],
      ["cs-office0001", "pack:p3"],
    ]);
    assert.ok(!ids(set.stickers).includes("not-a-custom-id"), "ids that are not custom ids are dropped");
    assert.equal(set.stickers[0].emoji, "");
  });

  it("gives each non-empty pack a tab with its cover, or its first sticker", () => {
    assert.deepEqual(set.packs, [
      { key: "pack:p1", id: "p1", name: "Mèo Ú", icon: "cs-meo0000002" },
      { key: "pack:p3", id: "p3", name: "Office", icon: "cs-office0001" },
    ]);
  });

  it("leaves out the built-in groups the admins hid", () => {
    assert.deepEqual(
      set.groups.map((g) => g.key),
      STICKER_GROUPS.map((g) => g.key).filter((k) => k !== "food" && k !== "symbols")
    );
    assert.ok(!set.stickers.some((s) => s.group === "food" || s.group === "symbols"));
    assert.ok(ids(set.stickers).includes("face-with-tears-of-joy"));
    assert.equal(set.stickers.length, 3 + all.filter((s) => s.group !== "food" && s.group !== "symbols").length);
    // a hidden sticker is never suggested, even by a Vietnamese word
    assert.ok(!ids(suggestStickers("cafe", set.stickers)).includes("hot-beverage"));
    assert.ok(!ids(searchStickers("pizza", set.stickers)).includes("pizza"));
  });

  it("keeps everything when nothing is hidden or uploaded", () => {
    const plain = buildStickerSet(all, { packs: [], hiddenGroups: [] });
    assert.equal(plain.stickers.length, all.length);
    assert.equal(plain.groups.length, STICKER_GROUPS.length);
    assert.deepEqual(plain.packs, []);
  });

  it("drops recent stickers that are no longer available", () => {
    const recent = availableRecents(["cs-meo0000002", "cs-deleted001", "pizza", "check-mark-button", "grinning-face"], set.stickers);
    assert.deepEqual(ids(recent), ["cs-meo0000002", "grinning-face"]);
  });
});

describe("custom sticker suggestions", () => {
  const set = buildStickerSet(all, catalog);

  it("matches keywords with or without accents, as whole words", () => {
    assert.ok(ids(suggestStickers("vui vẻ quá", set.stickers)).includes("cs-meo0000001"));
    assert.ok(ids(suggestStickers("vui ve qua", set.stickers)).includes("cs-meo0000001"));
    assert.ok(ids(suggestStickers("Buồn ghê", set.stickers)).includes("cs-meo0000002"));
    assert.ok(ids(suggestStickers("buon ghe", set.stickers)).includes("cs-meo0000002"));
    assert.ok(ids(suggestStickers("đang chạy deadline", set.stickers)).includes("cs-office0001"));
    // part of a word is not a hit ("gap" inside "gapping"; "vui" alone is not "vui vẻ")
    assert.ok(!ids(suggestStickers("gapping", set.stickers)).includes("cs-office0001"));
    assert.ok(!ids(suggestStickers("vui", set.stickers)).includes("cs-meo0000001"));
  });

  it("ranks the admins' stickers above built-in ones for the same word", () => {
    const hits = ids(suggestStickers("haha", set.stickers));
    assert.equal(hits[0], "cs-meo0000001");
    assert.ok(hits.includes("face-with-tears-of-joy"), "built-in suggestions still follow");
    const sad = ids(suggestStickers("buồn", set.stickers));
    assert.equal(sad[0], "cs-meo0000002");
    assert.ok(sad.indexOf("loudly-crying-face") > 0);
  });

  it("suggests by an exact custom name", () => {
    assert.equal(suggestStickers("meo cuoi", set.stickers)[0]?.id, "cs-meo0000001");
  });

  it("stays quiet for long text and caps the list", () => {
    assert.deepEqual(suggestStickers("haha hôm nay mình đi họp muộn quá nên bị sếp nhắc", set.stickers), []);
    assert.ok(suggestStickers("haha", set.stickers).length <= 8);
  });
});

describe("searchStickers with custom packs", () => {
  const set = buildStickerSet(all, catalog);

  it("finds custom names and keywords, accent-insensitive, before built-in ones", () => {
    assert.equal(searchStickers("meo", set.stickers)[0]?.id, "cs-meo0000001");
    assert.ok(ids(searchStickers("Mèo khóc", set.stickers)).includes("cs-meo0000002"));
    assert.ok(ids(searchStickers("gap", set.stickers)).includes("cs-office0001"));
    assert.ok(ids(searchStickers("meo", set.stickers)).includes("cat-face"), "built-in matches still follow");
  });
});
