/**
 * A printed table checked against the scan, row by row.
 *
 * A weight-and-balance figure is found by the words beside it. A table cell
 * has none: it is a number in a column, and what names it is its place. So
 * this works the other way round. The rows are copied from the page image
 * by hand; each is matched to the scanned line that carries the most of its
 * figures in the printed order, and every figure that line does not carry
 * is named, so the check never claims the scan agreed where it did not.
 *
 * Strict on purpose. "83" on the scan is not taken for a printed 8.3, even
 * though a lost decimal point is the likeliest story: the point of the
 * check is to say what the scan itself bears out.
 */
import { alignNumbers, locateText, normaliseOcr } from '../align.js';
import type { PageOcr, WordBox } from '../types.js';

export interface PrintedRow {
  /** The row's figures left to right, as printed. */
  readonly values: readonly number[];
  /** One per figure, used to say which the scan does not carry. */
  readonly names: readonly string[];
}

export interface RowCheck {
  /** The scanned line the row was matched to, or null when none carried enough of it. */
  readonly lineIndex: number | null;
  readonly text: string;
  readonly box: { readonly x: number; readonly y: number; readonly w: number; readonly h: number } | null;
  readonly unconfirmed: readonly string[];
}

/** Below this many figures in order, a line is not taken to be the row at all. */
const MIN_MATCHED = 3;

/** The marks a table's rules leave at the edge of a figure when the scanner joins them to it. */
const RULE_MARKS = /^[|()[\]{}¢§;:,'"!]+|[|()[\]{}¢§;:,'"!]+$/g;
/** A whole word that is a number: "8.8", "2500", "10,000" — not "8,8", which is a slip for 8.8 or nothing. */
const WHOLE_NUMBER = /^-?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?$/;

/**
 * What a scanned word can be read as: the number it is, as it stands or
 * under the scanner's habitual slips, with any table rule stuck to its
 * edge ("2500)", "2400¢") taken off. The whole word has to be the number:
 * "a8" is not an 8, and "7%" is not a 7.
 */
export function wordReadings(text: string): number[] {
  const out = new Set<number>();
  for (const t of [text, normaliseOcr(text)]) {
    const bare = t.replace(RULE_MARKS, '');
    if (WHOLE_NUMBER.test(bare)) out.add(Number(bare.replace(/,/g, '')));
  }
  return [...out];
}

/** Which of the printed figures one line carries, in order: a longest common subsequence. */
export function matchedFigures(values: readonly number[], words: readonly (readonly number[])[]): number[] {
  const n = values.length;
  const m = words.length;
  const at = (i: number, j: number) => words[j]!.some((r) => Math.abs(r - values[i]!) < 1e-9);
  const best: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      best[i]![j] = at(i, j) ? best[i + 1]![j + 1]! + 1 : Math.max(best[i + 1]![j]!, best[i]![j + 1]!);
    }
  }
  const matched: number[] = [];
  for (let i = 0, j = 0; i < n && j < m; ) {
    if (at(i, j) && best[i]![j] === best[i + 1]![j + 1]! + 1) {
      matched.push(i);
      i++;
      j++;
    } else if (best[i + 1]![j]! >= best[i]![j + 1]!) i++;
    else j++;
  }
  return matched;
}

function union(words: readonly WordBox[]): RowCheck['box'] {
  if (words.length === 0) return null;
  const x0 = Math.min(...words.map((w) => w.x));
  const y0 = Math.min(...words.map((w) => w.y));
  const x1 = Math.max(...words.map((w) => w.x + w.w));
  const y1 = Math.max(...words.map((w) => w.y + w.h));
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

/**
 * Every row against the page's lines. Rows keep their printed order on the
 * scan, so the matching does too: row 5 cannot be found above row 4, which
 * is what stops a short row borrowing a line that happens to share three
 * numbers with it.
 */
export function checkRows(page: PageOcr, rows: readonly PrintedRow[]): RowCheck[] {
  const byId = new Map(page.words.map((w) => [w.id, w]));
  const lines = page.lines.map((l) => l.wordIds.map((id) => byId.get(id)).filter((w): w is WordBox => w !== undefined));
  const readings = lines.map((ws) => ws.map((w) => wordReadings(w.text)));
  const matches = rows.map((r) => readings.map((words) => matchedFigures(r.values, words)));
  const score = (i: number, j: number) => {
    const k = matches[i]![j]!.length;
    return k >= MIN_MATCHED ? k : 0;
  };

  // best[i][j]: the most figures rows i.. can match using lines j.. in order.
  const R = rows.length;
  const L = lines.length;
  const best: number[][] = Array.from({ length: R + 1 }, () => new Array<number>(L + 1).fill(0));
  for (let i = R - 1; i >= 0; i--) {
    for (let j = L - 1; j >= 0; j--) {
      const take = score(i, j) > 0 ? score(i, j) + best[i + 1]![j + 1]! : 0;
      best[i]![j] = Math.max(take, best[i]![j + 1]!, best[i + 1]![j]!);
    }
  }

  const out: RowCheck[] = [];
  let j = 0;
  for (let i = 0; i < R; i++) {
    const row = rows[i]!;
    // Walk the lines the way the best answer did: take this one, leave the row without one, or move on.
    let taken: number | null = null;
    for (let k = j; k < L; k++) {
      const s = score(i, k);
      if (s > 0 && best[i]![k] === s + best[i + 1]![k + 1]!) {
        taken = k;
        break;
      }
      if (best[i]![k] === best[i + 1]![k]) {
        j = k;
        break;
      }
    }
    if (taken === null) {
      out.push({ lineIndex: null, text: '', box: null, unconfirmed: [...row.names] });
      continue;
    }
    const found = new Set(matches[i]![taken]);
    out.push({
      lineIndex: taken,
      text: page.lines[taken]!.text,
      box: union(lines[taken]!),
      unconfirmed: row.names.filter((_, k) => !found.has(k)),
    });
    j = taken + 1;
  }
  return out;
}

/**
 * A figure printed in a note: the note is found by its words, as a quoted
 * weight-and-balance line is, and the figure must be inside what was found.
 */
export function checkNote(page: PageOcr, printed: string, value: number, name: string): RowCheck {
  const found = locateText(page, printed);
  if (!found) return { lineIndex: null, text: '', box: null, unconfirmed: [name] };
  const tokens = new Map(page.words.map((w) => [w.id, w]));
  const alignment = alignNumbers(tokens, found.tokenIds, [value]);
  return { lineIndex: found.lineIndex, text: found.text, box: alignment.box, unconfirmed: alignment.match === 'none' ? [name] : [] };
}
