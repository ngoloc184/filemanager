// Group chat backgrounds: presets (stored as "preset:<key>") or an uploaded
// image ("image:<path in the public-images bucket>"). Unit-tested.
import type { CSSProperties } from "react";

export type BackgroundPreset = { key: string; label: string; image: string };

export const BACKGROUND_PRESETS: BackgroundPreset[] = [
  { key: "aurora", label: "Aurora", image: "linear-gradient(135deg, #6d4aff33, #b13fd933 55%, #23b7d933)" },
  { key: "ocean", label: "Ocean", image: "linear-gradient(160deg, #0ea5e933, #2563eb33 60%, #312e8133)" },
  { key: "sunset", label: "Sunset", image: "linear-gradient(150deg, #f9731633, #ec489933 55%, #8b5cf633)" },
  { key: "forest", label: "Forest", image: "linear-gradient(150deg, #22c55e2e, #0d948833 60%, #164e6333)" },
  { key: "peach", label: "Peach", image: "linear-gradient(135deg, #fda4af40, #fdba7440)" },
  { key: "lavender", label: "Lavender", image: "linear-gradient(135deg, #c4b5fd40, #f0abfc40)" },
  { key: "mint", label: "Mint", image: "linear-gradient(135deg, #99f6e440, #bef26440)" },
  { key: "sky", label: "Sky", image: "linear-gradient(180deg, #bae6fd4d, #e0f2fe33)" },
  { key: "night", label: "Night", image: "linear-gradient(160deg, #1e1b4b59, #0f172a66)" },
  { key: "dots", label: "Dots", image: "radial-gradient(circle at 1px 1px, #8b5cf633 1px, transparent 0) 0 0 / 16px 16px" },
  { key: "grid", label: "Grid", image: "linear-gradient(#64748b1f 1px, transparent 1px) 0 0 / 22px 22px, linear-gradient(90deg, #64748b1f 1px, transparent 1px) 0 0 / 22px 22px" },
  { key: "bubbles", label: "Bubbles", image: "radial-gradient(circle at 20% 30%, #23b7d929 0 60px, transparent 61px), radial-gradient(circle at 80% 70%, #b13fd929 0 80px, transparent 81px), radial-gradient(circle at 60% 15%, #6d4aff1f 0 40px, transparent 41px)" },
];

/** CSS for a conversation's background, or null for the default. */
export function backgroundStyle(background: string | null | undefined, publicUrl: (path: string) => string): CSSProperties | null {
  if (!background) return null;
  if (background.startsWith("preset:")) {
    const preset = BACKGROUND_PRESETS.find((p) => p.key === background.slice("preset:".length));
    return preset ? { background: preset.image } : null;
  }
  if (background.startsWith("image:")) {
    const url = publicUrl(background.slice("image:".length));
    return { backgroundImage: `url("${url}")`, backgroundSize: "cover", backgroundPosition: "center" };
  }
  return null;
}
