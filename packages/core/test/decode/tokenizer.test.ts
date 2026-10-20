import { describe, expect, it } from 'vitest';
import { isValidSpan, joinSpans, sliceSpan } from '../../src/decode/span.js';
import { tokenize } from '../../src/decode/tokenizer.js';

describe('tokenize', () => {
  it('splits on whitespace runs and keeps offsets', () => {
    const raw = 'KJFK  141851Z\t28016G24KT\n10SM';
    const t = tokenize(raw);
    expect(t.map((x) => x.text)).toEqual(['KJFK', '141851Z', '28016G24KT', '10SM']);
    for (const tok of t) expect(sliceSpan(raw, tok)).toBe(tok.text);
  });

  it('ignores leading and trailing whitespace without altering offsets', () => {
    const raw = '  KJFK 141851Z ';
    const t = tokenize(raw);
    expect(t).toEqual([
      { text: 'KJFK', start: 2, end: 6 },
      { text: '141851Z', start: 7, end: 14 },
    ]);
  });

  it('returns no tokens for empty or blank input', () => {
    expect(tokenize('')).toEqual([]);
    expect(tokenize('   \n ')).toEqual([]);
  });

  it('does not fold case or otherwise normalise', () => {
    expect(tokenize('kjfk Metar').map((x) => x.text)).toEqual(['kjfk', 'Metar']);
  });
});

describe('spans', () => {
  it('joinSpans covers both and the gap between', () => {
    expect(joinSpans({ start: 5, end: 8 }, { start: 10, end: 12 })).toEqual({ start: 5, end: 12 });
    expect(joinSpans({ start: 10, end: 12 }, { start: 5, end: 8 })).toEqual({ start: 5, end: 12 });
  });

  it('isValidSpan rejects empty, reversed and out-of-range spans', () => {
    const raw = 'abcdef';
    expect(isValidSpan(raw, { start: 0, end: 6 })).toBe(true);
    expect(isValidSpan(raw, { start: 2, end: 2 })).toBe(false);
    expect(isValidSpan(raw, { start: 3, end: 2 })).toBe(false);
    expect(isValidSpan(raw, { start: 0, end: 7 })).toBe(false);
    expect(isValidSpan(raw, { start: -1, end: 2 })).toBe(false);
    expect(isValidSpan(raw, { start: 0.5, end: 2 })).toBe(false);
  });
});
