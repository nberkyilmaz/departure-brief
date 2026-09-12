/**
 * ICAO NOTAM decoder (Annex 15 / Doc 8126 format), as issued by NAV CANADA
 * and most of the world outside the US domestic system:
 *
 *   (J5067/26 NOTAMR J2786/26
 *   Q) CZYZ/QMRLC/IV/NBO/A/000/999/4312N07910W005
 *   A) CYSN B) 2607271313 C) 2610261200EST
 *   E) RWY 11/29 CLSD)
 *
 * Fields are found by an order-aware scan — `A)` is only a field marker
 * after `Q)`, `F)` only after `E)`, and so on — so free text that happens to
 * contain a letter and a bracket cannot be mistaken for a field. Total and
 * deterministic; every field keeps its span; anything not understood is
 * kept in `unparsed`.
 */

import { sourced, type Sourced, type Span } from '../decode/span.js';
import type { UnparsedToken } from '../decode/unparsed.js';
import type { DecodedNotam, NotamEnd, NotamId, NotamInstant, NotamType, QLine } from './types.js';

export const NOTAM_DECODER_VERSION = 1;

const FIELD_ORDER = ['Q', 'A', 'B', 'C', 'D', 'E', 'F', 'G'] as const;
type FieldLetter = (typeof FIELD_ORDER)[number];

const ID = /^([A-Z])(\d{4})\/(\d{2})$/;
const Q_LINE = /^([A-Z]{4})\/Q([A-Z]{2})([A-Z]{2})\/([IVK]+)\/([NBOMK]+)\/([AEWK]+)\/(\d{3})\/(\d{3})(?:\/(\d{2})(\d{2})([NS])(\d{3})(\d{2})([EW])(\d{3}))?$/;
const INSTANT = /^(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})(EST)?$/;

interface Field {
  readonly letter: FieldLetter;
  /** Span of the content after `X)`, trimmed. */
  readonly span: Span;
  readonly text: string;
}

function trimSpan(raw: string, start: number, end: number): Span {
  let s = start;
  let e = end;
  while (s < e && /\s/.test(raw[s]!)) s++;
  while (e > s && /\s/.test(raw[e - 1]!)) e--;
  return { start: s, end: e };
}

/**
 * Locate `X)` markers in the order the format prescribes. A marker counts
 * only if it is the next letter in sequence (or a later one — a NOTAM may
 * omit D, F, G) and stands at a token boundary.
 */
function scanFields(raw: string, from: number, to: number): Field[] {
  const fields: Field[] = [];
  let nextIndex = 0;
  const markers: { letter: FieldLetter; at: number; contentStart: number }[] = [];
  const re = /(?:^|\s)([QABCDEFG])\)/g;
  re.lastIndex = from;
  let m: RegExpExecArray | null;
  while ((m = re.exec(raw)) !== null && m.index < to) {
    const letter = m[1] as FieldLetter;
    const idx = FIELD_ORDER.indexOf(letter);
    if (idx < nextIndex) continue; // out of sequence: free text, not a field
    const at = m.index + (m[0].length - 2);
    markers.push({ letter, at, contentStart: at + 2 });
    nextIndex = idx + 1;
    if (letter === 'G') break;
  }
  markers.forEach((mk, i) => {
    const end = i + 1 < markers.length ? markers[i + 1]!.at : to;
    const span = trimSpan(raw, mk.contentStart, end);
    fields.push({ letter: mk.letter, span, text: raw.slice(span.start, span.end) });
  });
  return fields;
}

function decodeId(text: string): NotamId | null {
  const m = ID.exec(text);
  if (!m) return null;
  return { series: m[1]!, number: Number(m[2]), year: Number(m[3]), text };
}

function decodeInstant(text: string): NotamInstant | null {
  const m = INSTANT.exec(text);
  if (!m) return null;
  const year = 2000 + Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  const hour = Number(m[4]);
  const minute = Number(m[5]);
  if (month < 1 || month > 12 || day < 1 || day > 31 || hour > 24 || minute > 59) return null;
  const d = new Date(Date.UTC(year, month - 1, day, hour === 24 ? 0 : hour, minute));
  if (d.getUTCMonth() !== month - 1) return null;
  if (hour === 24) d.setTime(d.getTime() + 86_400_000);
  return { iso: d.toISOString(), estimated: m[6] === 'EST' };
}

