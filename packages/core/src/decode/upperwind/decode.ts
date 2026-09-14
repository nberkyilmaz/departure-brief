/**
 * Upper winds as NAV CANADA's flight planning service sends them.
 *
 * Unusually for this pipeline there is nothing coded to parse: the service
 * has already turned the FD bulletin into numbers, and the record is a JSON
 * array. What it has not done is say which number is which, so this decoder
 * is mostly about naming the positions — and about refusing anything that
 * does not look like what it claims to be, rather than reading a
 * temperature as a wind direction because the shape drifted.
 *
 * Every value still carries the span of the record it came from. The record
 * is stored verbatim, so a pilot can see the numbers the service sent
 * beside the ones this tool derived from them.
 *
 *   ["FBCN31","CWAO","2026-09-14T03:20:00+00:00", … ,[[9000,290,23,1,0], …]]
 *     0        1      2 issued    3 based on   4 valid  5 use from  6 use to
 */
import { sourced, type Span, type Sourced } from '../span.js';
import type { DecodedUpperWind, UpperWindLevel } from './types.js';

export const UPPERWIND_DECODER_VERSION = 1;

/** Where in the array each field lives. Named, so nothing reads by number twice. */
const BULLETIN = 0;
const ISSUER = 1;
const ISSUED_AT = 2;
const BASED_ON = 3;
const VALID_AT = 4;
const USE_FROM = 5;
const USE_TO = 6;

/** A level is `[altitude, direction, speed, temperature, ?]`. */
const ALTITUDE = 0;
const DIRECTION = 1;
const SPEED = 2;
const TEMP = 3;

/**
 * The span of the nth top-level element, found in the raw text rather than
 * computed from it. A span this decoder could not locate is left out
 * entirely; a fabricated one would defeat the point of having them.
 */
function spanOfJson(raw: string, value: unknown): Span | null {
  const needle = JSON.stringify(value);
  const at = raw.indexOf(needle);
  return at === -1 ? null : { start: at, end: at + needle.length };
}

function citedString(raw: string, value: unknown): Sourced<string> | null {
  if (typeof value !== 'string' || value.trim() === '') return null;
  const span = spanOfJson(raw, value);
  return span ? sourced(value, span) : null;
}

function citedDate(raw: string, value: unknown): Sourced<Date> | null {
  if (typeof value !== 'string') return null;
  const at = new Date(value);
  if (Number.isNaN(at.getTime())) return null;
  const span = spanOfJson(raw, value);
  return span ? sourced(at, span) : null;
}

/** A finite number, or null for anything else — including the service's nulls. */
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

function decodeLevel(raw: string, entry: unknown, unparsed: string[]): UpperWindLevel | null {
  if (!Array.isArray(entry)) {
    unparsed.push(JSON.stringify(entry));
    return null;
  }
  const altitudeFt = num(entry[ALTITUDE]);
  const speedKt = num(entry[SPEED]);
  if (altitudeFt === null || altitudeFt <= 0 || speedKt === null || speedKt < 0) {
    unparsed.push(JSON.stringify(entry));
    return null;
  }
  const direction = num(entry[DIRECTION]);
  const span = spanOfJson(raw, entry);
  if (!span) {
    unparsed.push(JSON.stringify(entry));
    return null;
  }
  return {
    altitudeFt,
    /*
     * A null direction with no speed is light and variable — the FD
     * bulletin's "9900". A direction outside the compass is not something
     * to guess at, so it is treated the same way and the numbers stay
     * visible in the record.
     */
    directionTrue: direction === null || direction < 0 || direction > 360 ? null : direction === 0 && speedKt === 0 ? null : direction,
    speedKt,
    tempC: num(entry[TEMP]),
    span,
  };
}

/**
 * Decode one upper wind record. `raw` is the record's text exactly as the
 * service sent it, which is what the store holds and what the spans index
 * into.
 */
export function decodeUpperWind(raw: string): DecodedUpperWind {
  const unparsed: string[] = [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { bulletin: null, issuer: null, issuedAt: null, basedOn: null, validAt: null, useFrom: null, useTo: null, levels: [], unparsed: [raw] };
  }
  if (!Array.isArray(parsed)) {
    return { bulletin: null, issuer: null, issuedAt: null, basedOn: null, validAt: null, useFrom: null, useTo: null, levels: [], unparsed: [raw] };
  }

  // The levels are the last element, and the only array of arrays in the record.
  const tail = parsed[parsed.length - 1];
  const levelEntries = Array.isArray(tail) ? tail : [];
  if (!Array.isArray(tail)) unparsed.push(JSON.stringify(tail));

  const levels = levelEntries
    .map((entry) => decodeLevel(raw, entry, unparsed))
    .filter((l): l is UpperWindLevel => l !== null)
    // The service sends them in no particular order; a reader wants them climbing.
    .sort((a, b) => a.altitudeFt - b.altitudeFt);

  return {
    bulletin: citedString(raw, parsed[BULLETIN]),
    issuer: citedString(raw, parsed[ISSUER]),
    issuedAt: citedDate(raw, parsed[ISSUED_AT]),
    basedOn: citedDate(raw, parsed[BASED_ON]),
    validAt: citedDate(raw, parsed[VALID_AT]),
    useFrom: citedDate(raw, parsed[USE_FROM]),
    useTo: citedDate(raw, parsed[USE_TO]),
    levels,
    unparsed,
  };
}
