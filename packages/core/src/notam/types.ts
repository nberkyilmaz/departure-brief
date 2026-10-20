import type { Sourced, Span } from '../decode/span.js';
import type { UnparsedToken } from '../decode/unparsed.js';

/** `J5067/26` — series letter, sequence number, two-digit year. */
export interface NotamId {
  readonly series: string;
  readonly number: number;
  readonly year: number;
  /** As written, e.g. `J5067/26`. */
  readonly text: string;
}

/** `NOTAMN` new, `NOTAMR` replacing, `NOTAMC` cancelling. */
export type NotamType = 'NOTAMN' | 'NOTAMR' | 'NOTAMC';

/** The five-letter Q code split: `QMRLC` → subject `MR`, condition `LC`. */
export interface QCode {
  readonly text: string;
  readonly subject: string;
  readonly condition: string;
}

/**
 * The Q) line: `CZYZ/QMRLC/IV/NBO/A/000/999/4312N07910W005`.
 * Levels are flight levels (hundreds of feet); `999` is unlimited by convention.
 */
export interface QLine {
  readonly fir: string;
  readonly code: QCode;
  /** `I` IFR, `V` VFR, `IV` both, `K` checklist. */
  readonly traffic: string;
  /** Combination of `N` immediate attention, `B` PIB entry, `O` flight operations, `M` miscellaneous, `K` checklist. */
  readonly purpose: string;
  /** `A` aerodrome, `E` en-route, `W` nav warning, `K` checklist, or combinations. */
  readonly scope: string;
  readonly lower: number;
  readonly upper: number;
  readonly centre: { readonly lat: number; readonly lon: number } | null;
  /** Nautical miles; `999` means the whole FIR by convention. */
  readonly radiusNm: number | null;
}

/** A NOTAM instant: `2609022254` is 2026-09-02 22:54 UTC. */
export interface NotamInstant {
  readonly iso: string;
  /** `C)` may be an estimate (`…EST`). */
  readonly estimated: boolean;
}

export type NotamEnd = NotamInstant | { readonly permanent: true };

/**
 * A literal, span-annotated transcription of one ICAO-format NOTAM. Every
 * field is `Sourced` or `null`; nothing is interpreted here. The E) text is
 * the free text the relevance model reads and must cite verbatim.
 */
export interface DecodedNotam {
  readonly raw: string;
  readonly id: Sourced<NotamId> | null;
  readonly type: Sourced<NotamType> | null;
  /** The NOTAM this one replaces or cancels. */
  readonly refers: Sourced<NotamId> | null;
  readonly q: Sourced<QLine> | null;
  /** A) locations, usually one aerodrome or one or more FIRs. */
  readonly locations: Sourced<readonly string[]> | null;
  readonly from: Sourced<NotamInstant> | null;
  readonly to: Sourced<NotamEnd> | null;
  /** D) schedule, kept as text; interpreting schedules is the filter's job. */
  readonly schedule: Sourced<string> | null;
  readonly text: Sourced<string> | null;
  /** F) and G) lower/upper limits as written. */
  readonly lowerLimit: Sourced<string> | null;
  readonly upperLimit: Sourced<string> | null;
  readonly unparsed: readonly UnparsedToken[];
}

export type { Span };
