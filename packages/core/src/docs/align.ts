/**
 * The free correctness check for document extraction. A model returns each
 * value with the ids of the OCR tokens it read it from; the value is only
 * believed when the tokens' text actually contains it. OCR confuses a few
 * glyphs in predictable ways (O for 0, l for 1, a comma for a decimal
 * point), so a match through those substitutions counts, but is marked so.
 */
import type { DocumentOcr, PageOcr, WordBox } from './types.js';

export type AlignMatch = 'exact' | 'normalised' | 'none';

export interface Alignment {
  readonly match: AlignMatch;
  readonly page: number | null;
  readonly tokenIds: readonly number[];
  readonly citedText: string;
  /** Union of the cited boxes in page pixels; null when nothing valid was cited. */
  readonly box: { readonly x: number; readonly y: number; readonly w: number; readonly h: number } | null;
  readonly problem: string | null;
}

export function tokensById(doc: DocumentOcr): Map<number, WordBox> {
  const m = new Map<number, WordBox>();
  for (const p of doc.pages) for (const w of p.words) m.set(w.id, w);
  return m;
}

/** Numbers as printed: "2,300" and "2300" and "38.5" and "-0.2". */
export function numbersIn(text: string): number[] {
  const out: number[] = [];
  for (const m of text.matchAll(/-?\d[\d,]*(?:\.\d+)?/g)) {
    const n = Number(m[0].replace(/,/g, ''));
    if (Number.isFinite(n)) out.push(n);
  }
  return out;
}

/** OCR's habitual confusions, applied only next to digits so words stay words. */
export function normaliseOcr(text: string): string {
  return text
    .replace(/(?<=\d)[,](?=\d)/g, '.')
    .replace(/(?<=\d)[Oo]|[Oo](?=\d)/g, '0')
    .replace(/(?<=\d)[lI|]|[lI|](?=\d)/g, '1')
    .replace(/(?<=\d)S|S(?=\d)/g, '5')
    .replace(/(?<=\d)B|B(?=\d)/g, '8')
    .replace(/(?<=\d)\s+\.\s*(?=\d)/g, '.')
    .replace(/(?<=\d)\s*\.\s+(?=\d)/g, '.');
}

const close = (a: number, b: number) => Math.abs(a - b) <= 1e-6 * Math.max(1, Math.abs(a), Math.abs(b));

function union(boxes: readonly WordBox[]): Alignment['box'] {
  if (boxes.length === 0) return null;
  const x0 = Math.min(...boxes.map((b) => b.x));
  const y0 = Math.min(...boxes.map((b) => b.y));
  const x1 = Math.max(...boxes.map((b) => b.x + b.w));
  const y1 = Math.max(...boxes.map((b) => b.y + b.h));
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

/** Resolve cited token ids: they must exist and sit on one page. */
export function resolveCitation(tokens: Map<number, WordBox>, tokenIds: readonly number[]): { boxes: WordBox[]; page: number | null; problem: string | null } {
  const boxes: WordBox[] = [];
  const missing: number[] = [];
  for (const id of tokenIds) {
    const t = tokens.get(id);
    if (t) boxes.push(t);
    else missing.push(id);
  }
  if (tokenIds.length === 0) return { boxes, page: null, problem: 'no tokens cited' };
  if (missing.length > 0) return { boxes, page: boxes[0]?.page ?? null, problem: `cited token ids that do not exist: ${missing.join(', ')}` };
  const pages = new Set(boxes.map((b) => b.page));
  if (pages.size > 1) return { boxes, page: null, problem: `cited tokens span pages ${[...pages].join(', ')}` };
  return { boxes, page: boxes[0]!.page, problem: null };
}

export interface Located {
  readonly tokenIds: readonly number[];
  /** The words as the page actually has them, which may differ from the quote by OCR confusions. */
  readonly text: string;
  readonly lineIndex: number;
  /** How many consecutive printed lines the quote covers; a POH sentence often wraps. */
  readonly lineCount: number;
  /**
   * True when the quote was matched to the line by similarity rather than
   * found in it word for word — the usual case when a model reads the page
   * image and writes clean text while the scan's OCR has "Aff:" for "Aft:".
   * The whole line is returned, and whatever is checked against it (a
   * figure, a label) is still checked against the page's own words.
   */
  readonly approximate: boolean;
}

/** A quoted sentence may wrap; look this far for the rest of it. */
const MAX_WRAPPED_LINES = 3;

const forSearch = (s: string) => s.toLowerCase().replace(/\s+/g, ' ').trim();
const forCompare = (s: string) => s.toLowerCase().replace(/[^a-z0-9./-]/g, '');

/** Levenshtein, capped: past `max` the exact distance does not matter. */
function editDistance(a: string, b: string, max: number): number {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    let best = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      const v = Math.min(prev[j]! + 1, row[j - 1]! + 1, prev[j - 1]! + cost);
      row.push(v);
      if (v < best) best = v;
    }
    if (best > max) return max + 1;
    prev = row;
  }
  return prev[b.length]!;
}

