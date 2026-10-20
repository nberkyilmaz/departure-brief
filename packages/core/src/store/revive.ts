/**
 * Putting the `Date`s back into a decoded record read out of the store.
 *
 * Decoded records are stored as JSON, and JSON has no date. A `Date` goes
 * in and an ISO string comes back, which every type here still calls a
 * `Date` because the read site casts. In memory that cast is harmless — the
 * object never left the process — so the whole suite passes; against a real
 * database the first `.getTime()` on a revived record throws, and the only
 * place that happens is a deployed instance reading something it stored
 * before it restarted.
 *
 * That is exactly the bug this exists to close, found by running the server
 * against Postgres twice: the first briefing decoded its upper winds in
 * process and worked, and the second read them back and died in
 * `upperWindFor`.
 *
 * Only two decoders put a `Date` inside their output — the upper winds and
 * the hazard advisories. METAR and TAF store the day-and-hour groups as the
 * report writes them and resolve them against a reference instant, so they
 * cross JSON unharmed.
 */
import type { DecodedSigmet } from '../decode/sigmet/types.js';
import type { Sourced } from '../decode/span.js';
import type { DecodedUpperWind } from '../decode/upperwind/types.js';

/**
 * An ISO string becomes a `Date` again; a `Date` is left alone, so this is
 * safe on a value that never went through JSON. Anything else — a number, a
 * malformed string — becomes `null`, because a date this cannot read is a
 * missing date and not a guess at what was meant.
 */
function reviveDate(value: unknown): Date | null {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  if (typeof value !== 'string') return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/** The same, for a date that carries the span of the text it was read from. */
function reviveSourcedDate(value: unknown): Sourced<Date> | null {
  if (value === null || typeof value !== 'object') return null;
  const sourced = value as { value?: unknown; span?: unknown };
  const date = reviveDate(sourced.value);
  if (date === null || sourced.span === undefined) return null;
  return { value: date, span: sourced.span as Sourced<Date>['span'] };
}

/** A decoded upper wind record as it was before it was stored. */
export function reviveUpperWind(decoded: unknown): DecodedUpperWind {
  const d = decoded as DecodedUpperWind;
  return {
    ...d,
    issuedAt: reviveSourcedDate(d.issuedAt),
    basedOn: reviveSourcedDate(d.basedOn),
    validAt: reviveSourcedDate(d.validAt),
    useFrom: reviveSourcedDate(d.useFrom),
    useTo: reviveSourcedDate(d.useTo),
  };
}

/** A decoded hazard advisory as it was before it was stored. */
export function reviveSigmet(decoded: unknown): DecodedSigmet {
  const d = decoded as DecodedSigmet;
  return { ...d, validFrom: reviveDate(d.validFrom), validTo: reviveDate(d.validTo) };
}