function decodeQ(text: string): QLine | null {
  const m = Q_LINE.exec(text.replace(/\s+/g, ''));
  if (!m) return null;
  let centre: QLine['centre'] = null;
  let radiusNm: number | null = null;
  if (m[9] !== undefined) {
    const lat = (Number(m[9]) + Number(m[10]) / 60) * (m[11] === 'S' ? -1 : 1);
    const lon = (Number(m[12]) + Number(m[13]) / 60) * (m[14] === 'W' ? -1 : 1);
    centre = { lat, lon };
    radiusNm = Number(m[15]);
  }
  return {
    fir: m[1]!,
    code: { text: `Q${m[2]}${m[3]}`, subject: m[2]!, condition: m[3]! },
    traffic: m[4]!,
    purpose: m[5]!,
    scope: m[6]!,
    lower: Number(m[7]),
    upper: Number(m[8]),
    centre,
    radiusNm,
  };
}

/** Decode one NOTAM. Never throws; unrecognised parts land in `unparsed`. */
export function decodeNotam(raw: string): DecodedNotam {
  const unparsed: UnparsedToken[] = [];
  const bad = (span: Span, text: string) => unparsed.push({ text, span, section: 'body' });

  // Outer parentheses, when present, are not part of any field.
  let start = 0;
  let end = raw.length;
  while (start < end && /\s/.test(raw[start]!)) start++;
  while (end > start && /\s/.test(raw[end - 1]!)) end--;
  if (raw[start] === '(') start++;
  if (raw[end - 1] === ')' && end > start) end--;

  // Header: `ID NOTAMN` or `ID NOTAMR OLDID`, running to the first field marker.
  const fields = scanFields(raw, start, end);
  const headerEnd = fields.length > 0 ? raw.lastIndexOf(fields[0]!.letter + ')', fields[0]!.span.start) : end;
  const headerSpan = trimSpan(raw, start, headerEnd);
  const headerTokens: { text: string; span: Span }[] = [];
  const tokenRe = /\S+/g;
  tokenRe.lastIndex = headerSpan.start;
  let t: RegExpExecArray | null;
  while ((t = tokenRe.exec(raw)) !== null && t.index < headerSpan.end) {
    headerTokens.push({ text: t[0], span: { start: t.index, end: t.index + t[0].length } });
  }

  let id: Sourced<NotamId> | null = null;
  let type: Sourced<NotamType> | null = null;
  let refers: Sourced<NotamId> | null = null;
  for (const tok of headerTokens) {
    const asId = decodeId(tok.text);
    if (asId && id === null && type === null) {
      id = sourced(asId, tok.span);
    } else if (type === null && (tok.text === 'NOTAMN' || tok.text === 'NOTAMR' || tok.text === 'NOTAMC')) {
      type = sourced(tok.text, tok.span);
    } else if (asId && type !== null && type.value !== 'NOTAMN' && refers === null) {
      refers = sourced(asId, tok.span);
    } else {
      bad(tok.span, tok.text);
    }
  }

  let q: Sourced<QLine> | null = null;
  let locations: Sourced<readonly string[]> | null = null;
  let from: Sourced<NotamInstant> | null = null;
  let to: Sourced<NotamEnd> | null = null;
  let schedule: Sourced<string> | null = null;
  let text: Sourced<string> | null = null;
  let lowerLimit: Sourced<string> | null = null;
  let upperLimit: Sourced<string> | null = null;

  for (const f of fields) {
    if (f.span.start >= f.span.end) {
      bad({ start: f.span.start - 2, end: f.span.start }, `${f.letter})`);
      continue;
    }
    switch (f.letter) {
      case 'Q': {
        const v = decodeQ(f.text);
        if (v) q = sourced(v, f.span);
        else bad(f.span, f.text);
        break;
      }
      case 'A':
        locations = sourced(f.text.split(/\s+/).filter(Boolean), f.span);
        break;
      case 'B': {
        const v = decodeInstant(f.text);
        if (v) from = sourced(v, f.span);
        else bad(f.span, f.text);
        break;
      }
      case 'C': {
        if (f.text === 'PERM') {
          to = sourced({ permanent: true }, f.span);
          break;
        }
        const v = decodeInstant(f.text);
        if (v) to = sourced(v, f.span);
        else bad(f.span, f.text);
        break;
      }
      case 'D':
        schedule = sourced(f.text, f.span);
        break;
      case 'E':
        text = sourced(f.text, f.span);
        break;
      case 'F':
        lowerLimit = sourced(f.text, f.span);
        break;
      case 'G':
        upperLimit = sourced(f.text, f.span);
        break;
    }
  }

  return { raw, id, type, refers, q, locations, from, to, schedule, text, lowerLimit, upperLimit, unparsed };
}
