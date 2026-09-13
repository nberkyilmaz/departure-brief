import type { TextLine, WordBox } from './types.js';

/**
 * Group words into reading lines: words whose vertical centres fall within
 * about half a typical word height of each other share a line; each line
 * reads left to right. Deterministic, and good enough for a model to be
 * handed a page as lines rather than as loose boxes — tables in
 * particular come out as one row per line.
 */
export function groupLines(words: readonly WordBox[], rotation: 0 | 90 | 270 = 0, widthPx = 0, heightPx = 0): TextLine[] {
  if (words.length === 0) return [];
  // Read the page the way it was recognised: for a sideways page, "down the
  // line" is along the scanned x axis and "across" is along y.
  const reading = (w: WordBox): { cx: number; cy: number; h: number } => {
    switch (rotation) {
      case 0:
        return { cx: w.x + w.w / 2, cy: w.y + w.h / 2, h: w.h };
      case 90:
        return { cx: heightPx - (w.y + w.h / 2), cy: w.x + w.w / 2, h: w.w };
      case 270:
        return { cx: w.y + w.h / 2, cy: widthPx - (w.x + w.w / 2), h: w.w };
    }
  };
  const heights = words.map((w) => reading(w).h).sort((a, b) => a - b);
  const typical = heights[Math.floor(heights.length / 2)] ?? 10;
  const tolerance = Math.max(3, typical * 0.55);
  const sorted = [...words].sort((a, b) => reading(a).cy - reading(b).cy || reading(a).cx - reading(b).cx);
  const lines: { y: number; words: WordBox[] }[] = [];
  for (const w of sorted) {
    const cy = reading(w).cy;
    const last = lines[lines.length - 1];
    if (last && Math.abs(last.y - cy) <= tolerance) {
      last.words.push(w);
      // A running centre keeps a slightly sloping scan on one line.
      last.y = (last.y * (last.words.length - 1) + cy) / last.words.length;
    } else {
      lines.push({ y: cy, words: [w] });
    }
  }
  return lines.map((l) => {
    const ws = l.words.sort((a, b) => reading(a).cx - reading(b).cx);
    return { page: ws[0]!.page, y: Math.round(l.y), wordIds: ws.map((w) => w.id), text: ws.map((w) => w.text).join(' ') };
  });
}
