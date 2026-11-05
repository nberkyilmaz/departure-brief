/**
 * Upper winds as the United States issues them: the FB bulletin.
 *
 * NAV CANADA serves its upper winds already turned into numbers. The US
 * bulletin is still the teletype product it has always been — a header
 * giving the times, a row of altitudes, and a line per site of coded
 * groups in fixed columns:
 *
 *   FBUS31 KWNO 030801
 *   FD1US1
 *   DATA BASED ON 030600Z
 *   VALID 031200Z   FOR USE 0800-1500Z. TEMPS NEG ABV 24000
 *
 *   FT  3000    6000    9000   12000   18000   24000  30000  34000  39000
 *   ABQ              3619+01 3319-02 3256-07 3160-19 317936 810245 801055
 *
 * The columns matter. A level within 1,500 ft of the ground is left blank,
 * so a high site's line starts further right, and reading the groups in
 * order would put Albuquerque's 9,000 ft wind at 3,000. Each group is
 * placed under the altitude it is aligned with instead.
 *
 * A group is `DDSS`, `DDSS±TT`, or above the sign threshold `DDSSTT` with
 * the temperature negative. `DD` is tens of degrees true; 100 knots and more
 * are sent by adding 50 to it, and `9900` is light and variable.
 */
import { resolveDayTime, resolveNearestDayTime, type DayTime } from '../../domain/time.js';
import { sourced, type Sourced, type Span } from '../span.js';
import type { DecodedUpperWind, UpperWindLevel } from './types.js';

/** One site's part of a bulletin: every header line, the altitude row, and its own line. */
export interface FbExcerpt {
  /** The site as the bulletin names it: three letters, the FAA identifier. */
  readonly id: string;
  /** The issue time from the header, as `DDHHMM`, for the fetcher to date. */
  readonly issued: DayTime | null;
  readonly body: string;
}

const HEADER = /\b(FB[A-Z]{2}\d{2})\s+([A-Z]{4})\s+(\d{2})(\d{2})(\d{2})\b/;
const ALTITUDES = /^FT\s/;
const SITE = /^([A-Z0-9]{3})(?=\s|$)/;

/**
 * Cut a bulletin into one excerpt per site. Each excerpt is lines of the
 * bulletin as sent, so it is a report in its own right: it can be stored,
 * hashed and decoded without the rest of the bulletin, and every span in it
 * points at text the service sent. The only thing taken out is control
 * characters — the carriage returns, and the record separator the wire puts
 * at the start of most lines — which a page cannot show and which carry no
 * weather.
 */
export function splitFbBulletin(text: string): FbExcerpt[] {
  const lines = text.replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '').split('\n');
  const ft = lines.findIndex((l) => ALTITUDES.test(l));
  if (ft === -1) return [];
  const first = lines.findIndex((l) => l.trim() !== '');
  const header = lines.slice(first, ft + 1).join('\n');
  const m = HEADER.exec(header);
  const issued = m ? { day: Number(m[3]), hour: Number(m[4]), minute: Number(m[5]) } : null;
  const out: FbExcerpt[] = [];
  for (const line of lines.slice(ft + 1)) {
    const site = SITE.exec(line);
    if (!site) continue;
    out.push({ id: site[1]!, issued, body: `${header}\n${line}` });
  }
  return out;
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

const span = (start: number, text: string): Span => ({ start, end: start + text.length });
const dayTime = (d: string, h: string, m: string): DayTime => ({ day: Number(d), hour: Number(h), minute: Number(m) });

/** The instant at `hhmm` nearest `from` going one way: the start of a use window before its valid time, the end after it. */
function clockTime(hhmm: string, from: Date, direction: 'before' | 'after'): Date {
  const hour = Number(hhmm.slice(0, 2));
  const minute = Number(hhmm.slice(2, 4));
  const at = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate(), hour % 24, minute));
  if (hour === 24) at.setTime(at.getTime() + 86_400_000);
  if (direction === 'before' && at.getTime() > from.getTime()) at.setTime(at.getTime() - 86_400_000);
  if (direction === 'after' && at.getTime() < from.getTime()) at.setTime(at.getTime() + 86_400_000);
  return at;
}

/**
 * One coded group. `null` for anything that is not a group this bulletin
 * can send — it is then left in `unparsed` rather than read as something.
 */
function decodeGroup(group: string, altitudeFt: number, negativeAbove: number): Omit<UpperWindLevel, 'span'> | null {
  const signed = /^(\d{2})(\d{2})([+-]\d{2})?$/.exec(group);
  const unsigned = /^(\d{2})(\d{2})(\d{2})$/.exec(group);
  let dd: number;
  let ss: number;
  let tempC: number | null;
  if (signed) {
    dd = Number(signed[1]);
    ss = Number(signed[2]);
    tempC = signed[3] === undefined ? null : Number(signed[3]);
  } else if (unsigned && altitudeFt > negativeAbove) {
    dd = Number(unsigned[1]);
    ss = Number(unsigned[2]);
    tempC = -Number(unsigned[3]);
  } else return null;

  if (dd === 99 && ss === 0) return { altitudeFt, directionTrue: null, speedKt: 0, tempC };
  if (dd >= 1 && dd <= 36) return { altitudeFt, directionTrue: dd * 10, speedKt: ss, tempC };
  if (dd >= 51 && dd <= 86) return { altitudeFt, directionTrue: (dd - 50) * 10, speedKt: ss + 100, tempC };
  return null;
}

