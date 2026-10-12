// Local, extractive summaries (no LLM): picks the most representative
// sentences of a document by term frequency, keeping their original order.

import { normalize, tokenize } from "./text.ts";

const STOPWORDS = new Set(
  (
    "va la cua cac co cho voi nhung mot trong khi da duoc nay do de ve tu den thi ma neu " +
    "cung nhu vao ra theo tai tren duoi sau truoc hon rat nhieu it khong chua se dang bi " +
    "nguoi viec phai can nen hay hoac boi vi tren the nao gi ai dau sao " +
    "thang nam ngay tuan gio muc dat nho so sau cao thap tang giam moi cu nay " +
    "the a an and or of to in on for with is are was were be been this that these those " +
    "it its as at by from has have had not but if then than so such can will would should may"
  ).split(" ")
);

export type Summary = { points: string[]; keywords: string[] };

export function splitSentences(text: string): string[] {
  return text
    .replace(/\r/g, "")
    .split(/(?<=[.!?。])\s+|\n{1,}/)
    .map((s) => s.replace(/\s+/g, " ").trim())
    .filter((s) => s.length >= 20 && s.length <= 600 && /[\p{L}]/u.test(s));
}

function contentWords(sentence: string): string[] {
  return tokenize(normalize(sentence)).filter((w) => w.length > 2 && !STOPWORDS.has(w) && !/^\d+$/.test(w));
}

/** Most frequent meaningful words (as written in the text), best first. */
export function topKeywords(text: string, limit = 8): string[] {
  const freq = new Map<string, number>();
  const original = new Map<string, string>();
  for (const match of text.slice(0, 200_000).matchAll(/[\p{L}\p{N}]+/gu)) {
    const word = match[0];
    const key = normalize(word);
    if (key.length <= 2 || STOPWORDS.has(key) || /^\d+$/.test(key)) continue;
    freq.set(key, (freq.get(key) ?? 0) + 1);
    if (!original.has(key)) original.set(key, word.toLowerCase());
  }
  const ranked = [...freq.entries()].sort(
    (a, b) => b[1] - a[1] || b[0].length - a[0].length || a[0].localeCompare(b[0])
  );
  const repeated = ranked.filter(([, count]) => count > 1);
  // Short documents rarely repeat words: fall back to the longest ones.
  return (repeated.length >= 3 ? repeated : ranked)
    .slice(0, limit)
    .map(([key]) => original.get(key) ?? key);
}

export function summarize(text: string, maxPoints = 5): Summary {
  const sentences = splitSentences(text.slice(0, 60_000)).slice(0, 400);
  const keywords = topKeywords(text);
  if (sentences.length === 0) return { points: [], keywords };
  if (sentences.length <= maxPoints) return { points: sentences, keywords };

  const freq = new Map<string, number>();
  for (const sentence of sentences) {
    for (const word of new Set(contentWords(sentence))) {
      freq.set(word, (freq.get(word) ?? 0) + 1);
    }
  }
  const scored = sentences.map((sentence, index) => {
    const words = contentWords(sentence);
    const score =
      words.reduce((sum, w) => sum + (freq.get(w) ?? 0), 0) / Math.max(words.length, 4) +
      (index === 0 ? 1.5 : 0) + // titles/intros carry the topic
      (index < 3 ? 0.5 : 0);
    return { sentence, index, score };
  });
  const picked = scored
    .sort((a, b) => b.score - a.score)
    .slice(0, maxPoints)
    .sort((a, b) => a.index - b.index)
    .map((s) => s.sentence);
  return { points: picked, keywords };
}