/** One scanned word standing for another: equal, or off by a glyph the scanner confuses. */
function wordsMatch(a: string, b: string): boolean {
  const x = forCompare(a);
  const y = forCompare(b);
  if (x === y) return true;
  if (x.length === 0 || y.length === 0) return false;
  if (normaliseOcr(x) === normaliseOcr(y)) return true;
  /*
   * Anything carrying a digit must match exactly, allowing only the
   * scanner's glyph confusions. Otherwise "2400" would stand for "2300"
   * and a quote of a limit the page does not state would find a line.
   */
  if (/\d/.test(x) || /\d/.test(y)) return false;
  // One substitution in a word of three letters or more: "Aff" for "Aft", "Ibs" for "lbs".
  return Math.min(x.length, y.length) >= 3 && editDistance(x, y, 1) <= 1;
}

/** How much of `quote` the line accounts for, in order, allowing scanned-word slips. */
function similarity(quoteWords: readonly string[], lineWords: readonly string[]): number {
  if (quoteWords.length === 0) return 0;
  let matched = 0;
  let from = 0;
  for (const q of quoteWords) {
    for (let i = from; i < lineWords.length; i++) {
      if (wordsMatch(q, lineWords[i]!)) {
        matched++;
        from = i + 1;
        break;
      }
    }
  }
  return matched / quoteWords.length;
}

/** Below this share of the quote's words, the line is not what was quoted. */
const SIMILAR_ENOUGH = 0.7;

/**
 * Find a quoted phrase among a page's words and return the words it
 * covers. This is how a citation is checked when the model quotes the page
 * rather than naming token ids: a quote that is not on the page is not
 * found, so an invented citation fails exactly as a wrong token id would —
 * and a small model can quote far more reliably than it can copy integers.
 *
 * Matching is per line (a figure and its label sit on one printed line),
 * case- and space-insensitive, and falls back to OCR's habitual glyph
 * confusions so that quoting the page as a human reads it still matches
 * what the engine saw.
 */
