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
 * Those levels are thousands of feet apart where a light aircraft flies. The
 * same flight's significant levels fill them in, from a second bulletin that
 * is added after the first when it has arrived:
 *
 *   72520 TTBB  59128 72520
 *   00973 05817 11966 06231 22949 06623 …
 *   PPBB  59128 72520
 *   90/23 26003 28527 31029 90456 30033 30035 29534 …
 *
 * TTBB is where the temperature changed course, in pairs: `11966 06231` is a
 * running number, 966 hPa, and 6.2 °C with a dew point depression of 31. It
 * gives pressures and no heights, so each is placed between the heights the
 * mandatory levels give around it.
 *
 * PPBB is the wind at heights in thousands of feet: `90456` is no tens of
 * thousands, then 4,000, 5,000 and 6,000 ft, and the three winds after it
 * are those in order. A slash is a place not used, except the very first,
 * where `90/` stands for the surface. TTBB's `21212` section has much the
 * same winds again by pressure, and fewer of them at a light aircraft's
 * heights, so it is not read.
 *
 * The two lists do not line up, and neither gives what the other does, so
 * nothing is filled in to make them: winds stay in `levels` and temperatures
 * in `temperatures`, each cited from the groups that actually said it.
 *
 * What it has to say about the use window is decided here too. A measurement
 * has no valid period, but there has to be a point past which it stops being
 * an answer about the flight.
 */
import { soundingStation } from '../../domain/soundings.js';
import { resolveNearestDayTime } from '../../domain/time.js';
import { sourced, type Span } from '../span.js';
import type { DecodedUpperWind, TemperatureLevel, UpperWindLevel } from './types.js';

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

interface Token {
  readonly text: string;
  readonly start: number;
  readonly end: number;
}

/** Somewhere the balloon reported both a pressure and a height. */
interface Anchor {
  readonly hPa: number;
  readonly altitudeFt: number;
}

/** `PPP`, with the thousand left off a pressure over 1,000 hPa. */
function pressureOf(ppp: string): number | null {
  if (!/^\d{3}$/.test(ppp)) return null;
  return Number(ppp) + (Number(ppp) < 100 ? 1000 : 0);
}

/**
 * How high a pressure was, from the two reported around it, highest pressure
 * first. Across a layer this thin height goes very nearly in a straight line
 * with the logarithm of pressure. `null` outside them, or exactly on one,
 * which the mandatory levels have already given.
 */
function heightAtPressure(anchors: readonly Anchor[], hPa: number): number | null {
  for (const [i, below] of anchors.entries()) {
    const above = anchors[i + 1];
    if (above && hPa < below.hPa && hPa > above.hPa) {
      const fraction = Math.log(below.hPa / hPa) / Math.log(below.hPa / above.hPa);
      return Math.round(below.altitudeFt + (above.altitudeFt - below.altitudeFt) * fraction);
    }
  }
  return null;
}

/** What may follow a section's last group without being something unread. A lone `=` has become an empty token. */
const SECTION_END = /^(21212|31313|41414|51515|PPBB|NNNN|)$/;

/**
 * The significant levels, from the same flight as the mandatory ones. A
 * bulletin from any other flight, or a balloon that sent an empty one, gives
 * nothing.
 */
