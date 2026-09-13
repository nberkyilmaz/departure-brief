import { describe, expect, it } from 'vitest';
import { alignNumbers, alignText, locateText, normaliseOcr, numbersIn, resolveCitation, tokensById } from '../../src/docs/align.js';
import { groupLines } from '../../src/docs/lines.js';
import { unrotateBox } from '../../src/docs/reader/ocr.js';
import type { DocumentOcr, PageOcr, WordBox } from '../../src/docs/types.js';

const word = (id: number, text: string, x: number, y: number, page = 1, w = 40, h = 12): WordBox => ({ id, page, text, x, y, w, h, confidence: 80 });

/** A page built straight from words, for tests that only care about the text. */
const pageOf = (words: WordBox[], page = 1, widthPx = 1000, heightPx = 1000, rotation: 0 | 90 | 270 = 0): PageOcr => ({
  page,
  widthPx,
  heightPx,
  rotation,
  meanConfidence: 80,
  words,
  lines: groupLines(words, rotation, widthPx, heightPx),
  status: 'read',
  error: null,
});

/** A tiny document shaped like the sample loading problem row: "4. Pilot and Front Passenger (Station 34 to 46) . . . 340 12.8". */
const doc: DocumentOcr = {
  sha256: 'x',
  filename: 'poh.pdf',
  pageCount: 2,
  reader: { engine: 'tesseract.js', version: '0', lang: 'eng', scale: 3, readerVersion: 1 },
  pages: [
    pageOf([word(1, 'Pilot', 10, 100), word(2, 'and', 60, 100), word(3, 'Front', 100, 100), word(4, 'Passenger', 150, 100), word(5, '340', 600, 100), word(6, '12.8', 700, 100), word(7, '2,300', 600, 200), word(8, '1O2.9', 700, 200), word(9, 'l5', 600, 300), word(10, 'Lbs.', 650, 300)]),
    pageOf([word(11, '2300', 600, 100, 2)], 2),
  ],
};
const tokens = tokensById(doc);

/** The word map for a standalone page, so a located quote can be aligned against it. */
const tokensOf = (page: { words: readonly WordBox[] }) => new Map(page.words.map((w) => [w.id, w]));

describe('numbersIn / normaliseOcr', () => {
  it('reads printed numbers, thousands commas included', () => {
    expect(numbersIn('TOTAL 2,300 lb at 102.9 and -0.2')).toEqual([2300, 102.9, -0.2]);
  });
  it('undoes the usual OCR confusions only next to digits', () => {
    expect(normaliseOcr('1O2.9')).toBe('102.9');
    expect(normaliseOcr('l5 Lbs')).toBe('15 Lbs');
    expect(normaliseOcr('12,8')).toBe('12.8');
    expect(normaliseOcr('Oil')).toBe('Oil');
    expect(normaliseOcr('SOLO')).toBe('SOLO');
  });
});

describe('alignNumbers', () => {
  it('exact when the cited tokens print the figure', () => {
    const a = alignNumbers(tokens, [5], [340]);
    expect(a.match).toBe('exact');
    expect(a.page).toBe(1);
    expect(a.box).toEqual({ x: 600, y: 100, w: 40, h: 12 });
  });
  it('normalised when only OCR confusions separate them, and says so', () => {
    expect(alignNumbers(tokens, [8], [102.9]).match).toBe('normalised');
    expect(alignNumbers(tokens, [9, 10], [15]).match).toBe('normalised');
    expect(alignNumbers(tokens, [7], [2300]).match).toBe('exact');
  });
  it('none when the figure is not in the cited text, with the reason', () => {
    const a = alignNumbers(tokens, [5, 6], [350]);
    expect(a.match).toBe('none');
    expect(a.problem).toContain('does not contain 350');
  });
  it('none when the citation is empty, missing, or spans pages', () => {
    expect(alignNumbers(tokens, [], [340]).problem).toBe('no tokens cited');
    expect(alignNumbers(tokens, [5, 999], [340]).problem).toContain('999');
    expect(alignNumbers(tokens, [5, 11], [340]).problem).toContain('span pages');
  });
  it('a multi-number value needs every number', () => {
    expect(alignNumbers(tokens, [5, 6], [340, 12.8]).match).toBe('exact');
    expect(alignNumbers(tokens, [5], [340, 12.8]).match).toBe('none');
  });
  it('unions the boxes it cites', () => {
    expect(alignNumbers(tokens, [1, 4], [0]).box).toEqual({ x: 10, y: 100, w: 180, h: 12 });
    expect(resolveCitation(tokens, [1, 4]).page).toBe(1);
  });
});

