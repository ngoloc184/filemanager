import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { strToU8, zipSync, type Zippable } from "fflate";
import { STICKER_MAX_BYTES } from "../stickers/custom.ts";
import {
  SKIP_REASONS,
  ZIP_MAX_IMAGES,
  checkStickerImage,
  imageUrlProblem,
  moveItem,
  readStickerZip,
} from "../stickers/zip-import.ts";

function withHeader(header: number[], size = 64): Uint8Array {
  const bytes = new Uint8Array(Math.max(size, header.length));
  bytes.set(header);
  return bytes;
}

const png = (size?: number) => withHeader([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], size);
const gif = () => withHeader([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]);
const jpeg = () => withHeader([0xff, 0xd8, 0xff, 0xe0]);
const webp = () => withHeader([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50]);
const svg = () => strToU8('<svg xmlns="http://www.w3.org/2000/svg"></svg>');
const json = (value: unknown) => strToU8(JSON.stringify(value));

describe("checkStickerImage", () => {
  it("accepts the four image types by content", () => {
    assert.deepEqual(checkStickerImage(png()), { ok: true, mime: "image/png" });
    assert.deepEqual(checkStickerImage(gif()), { ok: true, mime: "image/gif" });
    assert.deepEqual(checkStickerImage(jpeg()), { ok: true, mime: "image/jpeg" });
    assert.deepEqual(checkStickerImage(webp()), { ok: true, mime: "image/webp" });
  });

  it("rejects SVG, empty and oversized files with a reason", () => {
    assert.deepEqual(checkStickerImage(svg()), { ok: false, reason: SKIP_REASONS.svg });
    assert.deepEqual(checkStickerImage(new Uint8Array(0)), { ok: false, reason: SKIP_REASONS.content });
    assert.deepEqual(checkStickerImage(png(STICKER_MAX_BYTES + 1)), { ok: false, reason: SKIP_REASONS.size });
    assert.equal(checkStickerImage(png(STICKER_MAX_BYTES)).ok, true);
  });
});

describe("imageUrlProblem", () => {
  it("accepts https image addresses", () => {
    assert.equal(imageUrlProblem("https://example.com/a.webp"), null);
    assert.equal(imageUrlProblem("  https://cdn.example.com/x?y=1  "), null);
  });

  it("rejects other schemes, credentials and garbage", () => {
    assert.match(imageUrlProblem("http://example.com/a.png") ?? "", /https/);
    assert.match(imageUrlProblem("ftp://example.com/a.png") ?? "", /https/);
    assert.match(imageUrlProblem("javascript:alert(1)") ?? "", /https/);
    assert.match(imageUrlProblem("https://user:pw@example.com/a.png") ?? "", /password/);
    assert.match(imageUrlProblem("example.com/a.png") ?? "", /full image address/);
    assert.match(imageUrlProblem("") ?? "", /full image address/);
  });
});

describe("moveItem", () => {
  it("moves one item and leaves the input alone", () => {
    const list = ["a", "b", "c"];
    assert.deepEqual(moveItem(list, 0, 1), ["b", "a", "c"]);
    assert.deepEqual(moveItem(list, 2, -2), ["c", "a", "b"]);
    assert.deepEqual(list, ["a", "b", "c"]);
  });

  it("keeps the order when the move falls outside the list", () => {
    assert.deepEqual(moveItem(["a", "b"], 0, -1), ["a", "b"]);
    assert.deepEqual(moveItem(["a", "b"], 1, 1), ["a", "b"]);
    assert.deepEqual(moveItem(["a", "b"], 5, -1), ["a", "b"]);
  });
});