/**
 * Decode one site's excerpt. `reference` dates the header's day-of-month
 * times, which carry no month or year: the issue time, or failing that the
 * moment the bulletin was fetched.
 */
export function decodeFbWinds(raw: string, reference: Date | null): DecodedUpperWind {
  const lines = raw.split('\n');
  const ftIndex = lines.findIndex((l) => ALTITUDES.test(l));
  if (ftIndex === -1 || ftIndex === lines.length - 1 || reference === null) return empty(raw);
  const offsetOf = (index: number) => lines.slice(0, index).reduce((sum, l) => sum + l.length + 1, 0);

  const unparsed: string[] = [];
  const header = lines.slice(0, ftIndex).join('\n');

  const h = HEADER.exec(header);
  const issuedDt = h ? resolveDayTime(dayTime(h[3]!, h[4]!, h[5]!), reference) : null;
  const issuedAt = h && issuedDt ? sourced(issuedDt, span(h.index + h[0].lastIndexOf(`${h[3]}${h[4]}${h[5]}`), `${h[3]}${h[4]}${h[5]}`)) : null;
  const bulletin = h ? sourced(h[1]!, span(h.index, h[1]!)) : null;
  const issuer = h ? sourced(h[2]!, span(h.index + h[0].indexOf(h[2]!, h[1]!.length), h[2]!)) : null;
  const anchor = issuedAt?.value ?? reference;

  const based = /DATA BASED ON (\d{2})(\d{2})(\d{2})Z/.exec(header);
  const basedDt = based ? resolveDayTime(dayTime(based[1]!, based[2]!, based[3]!), anchor) : null;
  const basedOn = based && basedDt ? sourced(basedDt, span(based.index, based[0])) : null;

  const valid = /VALID (\d{2})(\d{2})(\d{2})Z/.exec(header);
  const validDt = valid ? resolveNearestDayTime(dayTime(valid[1]!, valid[2]!, valid[3]!), anchor) : null;
  const validAt = valid && validDt ? sourced(validDt, span(valid.index, valid[0])) : null;

  const use = /FOR USE (\d{4})-(\d{4})Z/.exec(header);
  let useFrom: Sourced<Date> | null = null;
  let useTo: Sourced<Date> | null = null;
  if (use && validDt) {
    const fromText = use[1]!;
    const toText = use[2]!;
    useFrom = sourced(clockTime(fromText, validDt, 'before'), span(use.index + 'FOR USE '.length, fromText));
    useTo = sourced(clockTime(toText, validDt, 'after'), span(use.index + 'FOR USE '.length + fromText.length + 1, toText));
  }
  // Temperatures above this altitude are negative and sent without a sign.
  const negative = /TEMPS NEG ABV (\d+)/.exec(header);
  const negativeAbove = negative ? Number(negative[1]) : 24_000;

  /*
   * Each altitude owns the slot from the end of the label before it to the
   * end of its own. A group starts at the left of its slot — a short one,
   * with no temperature, stops short of the label — so a group belongs to
   * the slot it starts in, and must not run past it.
   */
  const ftLine = lines[ftIndex]!;
  const labels = [...ftLine.matchAll(/\d+/g)];
  const columns = labels.map((m, i) => ({
    altitudeFt: Number(m[0]),
    start: i === 0 ? 0 : labels[i - 1]!.index + labels[i - 1]![0].length,
    end: m.index + m[0].length,
  }));

  const siteLine = lines[ftIndex + 1]!;
  const siteStart = offsetOf(ftIndex + 1);
  const site = SITE.exec(siteLine);
  const levels: UpperWindLevel[] = [];
  const taken = new Set<number>();
  for (const g of siteLine.matchAll(/\S+/g)) {
    if (site && g.index === 0) continue;
    const end = g.index + g[0].length;
    const slot = columns.findIndex((c) => g.index >= c.start && g.index < c.end);
    if (slot === -1 || end > columns[slot]!.end || taken.has(slot)) {
      unparsed.push(g[0]);
      continue;
    }
    const column = columns[slot]!;
    const level = decodeGroup(g[0], column.altitudeFt, negativeAbove);
    if (!level) {
      unparsed.push(g[0]);
      continue;
    }
    taken.add(slot);
    levels.push({ ...level, span: span(siteStart + g.index, g[0]) });
  }
  levels.sort((a, b) => a.altitudeFt - b.altitudeFt);

  return { bulletin, issuer, issuedAt, basedOn, validAt, useFrom, useTo, levels, unparsed };
}
