// Builds the chat stickers from Microsoft Fluent Emoji (MIT license):
//   git clone --depth 1 --filter=blob:none --sparse https://github.com/microsoft/fluentui-emoji
//   node scripts/build-stickers.mjs <path to fluentui-emoji>
// Writes public/stickers/fluent/<id>.webp (160 px), the license, and
// src/lib/stickers/fluent.json (id, name, emoji, group, keywords).
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import sharp from "sharp";

const source = process.argv[2];
if (!source || !existsSync(path.join(source, "assets"))) {
  console.error("Usage: node scripts/build-stickers.mjs <path to fluentui-emoji checkout>");
  process.exit(1);
}

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const OUT = path.join(ROOT, "public/stickers/fluent");
const DATA = path.join(ROOT, "src/lib/stickers/fluent.json");
mkdirSync(OUT, { recursive: true });
mkdirSync(path.dirname(DATA), { recursive: true });

const GROUPS = {
  "Smileys & Emotion": "smileys",
  "People & Body": "people",
  "Animals & Nature": "nature",
  "Food & Drink": "food",
  Activities: "activities",
  "Travel & Places": "travel",
  Objects: "objects",
  Symbols: "symbols",
  Flags: "symbols",
};

const slug = (name) =>
  name
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");

const stickers = [];
let bytes = 0;
for (const folder of readdirSync(path.join(source, "assets")).sort()) {
  const dir = path.join(source, "assets", folder);
  const metaFile = path.join(dir, "metadata.json");
  if (!existsSync(metaFile)) continue;
  const meta = JSON.parse(readFileSync(metaFile, "utf8"));
  const imageDir = [path.join(dir, "3D"), path.join(dir, "Default", "3D")].find((d) => existsSync(d));
  const png = imageDir && readdirSync(imageDir).find((f) => f.endsWith(".png"));
  if (!png) continue;
  const id = slug(folder);
  const out = path.join(OUT, `${id}.webp`);
  const info = await sharp(path.join(imageDir, png)).resize(160, 160, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } }).webp({ quality: 78, alphaQuality: 90, effort: 6 }).toFile(out);
  bytes += info.size;
  stickers.push({
    id,
    name: meta.cldr ?? folder.toLowerCase(),
    emoji: meta.glyph ?? "",
    group: GROUPS[meta.group] ?? "symbols",
    keywords: [...new Set((meta.keywords ?? []).map((k) => String(k).toLowerCase()))].slice(0, 12),
  });
}

writeFileSync(DATA, JSON.stringify(stickers));
copyFileSync(path.join(source, "LICENSE"), path.join(OUT, "LICENSE.txt"));
console.log(`${stickers.length} stickers, ${(bytes / 1024 / 1024).toFixed(1)} MB of images, data ${(JSON.stringify(stickers).length / 1024).toFixed(0)} KB`);
