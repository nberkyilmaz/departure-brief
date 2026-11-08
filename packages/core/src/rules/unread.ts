/**
 * Text a decoder could not read, said as a finding.
 *
 * The decoders never drop a token they do not understand; they keep it,
 * with its span, as unparsed. But the rules only ever read what was
 * decoded, so an unread token reached nobody. A forecaster's typo —
 * `FN060000` for `FM060000` — loses the whole change group behind it: the
 * 400 ft overcast it forecast never reaches a check, and the period before
 * it carries on as though nothing had been said. A pilot reading the TAF
 * would see it at once. So the briefing says that part of the report was
 * not read, quotes it, and points at it.
 *
 * Remarks are left out. They are notes about the station, and a remark the
 * decoder does not know is already shown, unread, on the aerodrome page.
 */
import type { Span } from '../decode/span.js';
import type { UnparsedToken } from '../decode/unparsed.js';
import type { BasisKind, Citation, Finding } from './types.js';

export interface UnreadContext {
  readonly waypoint: string;
  readonly at: Date;
  readonly basis: string;
  readonly basisKind: BasisKind;
  readonly source: { readonly kind: 'taf' | 'metar'; readonly station: string | null; readonly raw: string; readonly sha256: string | null };
}

/** Tokens side by side in the report, with only spaces between them, read as one run of text. */
function runs(raw: string, tokens: readonly UnparsedToken[]): Span[] {
  const sorted = [...tokens].sort((a, b) => a.span.start - b.span.start);
  const out: Span[] = [];
  for (const t of sorted) {
    const last = out[out.length - 1];
    if (last && raw.slice(last.end, t.span.start).trim() === '') out[out.length - 1] = { start: last.start, end: Math.max(last.end, t.span.end) };
    else out.push({ ...t.span });
  }
  return out;
}

/** One finding for a report with unread text in its body, or none. */
export function checkUnread(ctx: UnreadContext, unparsed: readonly UnparsedToken[]): Finding[] {
  const body = unparsed.filter((u) => u.section !== 'remarks');
  if (body.length === 0) return [];
  const spans = runs(ctx.source.raw, body);
  const quoted = spans.map((s) => `"${ctx.source.raw.slice(s.start, s.end)}"`).join(', ');
  const product = ctx.source.kind === 'taf' ? 'TAF' : 'METAR';
  const citations: Citation[] = spans.map((span) => ({
    kind: ctx.source.kind,
    station: ctx.source.station,
    raw: ctx.source.raw,
    span,
    text: ctx.source.raw.slice(span.start, span.end),
    sha256: ctx.source.sha256,
  }));
  return [
    {
      rule: 'report.unread',
      attention: 'caution',
      summary: `part of the ${ctx.source.station ?? ''} ${product} could not be read, so nothing in it was checked: ${quoted}. Read it in the report`.replace(/\s+/g, ' '),
      waypoint: ctx.waypoint,
      basis: ctx.basis,
      basisKind: ctx.basisKind,
      at: ctx.at.toISOString(),
      values: { product, tokens: body.map((u) => u.text) },
      citations,
    },
  ];
}
