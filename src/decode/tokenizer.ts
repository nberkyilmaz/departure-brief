import type { Span } from './span.js';

/** A whitespace-delimited group of the raw report, with its span. */
export interface Token extends Span {
  readonly text: string;
}

/**
 * Split a raw report on runs of whitespace, preserving offsets.
 *
 * The raw text is never normalised: no case folding, no trimming of the
 * stored string, no line-ending conversion. Tokens reference the input as
 * given so that every span can be sliced back out of it verbatim.
 */
export function tokenize(raw: string): Token[] {
  const tokens: Token[] = [];
  const re = /\S+/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(raw)) !== null) {
    tokens.push({ text: m[0], start: m.index, end: m.index + m[0].length });
  }
  return tokens;
}

/** A cursor over tokens: the primitive every group parser consumes. */
export interface Cursor {
  readonly tokens: readonly Token[];
  readonly index: number;
}

export function peek(c: Cursor, offset = 0): Token | undefined {
  return c.tokens[c.index + offset];
}
