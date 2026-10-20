/**
 * A half-open byte range `[start, end)` into the raw report string.
 *
 * Every decoded field carries one. It is the grounding used everywhere
 * downstream: a finding cites a span, the UI highlights a span, citation
 * verification checks a span. Spans are never fabricated — they always come
 * from the tokenizer.
 */
export interface Span {
  readonly start: number;
  readonly end: number;
}

/** A decoded value together with the span of raw text it was decoded from. */
export interface Sourced<T> {
  readonly value: T;
  readonly span: Span;
}

export function sourced<T>(value: T, span: Span): Sourced<T> {
  return { value, span };
}

export function sliceSpan(raw: string, span: Span): string {
  return raw.slice(span.start, span.end);
}

/** The smallest span covering both inputs (including any text between them). */
export function joinSpans(a: Span, b: Span): Span {
  return { start: Math.min(a.start, b.start), end: Math.max(a.end, b.end) };
}

/** True when the span lies inside `raw` and is non-empty. */
export function isValidSpan(raw: string, span: Span): boolean {
  return (
    Number.isInteger(span.start) &&
    Number.isInteger(span.end) &&
    span.start >= 0 &&
    span.end <= raw.length &&
    span.start < span.end
  );
}
