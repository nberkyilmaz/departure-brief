import type { Span } from '../../src/decode/span.js';

/**
 * The span of the `nth` whitespace-delimited occurrence of `sub` in `raw`.
 * `sub` may itself contain spaces (`"1 1/2SM"`). Throws if absent, so a
 * wrong expectation fails loudly rather than producing a bogus span.
 */
export function at(raw: string, sub: string, nth = 0): Span {
  let seen = 0;
  let from = 0;
  for (;;) {
    const idx = raw.indexOf(sub, from);
    if (idx < 0) throw new Error(`occurrence ${nth} of "${sub}" not found in "${raw}"`);
    const end = idx + sub.length;
    const boundedStart = idx === 0 || /\s/.test(raw[idx - 1]!);
    const boundedEnd = end === raw.length || /\s/.test(raw[end]!);
    if (boundedStart && boundedEnd) {
      if (seen === nth) return { start: idx, end };
      seen++;
    }
    from = idx + 1;
  }
}
