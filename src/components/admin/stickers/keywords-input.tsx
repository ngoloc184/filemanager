"use client";

import { X } from "lucide-react";
import { Textarea } from "@/components/ui/textarea";
import { KEYWORDS_MAX, normalizeKeywords } from "@/lib/stickers/custom";

/**
 * Comma-separated keywords with the saved result shown as chips (lower case,
 * no duplicates, at most 30). These words make the chat suggest the sticker.
 */
export function KeywordsInput({
  id,
  value,
  onChange,
}: {
  id: string;
  value: string;
  onChange: (value: string) => void;
}) {
  const keywords = normalizeKeywords(value);
  const hintId = `${id}-hint`;
  return (
    <div className="space-y-2">
      <Textarea
        id={id}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder="vui, vui vẻ, haha, happy"
        rows={2}
        aria-describedby={hintId}
      />
      <p id={hintId} className="text-xs text-muted-foreground">
        Separate with commas. Typing one of these words in chat suggests the sticker, with or without accents (có dấu
        hoặc không dấu). {keywords.length}/{KEYWORDS_MAX}
      </p>
      {keywords.length > 0 && (
        <ul className="flex flex-wrap gap-1.5" aria-label="Keywords that will be saved">
          {keywords.map((k) => (
            <li key={k}>
              <span className="inline-flex items-center gap-1 rounded-full border bg-muted/60 py-0.5 pr-1 pl-2 text-xs">
                {k}
                <button
                  type="button"
                  onClick={() => onChange(keywords.filter((x) => x !== k).join(", "))}
                  className="rounded-full p-0.5 text-muted-foreground outline-none hover:bg-background hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50"
                  aria-label={`Remove keyword ${k}`}
                >
                  <X className="size-3" aria-hidden />
                </button>
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
