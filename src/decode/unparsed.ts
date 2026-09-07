import type { Span } from './span.js';

/** Which part of a report an unparsed token came from. */
export type Section = 'body' | 'trend' | 'remarks';

/**
 * A token the decoder did not recognise. Never dropped: it keeps its text
 * and span so the UI can show it and the corpus report can count it.
 */
export interface UnparsedToken {
  readonly text: string;
  readonly span: Span;
  readonly section: Section;
}
