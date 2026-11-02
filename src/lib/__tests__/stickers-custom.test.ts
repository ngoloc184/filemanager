import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  CUSTOM_PREFIX,
  KEYWORDS_MAX,
  KEYWORD_MAX,
  PACK_NAME_MAX,
  STICKER_MAX_BYTES,
  STICKER_MIME,
  STICKER_NAME_MAX,
  customStickerUrl,
  isCustomStickerId,
  newCustomStickerId,
  normalizeKeywords,
  parsePackManifest,
  sniffImageMime,
  stickerNameFromFile,
} from "../stickers/custom.ts";
import { STICKER_GROUPS } from "../stickers/suggest.ts";

const fluent = JSON.parse(readFileSync(new URL("../stickers/fluent.json", import.meta.url), "utf8")) as {
  id: string;
  group: string;
}[];
const migration = readFileSync(
  new URL("../../../supabase/migrations/202608280044_custom_stickers.sql", import.meta.url),
  "utf8"
);

const bytes = (...values: number[]) => Uint8Array.from(values);

describe("custom sticker ids", () => {
  it("never collide with built-in ids", () => {
    assert.equal(fluent.filter((s) => s.id.startsWith(CUSTOM_PREFIX)).length, 0);
    assert.equal(fluent.filter((s) => isCustomStickerId(s.id)).length, 0);
  });

  it("are recognised exactly", () => {
    assert.equal(isCustomStickerId("cs-abcdefgh12"), true);
    for (const id of ["cs-abcdefgh1", "cs-abcdefgh123", "cs-ABCDEFGH12", "cs_abcdefgh12", "xcs-abcdefgh12", "cs-abcdefgh1!", "red-heart", ""]) {
      assert.equal(isCustomStickerId(id), false, id);
    }
  });

  it("new ids match the database check and the built-in id check", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 2000; i++) {
      const id = newCustomStickerId();
      assert.match(id, /^cs-[a-z0-9]{10}$/);
      assert.match(id, /^[a-z0-9-]{1,80}$/, "chat_messages_sticker_check");
      seen.add(id);
    }
    assert.equal(seen.size, 2000);
  });

  it("have a public storage URL named by the id", () => {
    const before = process.env.NEXT_PUBLIC_SUPABASE_URL;
    try {
      process.env.NEXT_PUBLIC_SUPABASE_URL = "https://abc.supabase.co/";
      assert.equal(customStickerUrl("cs-abcdefgh12"), "https://abc.supabase.co/storage/v1/object/public/stickers/cs-abcdefgh12");
    } finally {
      if (before === undefined) delete process.env.NEXT_PUBLIC_SUPABASE_URL;
      else process.env.NEXT_PUBLIC_SUPABASE_URL = before;
    }
  });
});

describe("limits shared with the database", () => {
  it("match the migration", () => {
    assert.ok(migration.includes(`file_size_limit = ${STICKER_MAX_BYTES}`));
    assert.ok(migration.includes(`size_bytes between 1 and ${STICKER_MAX_BYTES}`));
    assert.ok(migration.includes(`cardinality(keywords) <= ${KEYWORDS_MAX}`));
    assert.ok(migration.includes(`between 1 and ${PACK_NAME_MAX}`));
    assert.ok(migration.includes(`between 1 and ${STICKER_NAME_MAX}`));
    for (const mime of STICKER_MIME) assert.ok(migration.includes(`'${mime}'`), mime);
    assert.ok(!migration.includes("image/svg"), "no SVG");
  });

  it("only real built-in groups can be hidden", () => {
    const check = migration.match(/group_key in \(([^)]*)\)/)?.[1] ?? "";
    const keys = [...check.matchAll(/'([a-z]+)'/g)].map((m) => m[1]).sort();
    assert.deepEqual(keys, STICKER_GROUPS.map((g) => g.key).sort());
    assert.deepEqual([...new Set(fluent.map((s) => s.group))].sort(), keys);
  });
});