export function locateText(page: PageOcr, quote: string, allowOcrConfusions = true): Located | null {
  const want = forSearch(quote);
  if (want.length < 2) return null;
  const byId = new Map(page.words.map((w) => [w.id, w]));
  const wordsOf = (line: { wordIds: readonly number[] }) => line.wordIds.map((id) => byId.get(id)).filter((w): w is WordBox => w !== undefined);

  // Word for word, first as quoted and then folding the confusions the scanner makes inside figures.
  const attempts = allowOcrConfusions ? [(s: string) => s, normaliseOcr] : [(s: string) => s];
  for (const transform of attempts) {
    const target = forSearch(transform(quote));
    for (const [lineIndex, line] of page.lines.entries()) {
      const words = wordsOf(line);
      if (words.length === 0) continue;
      const pieces = words.map((w) => forSearch(transform(w.text)));
      const at = pieces.join(' ').indexOf(target);
      if (at < 0) continue;
      const end = at + target.length;
      let cursor = 0;
      const covered: WordBox[] = [];
      for (const [i, piece] of pieces.entries()) {
        const start = cursor;
        cursor += piece.length + 1;
        if (start < end && start + piece.length > at) covered.push(words[i]!);
      }
      if (covered.length === 0) continue;
      return { tokenIds: covered.map((w) => w.id), text: covered.map((w) => w.text).join(' '), lineIndex, lineCount: 1, approximate: false };
    }
  }
  if (!allowOcrConfusions) return null;

  /*
   * Otherwise the closest run of lines, if it is close enough. A model
   * reading the page image writes what is printed, while the scan's OCR has
   * its own slips, and the two must still meet. Runs rather than single
   * lines because a POH sentence wraps: "Forward: 35.0 inches aft of datum
   * at 1950 lbs. or less, with straight line variation to 38.5 inches aft
   * of datum at 2300 lbs." is two printed lines and one quote.
   */
  const quoteWords = quote.split(/\s+/).filter((w) => forCompare(w).length > 0);
  if (quoteWords.length === 0) return null;
  let best: { lineIndex: number; lineCount: number; score: number; words: number } | null = null;
  for (let start = 0; start < page.lines.length; start++) {
    for (let count = 1; count <= MAX_WRAPPED_LINES && start + count <= page.lines.length; count++) {
      const runWords = page.lines.slice(start, start + count).flatMap((l) => l.text.split(/\s+/));
      const score = similarity(quoteWords, runWords);
      if (score < SIMILAR_ENOUGH) continue;
      /*
       * A tighter run saying as much as a looser one is the better match:
       * every window that contains the right line also scores well, so
       * without this the answer drifts to whichever window starts earliest.
       */
      const candidate = { lineIndex: start, lineCount: count, score, words: runWords.length };
      const better = !best || score > best.score || (score === best.score && (count < best.lineCount || (count === best.lineCount && runWords.length < best.words)));
      if (better) best = candidate;
    }
  }
  if (!best) return null;
  const words = page.lines.slice(best.lineIndex, best.lineIndex + best.lineCount).flatMap(wordsOf);
  return { tokenIds: words.map((w) => w.id), text: words.map((w) => w.text).join(' '), lineIndex: best.lineIndex, lineCount: best.lineCount, approximate: true };
}

/** Does the cited text carry every number in `values`? */
export function alignNumbers(tokens: Map<number, WordBox>, tokenIds: readonly number[], values: readonly number[]): Alignment {
  const r = resolveCitation(tokens, tokenIds);
  const citedText = r.boxes.map((b) => b.text).join(' ');
  const base = { page: r.page, tokenIds, citedText, box: union(r.boxes) };
  if (r.problem) return { ...base, match: 'none', problem: r.problem };
  const has = (text: string) => {
    const found = numbersIn(text);
    return values.every((v) => found.some((f) => close(f, v)));
  };
  if (has(citedText)) return { ...base, match: 'exact', problem: null };
  if (has(normaliseOcr(citedText))) return { ...base, match: 'normalised', problem: null };
  return { ...base, match: 'none', problem: `cited text "${citedText}" does not contain ${values.join(', ')}` };
}

/** Does the cited text carry the words of `value` (case- and punctuation-insensitive)? */
export function alignText(tokens: Map<number, WordBox>, tokenIds: readonly number[], value: string): Alignment {
  const r = resolveCitation(tokens, tokenIds);
  const citedText = r.boxes.map((b) => b.text).join(' ');
  const base = { page: r.page, tokenIds, citedText, box: union(r.boxes) };
  if (r.problem) return { ...base, match: 'none', problem: r.problem };
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  const want = norm(value);
  if (norm(citedText).includes(want)) return { ...base, match: 'exact', problem: null };
  if (norm(normaliseOcr(citedText)).includes(want)) return { ...base, match: 'normalised', problem: null };
  return { ...base, match: 'none', problem: `cited text "${citedText}" does not contain "${value}"` };
}