describe('locateText', () => {
  // A page of real POH lines, as the OCR read them (mistakes included).
  const lines = [
    'NORMAL CATEGORY',
    'Maximum Takeoff Weight: 2300 Ibs.',
    'Maximum Landing Weight: 2300 lbs.',
    'UTILITY CATEGORY',
    'Maximum Takeoff Weight: 2000 ibs.',
    'Forward: 35.0 inches aft of datum at 1950 Ibs. or less, with siraight',
    'line variation to 38.5 inches aft of datum at 2300 Ibe.',
  ];
  let id = 100;
  const words = lines.flatMap((text, row) =>
    text.split(' ').map((t, i) => word(id++, t, 50 + i * 60, 100 + row * 40)),
  );
  const page = pageOf(words);

  it('finds a quoted phrase and returns exactly the words it covers', () => {
    const found = locateText(page, 'Maximum Takeoff Weight: 2300')!;
    expect(found.text).toBe('Maximum Takeoff Weight: 2300');
    expect(found.tokenIds).toHaveLength(4);
    expect(alignNumbers(tokensOf(page), found.tokenIds, [2300]).match).toBe('exact');
  });

  it('distinguishes two lines that differ only in the figure — the utility limit is not the normal one', () => {
    const normal = locateText(page, 'Maximum Takeoff Weight: 2300 Ibs.')!;
    const utility = locateText(page, 'Maximum Takeoff Weight: 2000 ibs.')!;
    expect(normal.lineIndex).toBe(1);
    expect(utility.lineIndex).toBe(4);
  });

  it('is case- and whitespace-insensitive', () => {
    expect(locateText(page, 'maximum   takeoff weight: 2300')!.lineIndex).toBe(1);
    expect(locateText(page, 'MAXIMUM TAKEOFF WEIGHT: 2300')!.lineIndex).toBe(1);
  });

  it('forgives OCR confusions inside figures, which is where they matter', () => {
    const garbled = [word(900, 'Aft:', 50, 400), word(901, '47.', 110, 400), word(902, '3', 160, 400), word(903, 'inches', 200, 400)];
    const p = pageOf(garbled);
    // The scan split the figure; a quote of it as printed still lands on those words.
    expect(locateText(p, 'Aft: 47. 3 inches')!.tokenIds).toEqual([900, 901, 902, 903]);
    // Digit-adjacent glyph confusions are folded: "1O2.9" on the page matches a quote of "102.9".
    const conf = [word(910, 'TOTAL', 50, 500), word(911, '1O2.9', 110, 500)];
    const p2 = pageOf(conf);
    expect(locateText(p2, 'TOTAL 102.9')!.tokenIds).toEqual([910, 911]);
    expect(locateText(p2, 'TOTAL 102.9', false)).toBeNull();
    // Letter-only confusions are not folded word for word, so this is not an
    // exact find — but the line is still recognised, approximately (below).
    expect(locateText(page, 'Maximum Takeoff Weight: 2300 lbs.')!.approximate).toBe(true);
  });

  it('recognises the line a clean quote refers to when the scan garbled it', () => {
    // What a model reading the page image writes, against what the scanner read.
    const found = locateText(page, 'Forward: 35.0 inches aft of datum at 1950 lbs. or less, with straight')!;
    expect(found.approximate).toBe(true);
    expect(found.lineIndex).toBe(5);
    // The whole line comes back, in the page's own spelling, so the figure is
    // still checked against what is actually printed.
    expect(found.text).toContain('siraight');
    expect(alignNumbers(tokensOf(page), found.tokenIds, [35.0, 1950]).match).toBe('exact');
  });

  it('follows a quoted sentence across the lines it was printed on', () => {
    // The POH prints this as two lines; a model quotes it as one sentence.
    const wrapped = locateText(page, 'Forward: 35.0 inches aft of datum at 1950 lbs. or less, with straight line variation to 38.5 inches aft of datum at 2300 lbs.')!;
    expect(wrapped.lineIndex).toBe(5);
    expect(wrapped.lineCount).toBe(2);
    expect(wrapped.text).toContain('38.5');
    // The tightest run that says it, not merely the first window containing it.
    expect(wrapped.lineCount).toBeLessThan(3);
    // Both points of the sloped limit are now checkable against the page.
    expect(alignNumbers(tokensOf(page), wrapped.tokenIds, [2300, 38.5]).match).toBe('exact');
  });

  it('refuses a quote that merely shares a few words with a line', () => {
    expect(locateText(page, 'Maximum Ramp Weight: 2400 lbs.')).toBeNull();
    expect(locateText(page, 'Maximum Zero Fuel Weight')).toBeNull();
  });

  it('an exact find is not marked approximate', () => {
    expect(locateText(page, 'Maximum Takeoff Weight: 2300 Ibs.')!.approximate).toBe(false);
  });

  it('returns null for a quote that is not on the page', () => {
    expect(locateText(page, 'Fuel capacity 42 gallons total')).toBeNull();
    expect(locateText(page, '')).toBeNull();
  });

  it('covers a phrase in the middle of a line without dragging in its neighbours', () => {
    const found = locateText(page, '35.0 inches aft of datum at 1950')!;
    expect(found.text).toBe('35.0 inches aft of datum at 1950');
    expect(found.text.startsWith('Forward')).toBe(false);
  });
});