describe("normalizeKeywords", () => {
  it("splits, trims, lower-cases and drops duplicates", () => {
    assert.deepEqual(normalizeKeywords("Vui, vui vẻ\nHAHA;  vui  "), ["vui", "vui vẻ", "haha"]);
    assert.deepEqual(normalizeKeywords(["Mèo", "mèo, chó", "  "]), ["mèo", "chó"]);
    assert.deepEqual(normalizeKeywords("a   b"), ["a b"]);
  });

  it("treats composed and decomposed Vietnamese the same", () => {
    const decomposed = "vui vẻ"; // "vui vẻ" typed with a combining hook
    assert.deepEqual(normalizeKeywords([decomposed, "vui vẻ"]), ["vui vẻ"]);
  });

  it("caps the number and the length of keywords", () => {
    const many = Array.from({ length: 50 }, (_, i) => `k${i}`);
    assert.equal(normalizeKeywords(many).length, KEYWORDS_MAX);
    assert.equal(normalizeKeywords("x".repeat(100))[0].length, KEYWORD_MAX);
  });
});

describe("sniffImageMime", () => {
  it("recognises the four sticker types from their first bytes", () => {
    assert.equal(sniffImageMime(bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0)), "image/png");
    assert.equal(sniffImageMime(new TextEncoder().encode("GIF89a....")), "image/gif");
    assert.equal(sniffImageMime(new TextEncoder().encode("GIF87a....")), "image/gif");
    assert.equal(sniffImageMime(bytes(0xff, 0xd8, 0xff, 0xe0, 0)), "image/jpeg");
    assert.equal(sniffImageMime(new TextEncoder().encode("RIFF\x10\x00\x00\x00WEBPVP8 ")), "image/webp");
  });

  it("refuses everything else, SVG included", () => {
    for (const data of [
      new Uint8Array(0),
      bytes(0x89, 0x50, 0x4e),
      new TextEncoder().encode("<svg xmlns='http://www.w3.org/2000/svg'></svg>"),
      new TextEncoder().encode("<?xml version='1.0'?><svg/>"),
      new TextEncoder().encode("GIF88a"),
      new TextEncoder().encode("RIFF\x10\x00\x00\x00WAVEfmt "),
      new TextEncoder().encode("%PDF-1.7"),
      bytes(0x50, 0x4b, 0x03, 0x04),
    ]) {
      assert.equal(sniffImageMime(data), null);
    }
  });
});

describe("stickerNameFromFile", () => {
  it("turns a file name into a readable name", () => {
    assert.equal(stickerNameFromFile("happy_cat-01.png"), "happy cat 01");
    assert.equal(stickerNameFromFile("pack/sub\\Mèo  ngủ.webp"), "Mèo ngủ");
    assert.equal(stickerNameFromFile(".png"), "Sticker");
    assert.equal(stickerNameFromFile(`${"a".repeat(100)}.gif`).length, STICKER_NAME_MAX);
  });
});

describe("parsePackManifest", () => {
  it("reads names and keywords and drops bad entries", () => {
    assert.deepEqual(
      parsePackManifest({
        name: "  Mèo cưng  ",
        extra: true,
        stickers: [
          { file: "cat1.png", name: " Happy ", keywords: "vui, Haha" },
          { file: "cat2.png", keywords: ["Buồn", "buồn"] },
          { file: "  " },
          { name: "no file" },
          null,
          "cat3.png",
          { file: "cat4.png", keywords: [1, 2] },
        ],
      }),
      {
        name: "Mèo cưng",
        stickers: [
          { file: "cat1.png", name: "Happy", keywords: ["vui", "haha"] },
          { file: "cat2.png", keywords: ["buồn"] },
          { file: "cat4.png" },
        ],
      }
    );
  });

  it("is null when unusable", () => {
    for (const value of [null, undefined, "pack", 3, [], [{ file: "a.png" }]]) {
      assert.equal(parsePackManifest(value), null);
    }
    assert.deepEqual(parsePackManifest({}), {});
  });

  it("caps the pack name", () => {
    assert.equal(parsePackManifest({ name: "x".repeat(100) })?.name?.length, PACK_NAME_MAX);
  });
});
