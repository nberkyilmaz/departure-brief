/**
 * Upper winds as a weather balloon measured them: the TTAA bulletin.
 *
 * Twice a day each station launches a balloon and sends what it found at
 * the mandatory pressure levels, one after another in groups of five:
 *
 *   USUS41 KALY 090000
 *   MANALY
 *   72518 TTAA  59001 72518 99993 10057 02502 00054 ///// /////
 *   92699 07057 26010 85388 01435 26529 70939 04148 28025 50550 …
 *
 * `59001` is the day plus 50 for knots, the hour, and the highest level
 * winds are given for. `99993 10057 02502` is the surface: 993 hPa, 10.0 °C
 * and a dew point depression of 7, 025° at 2 kt. After that each level is a
 * height, a temperature and a wind: `85388 01435 26529` is 850 hPa at 1,388 m,
 * 1.4 °C, 265° at 29 kt.
 *
 * Read into the same shape as a forecast, so everything downstream works on
 * it unchanged. Its levels are where the balloon found each pressure and
 * not fixed altitudes, and the first of them is the ground.
 *
 * What it has to say about the use window is decided here too. A measurement
 * has no valid period, but there has to be a point past which it stops being
 * an answer about the flight.
 */
import { soundingStation } from '../../domain/soundings.js';
import { resolveNearestDayTime } from '../../domain/time.js';
import { sourced, type Span } from '../span.js';
import type { DecodedUpperWind, UpperWindLevel } from './types.js';

/**
 * How long after it flew a sounding may be used. The next one is due at
 * twelve hours and takes up to an hour and a half to appear; the rest is
 * for the flight itself being later than the briefing.
 */
export const SOUNDING_USE_HOURS = 18;

const FT_PER_M = 3.28084;
const KT_PER_MS = 1.94384;

const HEADER = /\b([A-Z]{4}\d\d)\s+([A-Z]{4})\s+\d{6}\b/;

/** The pressure each level's first two digits stand for. */
const LEVELS: Readonly<Record<string, number>> = { '00': 1000, '92': 925, '85': 850, '70': 700, '50': 500, '40': 400, '30': 300, '25': 250, '20': 200, '15': 150, '10': 100 };

/** Three digits of height, with the thousands left for the reader to know. */
function heightMetres(indicator: string, hhh: number): number {
  switch (indicator) {
    case '00':
      // Over 500 is a level below sea level.
      return hhh >= 500 ? -(hhh - 500) : hhh;
    case '92':
      return hhh;
    case '85':
      return hhh + 1000;
    case '70':
      return hhh + (hhh < 500 ? 3000 : 2000);
    case '50':
    case '40':
      return hhh * 10;
    case '30':
      return hhh * 10 + (hhh < 500 ? 10_000 : 0);
    default:
      return hhh * 10 + 10_000;
  }
}

/** `TTTDD`: tenths of a degree, an odd last digit meaning below zero. `null` when the balloon did not report it. */
function temperature(group: string | undefined): number | null {
  if (!group || !/^\d{3}/.test(group)) return null;
  const tenths = Number(group.slice(0, 3));
  return (tenths % 2 === 0 ? tenths : -tenths) / 10;
}

/**
 * `dddff`. Directions go in fives, so a last digit of 1 or 6 is how a speed
 * of a hundred knots or more is written: 26615 is 265° at 115.
 */
function windOf(group: string | undefined, knots: boolean): { directionTrue: number | null; speedKt: number } | null {
  if (!group || !/^\d{5}$/.test(group)) return null;
  const coded = Number(group.slice(0, 3));
  const hundreds = coded % 5;
  const direction = coded - hundreds;
  const speed = Number(group.slice(3)) + hundreds * 100;
  if (direction > 360) return null;
  const speedKt = knots ? speed : Math.round(speed * KT_PER_MS);
  return { directionTrue: direction === 0 && speedKt === 0 ? null : direction, speedKt };
}

const empty = (raw: string): DecodedUpperWind => ({
  bulletin: null,
  issuer: null,
  issuedAt: null,
  basedOn: null,
  validAt: null,
  useFrom: null,
  useTo: null,
  levels: [],
  unparsed: [raw],
});

/**
 * Decode one station's bulletin. `reference` dates its day-of-month, which
 * carries no month or year: the time the report was stored under.
 *
 * Nothing after the mandatory levels is read. The tropopause and maximum
 * wind groups and the sections beyond them are far above a light aircraft,
 * and stay in the report for anyone who wants them.
 */