describe("readStickerZip", () => {
  it("reads images sorted by path with names from the file names", () => {
    const zip = zipSync({
      "b_cat-02.webp": webp(),
      "a happy.png": png(),
      "c.GIF": gif(),
      "d.jpeg": jpeg(),
      "e.jpg": jpeg(),
    });
    const result = readStickerZip(zip);
    assert.equal(result.packName, undefined);
    assert.deepEqual(
      result.items.map((i) => [i.fileName, i.name, i.mime]),
      [
        ["a happy.png", "a happy", "image/png"],
        ["b_cat-02.webp", "b cat 02", "image/webp"],
        ["c.GIF", "c", "image/gif"],
        ["d.jpeg", "d", "image/jpeg"],
        ["e.jpg", "e", "image/jpeg"],
      ]
    );
    assert.ok(result.items.every((i) => i.keywords.length === 0));
    assert.deepEqual(result.skipped, []);
    assert.deepEqual(result.items[0].bytes, png());
  });

  it("ignores folders, __MACOSX and hidden files without reporting them", () => {
    const zip = zipSync({
      "pack/": {},
      "pack/one.png": png(),
      "__MACOSX/pack/._one.png": png(),
      "pack/.DS_Store": strToU8("x"),
      "pack/._two.png": png(),
      ".hidden/three.png": png(),
    });
    const result = readStickerZip(zip);
    assert.deepEqual(result.items.map((i) => i.fileName), ["pack/one.png"]);
    assert.deepEqual(result.skipped, []);
  });

  it("skips other file types, SVG, fakes and mismatched extensions with reasons", () => {
    const zip = zipSync({
      "readme.txt": strToU8("hello"),
      "vector.svg": svg(),
      "fake.png": strToU8("not an image at all"),
      "really-a-gif.png": gif(),
      "ok.png": png(),
    });
    const result = readStickerZip(zip);
    assert.deepEqual(result.items.map((i) => i.fileName), ["ok.png"]);
    assert.deepEqual(
      [...result.skipped].sort((a, b) => a.fileName.localeCompare(b.fileName)),
      [
        { fileName: "fake.png", reason: SKIP_REASONS.content },
        { fileName: "readme.txt", reason: SKIP_REASONS.type },
        { fileName: "really-a-gif.png", reason: SKIP_REASONS.mismatch },
        { fileName: "vector.svg", reason: SKIP_REASONS.type },
      ]
    );
  });

  it("skips images over 2 MB, stored or deflated", () => {
    const zip = zipSync({
      "big-stored.png": [png(STICKER_MAX_BYTES + 10), { level: 0 }],
      "big-deflated.png": [png(STICKER_MAX_BYTES + 10), { level: 9 }],
      "small.png": png(),
    });
    const result = readStickerZip(zip);
    assert.deepEqual(result.items.map((i) => i.fileName), ["small.png"]);
    assert.deepEqual(
      result.skipped.map((s) => s.reason),
      [SKIP_REASONS.size, SKIP_REASONS.size]
    );
  });

  it("uses pack.json for the pack name, sticker names and keywords", () => {
    const zip = zipSync({
      "My Pack/pack.json": json({
        name: "  Mèo Vui  ",
        stickers: [
          { file: "happy.png", name: "Mèo cười", keywords: "vui, Vui vẻ, haha" },
          { file: "My Pack/sad.webp", keywords: ["buồn", "khóc"] },
          { file: "sub/LOVE.gif", name: "Yêu" },
          { file: 42 },
        ],
      }),
      "My Pack/happy.png": png(),
      "My Pack/sad.webp": webp(),
      "My Pack/other/love.gif": gif(),
      "My Pack/plain_one.jpg": jpeg(),
    });
    const result = readStickerZip(zip);
    assert.equal(result.packName, "Mèo Vui");
    assert.deepEqual(
      result.items.map((i) => [i.fileName, i.name, i.keywords]),
      [
        // pack.json order first, then the files it does not list (by path)
        ["My Pack/happy.png", "Mèo cười", ["vui", "vui vẻ", "haha"]],
        ["My Pack/sad.webp", "sad", ["buồn", "khóc"]],
        ["My Pack/other/love.gif", "Yêu", []],
        ["My Pack/plain_one.jpg", "plain one", []],
      ]
    );
    assert.deepEqual(result.skipped, []);
  });

  it("prefers the shallowest pack.json and survives a broken one", () => {
    const nested = zipSync({
      "pack.json": json({ name: "Top" }),
      "deep/pack.json": json({ name: "Deep" }),
      "a.png": png(),
    });
    assert.equal(readStickerZip(nested).packName, "Top");

    const broken = zipSync({ "pack.json": strToU8("{not json"), "a.png": png() });
    const result = readStickerZip(broken);
    assert.equal(result.packName, undefined);
    assert.deepEqual(result.items.map((i) => i.name), ["a"]);
  });

  it(`keeps at most ${ZIP_MAX_IMAGES} images and reports the rest`, () => {
    const files: Zippable = {};
    for (let i = 0; i < ZIP_MAX_IMAGES + 5; i++) files[`s${String(i).padStart(4, "0")}.png`] = png(16);
    const result = readStickerZip(zipSync(files));
    assert.equal(result.items.length, ZIP_MAX_IMAGES);
    assert.equal(result.items.at(-1)?.fileName, `s${String(ZIP_MAX_IMAGES - 1).padStart(4, "0")}.png`);
    assert.equal(result.skipped.length, 5);
    assert.ok(result.skipped.every((s) => s.reason === SKIP_REASONS.limit));
  });

  it("refuses a ZIP that would unpack to more than 100 MB", () => {
    // 60 highly compressible images of 1.9 MB each: ~114 MB unpacked, tiny zipped
    const files: Zippable = {};
    for (let i = 0; i < 60; i++) files[`big${i}.png`] = png(1.9 * 1024 * 1024);
    const zip = zipSync(files, { level: 9 });
    assert.ok(zip.length < 10 * 1024 * 1024);
    assert.throws(() => readStickerZip(zip), /more than 100 MB/);
  });

  it("never unpacks more than an entry declares (lying sizes cannot grow memory)", () => {
    const zip = zipSync({ "liar.png": [png(3 * 1024 * 1024), { level: 9 }] });
    // central directory header: signature 50 4b 01 02, uncompressed size at +24
    let at = -1;
    for (let i = zip.length - 46; i >= 0; i--) {
      if (zip[i] === 0x50 && zip[i + 1] === 0x4b && zip[i + 2] === 0x01 && zip[i + 3] === 0x02) {
        at = i;
        break;
      }
    }
    assert.ok(at >= 0);
    new DataView(zip.buffer, zip.byteOffset).setUint32(at + 24, 100, true);
    const result = readStickerZip(zip);
    assert.equal(result.items.length, 1);
    assert.equal(result.items[0].bytes.length, 100);
  });

  it("unpacks by position: a second entry with the same name is skipped, not unpacked", () => {
    // zipSync cannot write duplicate names, so rename "b.png" to "a.png" in the headers
    const rename = (zip: Uint8Array, from: string, to: string) => {
      const a = strToU8(from);
      const b = strToU8(to);
      for (let i = 0; i + a.length <= zip.length; i++) {
        if (a.every((byte, k) => zip[i + k] === byte)) zip.set(b, i);
      }
      return zip;
    };
    const oversized = rename(
      zipSync({ "a.png": png(), "b.png": [png(3 * 1024 * 1024), { level: 9 }] }),
      "b.png",
      "a.png"
    );
    const first = readStickerZip(oversized);
    assert.deepEqual(first.items.map((i) => [i.fileName, i.bytes.length]), [["a.png", 64]]);
    assert.deepEqual(first.skipped, [{ fileName: "a.png", reason: SKIP_REASONS.size }]);

    const twice = readStickerZip(rename(zipSync({ "a.png": png(), "b.png": gif() }), "b.png", "a.png"));
    assert.deepEqual(twice.items.map((i) => i.mime), ["image/png"]);
    assert.deepEqual(twice.skipped, [{ fileName: "a.png", reason: SKIP_REASONS.duplicate }]);
  });

  it("keeps the other images when one entry cannot be unpacked", () => {
    const zip = zipSync({ "a.png": [png(4096), { level: 9 }], "b.png": [png(4096), { level: 9 }], "c.png": png() });
    // local header of b.png (50 4b 03 04): its deflate data starts after the name and extra field
    const view = new DataView(zip.buffer, zip.byteOffset);
    const name = strToU8("b.png");
    let data = -1;
    for (let i = 0; i + 30 < zip.length; i++) {
      if (view.getUint32(i, true) !== 0x04034b50) continue;
      const nameLength = view.getUint16(i + 26, true);
      if (nameLength === name.length && name.every((byte, k) => zip[i + 30 + k] === byte)) {
        data = i + 30 + nameLength + view.getUint16(i + 28, true);
        break;
      }
    }
    assert.ok(data > 0);
    zip[data] = 0xff; // final block of the reserved type 3: not valid deflate
    const result = readStickerZip(zip);
    assert.deepEqual(result.items.map((i) => i.fileName), ["a.png", "c.png"]);
    assert.deepEqual(result.skipped, [{ fileName: "b.png", reason: SKIP_REASONS.unpack }]);
  });

  it("refuses files that are not ZIP archives", () => {
    assert.throws(() => readStickerZip(png(1000)), /not a valid ZIP/);
    assert.throws(() => readStickerZip(new Uint8Array(0)), /not a valid ZIP/);
  });

  it("returns nothing for an empty archive", () => {
    assert.deepEqual(readStickerZip(zipSync({})), { items: [], skipped: [] });
  });
});