describe('alignText', () => {
  it('matches words regardless of case and punctuation', () => {
    expect(alignText(tokens, [1, 2, 3, 4], 'pilot and front passenger').match).toBe('exact');
    expect(alignText(tokens, [1, 2], 'front passenger').match).toBe('none');
  });
});

describe('groupLines with rotation', () => {
  it('reads a sideways page along its rotated axis and maps boxes back', () => {
    // A page scanned sideways: text runs up the page. Two words on one printed line
    // share x in the scanned frame (after a 90° clockwise turn they share y).
    const W = 1000;
    const H = 2000;
    const ws = [word(1, 'B', 500, 1200, 1, 12, 40), word(2, 'A', 500, 1500, 1, 12, 40), word(3, 'C', 700, 1500, 1, 12, 40)];
    const lines = groupLines(ws, 90, W, H);
    expect(lines.map((l) => l.text)).toEqual(['A B', 'C']);
    // Round trip: a box in the rotated image comes back to where the ink is.
    const rotated = { x: H - (1200 + 40), y: 500, w: 40, h: 12 };
    expect(unrotateBox(rotated, 90, W, H)).toEqual({ x: 500, y: 1200, w: 12, h: 40 });
    const ccw = { x: 1200, y: W - (500 + 12), w: 40, h: 12 };
    expect(unrotateBox(ccw, 270, W, H)).toEqual({ x: 500, y: 1200, w: 12, h: 40 });
  });
  it('groups upright words by vertical centre, left to right', () => {
    const ws = [word(1, 'b', 200, 100), word(2, 'a', 100, 103), word(3, 'c', 100, 140)];
    expect(groupLines(ws).map((l) => l.text)).toEqual(['a b', 'c']);
  });
});