function readSignificant(tokens: readonly Token[], flight: string, station: string, anchors: readonly Anchor[], elevationFt: number, unparsed: string[]): { winds: UpperWindLevel[]; temperatures: TemperatureLevel[] } {
  const startOf = (name: string) => {
    const at = tokens.findIndex((t) => t.text === name);
    return at !== -1 && tokens[at + 1]?.text.startsWith(flight) && tokens[at + 2]?.text === station ? at + 3 : -1;
  };
  const stop = (group: Token) => {
    if (!SECTION_END.test(group.text)) unparsed.push(group.text);
  };

  const temperatures: TemperatureLevel[] = [];
  const ttbb = startOf('TTBB');
  for (let i = ttbb; ttbb !== -1 && i < tokens.length; i += 2) {
    const group = tokens[i]!;
    const reading = tokens[i + 1];
    if (!/^(\d)\1[\d/]{3}$/.test(group.text) || !reading) {
      stop(group);
      break;
    }
    const hPa = pressureOf(group.text.slice(2));
    const altitudeFt = hPa === null ? null : heightAtPressure(anchors, hPa);
    const tempC = temperature(reading.text);
    if (altitudeFt !== null && tempC !== null) temperatures.push({ altitudeFt, tempC, span: { start: group.start, end: reading.end } });
  }

  const winds: UpperWindLevel[] = [];
  const ppbb = startOf('PPBB');
  const knots = Number(flight.slice(0, 2)) > 50;
  let i = ppbb;
  while (ppbb !== -1 && i < tokens.length) {
    const heights = tokens[i]!;
    if (!/^9\d[\d/]{3}$/.test(heights.text)) {
      stop(heights);
      break;
    }
    const first = i === ppbb;
    i++;
    for (const [slot, unit] of [...heights.text.slice(2)].entries()) {
      if (unit === '/') {
        // The surface takes a wind group like any other, and the mandatory part has already given it.
        if (first && slot === 0) i++;
        continue;
      }
      const windGroup = tokens[i++];
      const wind = windOf(windGroup?.text, knots);
      if (!windGroup || !wind) {
        if (windGroup?.text.replaceAll('/', '')) unparsed.push(windGroup.text);
        continue;
      }
      const altitudeFt = (Number(heights.text[1]) * 10 + Number(unit)) * 1000;
      if (altitudeFt > elevationFt) winds.push({ altitudeFt, ...wind, tempC: null, span: { start: heights.start, end: windGroup.end } });
    }
  }
  return { winds, temperatures };
}

/**
 * Decode one station's bulletin. `reference` dates its day-of-month, which
 * carries no month or year: the time the report was stored under.
 *
 * Nothing after the mandatory levels of the first part is read. The
 * tropopause and maximum wind groups and the sections beyond them are far
 * above a light aircraft, and stay in the report for anyone who wants them.
 */
export function decodeTtaa(raw: string, reference: Date | null): DecodedUpperWind {
  const words = [...raw.matchAll(/\S+/g)];
  const tokens: Token[] = words.map((m) => ({ text: m[0].replace(/=$/, ''), start: m.index, end: m.index + m[0].length }));
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
  const measuredTemps: TemperatureLevel[] = [];
  const anchors: Anchor[] = [];
  const unparsed: string[] = [];
  const put = (altitudeFt: number | null, tempGroup: string | undefined, windGroup: string | undefined, span: Span, words: string) => {
    const tempC = temperature(tempGroup);
    if (altitudeFt !== null && tempC !== null) measuredTemps.push({ altitudeFt, tempC, span });
    const wind = windOf(windGroup, knots);
    if (!wind || altitudeFt === null) {
      // All slashes is a level the balloon had nothing for, not something unread.
      if (tempGroup?.replaceAll('/', '') || windGroup?.replaceAll('/', '')) unparsed.push(words);
      return;
    }
    levels.push({ altitudeFt, ...wind, tempC, span });
  };

  // The first part ends at its own `=`, and any significant levels were added after that.
  const ending = words.findIndex((w, n) => n > at && w[0].endsWith('='));
  const end = ending === -1 ? tokens.length : ending + 1;
  let i = at + 3;
  while (i < end) {
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
      const hPa = pressureOf(group.text.slice(2));
      if (elevationFt === null) unparsed.push(words);
      else {
        put(elevationFt, tempGroup, windGroup, span, words);
        if (hPa !== null) anchors.push({ hPa, altitudeFt: elevationFt });
      }
    } else {
      const hhh = group.text.slice(2);
      const altitudeFt = /^\d{3}$/.test(hhh) ? Math.round(heightMetres(indicator, Number(hhh)) * FT_PER_M) : null;
      // A pressure the ground is above reports a height under the station, and nothing was measured there.
      if (altitudeFt === null || elevationFt === null || altitudeFt > elevationFt) {
        put(altitudeFt, tempGroup, windGroup, span, words);
        if (altitudeFt !== null) anchors.push({ hPa: pressure!, altitudeFt });
      }
    }
    i += hasWind ? 3 : 2;
  }
  anchors.sort((a, b) => b.hPa - a.hPa);
  const significant = elevationFt === null ? null : readSignificant(tokens, time.text.slice(0, 4), id.text, anchors, elevationFt, unparsed);
  levels.push(...(significant?.winds ?? []));
  levels.sort((a, b) => a.altitudeFt - b.altitudeFt);
  const temperatures = significant && (significant.winds.length > 0 || significant.temperatures.length > 0) ? [...measuredTemps, ...significant.temperatures].sort((a, b) => a.altitudeFt - b.altitudeFt) : null;

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
    ...(temperatures ? { temperatures } : {}),
    unparsed,
  };
}