export function decodeTtaa(raw: string, reference: Date | null): DecodedUpperWind {
  const tokens = [...raw.matchAll(/\S+/g)].map((m) => ({ text: m[0].replace(/=$/, ''), start: m.index, end: m.index + m[0].length }));
  const at = tokens.findIndex((t) => t.text === 'TTAA');
  const time = tokens[at + 1];
  const id = tokens[at + 2];
  if (at === -1 || !time || !id || reference === null || !/^\d{4}[\d/]$/.test(time.text) || !/^\d{5}$/.test(id.text)) return empty(raw);

  const coded = Number(time.text.slice(0, 2));
  const knots = coded > 50;
  const measured = resolveNearestDayTime({ day: knots ? coded - 50 : coded, hour: Number(time.text.slice(2, 4)), minute: 0 }, reference);
  if (!measured) return empty(raw);

  const windsTo = time.text[4]!;
  const windsReach = windsTo === '/' ? Number.POSITIVE_INFINITY : windsTo === '0' ? 1000 : Number(windsTo) * 100;
  const elevationFt = soundingStation(id.text)?.elevationFt ?? null;

  const levels: UpperWindLevel[] = [];
  const unparsed: string[] = [];
  const put = (altitudeFt: number | null, tempGroup: string | undefined, windGroup: string | undefined, span: Span, words: string) => {
    const wind = windOf(windGroup, knots);
    if (!wind || altitudeFt === null) {
      // All slashes is a level the balloon had nothing for, not something unread.
      if (tempGroup?.replaceAll('/', '') || windGroup?.replaceAll('/', '')) unparsed.push(words);
      return;
    }
    levels.push({ altitudeFt, ...wind, tempC: temperature(tempGroup), span });
  };

  let i = at + 3;
  while (i < tokens.length) {
    const group = tokens[i]!;
    if (/^(88|77|66)/.test(group.text) || /^(31313|41414|51515|NNNN)$/.test(group.text)) break;
    if (!/^\d{2}[\d/]{3}$/.test(group.text)) {
      unparsed.push(group.text);
      i++;
      continue;
    }
    const indicator = group.text.slice(0, 2);
    const surface = indicator === '99';
    const pressure = LEVELS[indicator];
    if (!surface && pressure === undefined) {
      unparsed.push(group.text);
      i++;
      continue;
    }
    const hasWind = surface || pressure! >= windsReach;
    const last = tokens[i + (hasWind ? 2 : 1)];
    const tempGroup = tokens[i + 1]?.text;
    const windGroup = hasWind ? tokens[i + 2]?.text : undefined;
    const span = { start: group.start, end: (last ?? group).end };
    const words = raw.slice(span.start, span.end);
    if (surface) {
      // Its height is the ground, which the bulletin takes as known.
      if (elevationFt === null) unparsed.push(words);
      else put(elevationFt, tempGroup, windGroup, span, words);
    } else {
      const hhh = group.text.slice(2);
      const altitudeFt = /^\d{3}$/.test(hhh) ? Math.round(heightMetres(indicator, Number(hhh)) * FT_PER_M) : null;
      // A pressure the ground is above reports a height under the station, and nothing was measured there.
      if (altitudeFt === null || elevationFt === null || altitudeFt > elevationFt) put(altitudeFt, tempGroup, windGroup, span, words);
    }
    i += hasWind ? 3 : 2;
  }
  levels.sort((a, b) => a.altitudeFt - b.altitudeFt);

  const header = HEADER.exec(raw);
  const timeSpan: Span = { start: time.start, end: time.end };
  const flew = sourced(measured, timeSpan);
  return {
    bulletin: header ? sourced(header[1]!, { start: header.index, end: header.index + header[1]!.length }) : null,
    issuer: header ? sourced(header[2]!, { start: header.index + header[0].indexOf(header[2]!, header[1]!.length), end: header.index + header[0].indexOf(header[2]!, header[1]!.length) + header[2]!.length }) : null,
    issuedAt: flew,
    basedOn: flew,
    validAt: flew,
    useFrom: flew,
    useTo: sourced(new Date(measured.getTime() + SOUNDING_USE_HOURS * 3_600_000), timeSpan),
    levels,
    unparsed,
  };
}
