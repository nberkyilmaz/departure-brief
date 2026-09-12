/**
 * ICAO NOTAM decoding against the NAV CANADA corpus recorded 2026-09-12
 * (test/fixtures/notam/navcanada). Hand-decoded cases plus invariants
 * over every NOTAM in the fixtures.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { decodeNotam } from '../../src/notam/decode.js';
import { at } from '../helpers/span.js';

const dir = join(__dirname, '..', 'fixtures', 'notam', 'navcanada', '2026-09-12');
const corpus: string[] = readdirSync(dir)
  .filter((f) => f.endsWith('.json'))
  .flatMap((f) => (JSON.parse(readFileSync(join(dir, f), 'utf8')) as { data: { text: string }[] }).data)
  .map((item) => (JSON.parse(item.text) as { raw: string }).raw);

const byId = (id: string) => corpus.find((r) => r.startsWith(`(${id} `))!;

describe('decodeNotam — corpus cases', () => {
  it('a runway closure replacing an earlier NOTAM', () => {
    const raw = byId('J5067/26');
    const n = decodeNotam(raw);
    // The id follows the opening parenthesis, so it is not whitespace-bounded; locate it directly.
    expect(n.id).toEqual({ value: { series: 'J', number: 5067, year: 26, text: 'J5067/26' }, span: { start: 1, end: 9 } });
    expect(raw.slice(1, 9)).toBe('J5067/26');
    expect(n.type).toEqual({ value: 'NOTAMR', span: at(raw, 'NOTAMR') });
    expect(n.refers?.value.text).toBe('J2786/26');
    expect(n.q?.value).toEqual({
      fir: 'CZYZ',
      code: { text: 'QMRLC', subject: 'MR', condition: 'LC' },
      traffic: 'IV',
      purpose: 'NBO',
      scope: 'A',
      lower: 0,
      upper: 999,
      centre: { lat: 43.2, lon: -79 - 10 / 60 },
      radiusNm: 5,
    });
    expect(raw.slice(n.q!.span.start, n.q!.span.end)).toBe('CZYZ/QMRLC/IV/NBO/A/000/999/4312N07910W005');
    expect(n.locations).toEqual({ value: ['CYSN'], span: at(raw, 'CYSN') });
    expect(n.from?.value).toEqual({ iso: '2026-07-27T13:13:00.000Z', estimated: false });
    expect(n.to?.value).toEqual({ iso: '2026-10-26T12:00:00.000Z', estimated: true });
    expect(n.schedule).toBeNull();
    expect(n.text?.value).toBe('RWY 11/29 CLSD');
    expect(raw.slice(n.text!.span.start, n.text!.span.end)).toBe('RWY 11/29 CLSD');
    expect(n.unparsed).toEqual([]);
  });

  it('a FIR-wide GPS interference NOTAM with a schedule and a large radius', () => {
    const raw = byId('G3263/26');
    const n = decodeNotam(raw);
    expect(n.type?.value).toBe('NOTAMN');
    expect(n.refers).toBeNull();
    expect(n.q?.value.fir).toBe('CZXX');
    expect(n.q?.value.code).toEqual({ text: 'QGWAU', subject: 'GW', condition: 'AU' });
    expect(n.q?.value.scope).toBe('E');
    expect(n.q?.value.radiusNm).toBe(294);
    expect(n.locations?.value).toEqual(['CZWG', 'CZYZ']);
    expect(n.from?.value.iso).toBe('2026-09-14T04:00:00.000Z');
    expect(n.to?.value).toEqual({ iso: '2026-09-18T10:59:00.000Z', estimated: false });
    expect(n.schedule?.value).toBe('DAILY 0400-1059');
    expect(n.text?.value.startsWith('GPS INTERFERENCE EXER')).toBe(true);
    expect(n.text?.value).toContain('INFORM ATC OF ANY\nADVERSE IMPACT.');
    expect(n.unparsed).toEqual([]);
  });

  it('an obstacle NOTAM with scope AE and an upper level', () => {
    const raw = byId('J5068/26');
    const n = decodeNotam(raw);
    expect(n.q?.value.code.text).toBe('QOBCE');
    expect(n.q?.value.scope).toBe('AE');
    expect(n.q?.value.purpose).toBe('M');
    expect(n.q?.value.upper).toBe(6);
    expect(n.text?.value).toContain('MULTIPLE CRANES');
  });

  it('a multi-day schedule and a displaced threshold', () => {
    const raw = byId('J6230/26');
    const n = decodeNotam(raw);
    expect(n.schedule?.value.replace(/\s+/g, ' ')).toBe('SEP 11 14 1100-2100, SEP 15 1000-1800, SEP 16 1100-2100, SEP 17 1030-2100');
    expect(n.text?.value.startsWith('THR 26 DISPLACED BY 1000FT')).toBe(true);
    expect(n.to?.value).toEqual({ iso: '2026-09-17T21:00:00.000Z', estimated: false });
  });

  it('IFR-only traffic: an ILS unserviceable', () => {
    const n = decodeNotam(byId('J6015/26'));
    expect(n.q?.value.traffic).toBe('I');
    expect(n.q?.value.code.text).toBe('QICAS');
    expect(n.text?.value).toBe('ILS RWY 26 U/S');
  });

  it('a heliport crane NOTAM whose A) is CXXX and whose text names the site', () => {
    const n = decodeNotam(byId('J4064/26'));
    expect(n.locations?.value).toEqual(['CXXX']);
    expect(n.text?.value).toContain('CPJ3 HAMILTON');
  });
});

describe('decodeNotam — structure', () => {
  it('PERM end, F) and G) limits, no outer parentheses', () => {
    const raw = 'A0001/26 NOTAMN Q) CZYZ/QOBCE/IV/M/AE/000/010/4312N07910W005 A) CYSN B) 2609121200 C) PERM E) CRANE 300FT AGL F) SFC G) 1000FT AMSL';
    const n = decodeNotam(raw);
    expect(n.to?.value).toEqual({ permanent: true });
    expect(n.lowerLimit?.value).toBe('SFC');
    expect(n.upperLimit?.value).toBe('1000FT AMSL');
    expect(n.text?.value).toBe('CRANE 300FT AGL');
    expect(n.unparsed).toEqual([]);
  });

  it('does not mistake a bracketed letter inside E) for a field', () => {
    const raw = '(A0002/26 NOTAMN Q) CZYZ/QFAXX/IV/NBO/A/000/999/4312N07910W005 A) CYSN B) 2609121200 C) 2609131200 E) SEE ITEM A) OF THE CFS. B) IS NOT A FIELD HERE)';
    const n = decodeNotam(raw);
    expect(n.text?.value).toBe('SEE ITEM A) OF THE CFS. B) IS NOT A FIELD HERE');
    expect(n.locations?.value).toEqual(['CYSN']);
    expect(n.unparsed).toEqual([]);
  });

  it('a cancelling NOTAM refers to the cancelled one', () => {
    const n = decodeNotam('(A0003/26 NOTAMC A0002/26 Q) CZYZ/QFAXX/IV/NBO/A/000/999/4312N07910W005 A) CYSN B) 2609121300 E) CANCELLED)');
    expect(n.type?.value).toBe('NOTAMC');
    expect(n.refers?.value.text).toBe('A0002/26');
    expect(n.to).toBeNull();
  });

  it('a Q line without coordinates still decodes', () => {
    const n = decodeNotam('(A0004/26 NOTAMN Q) CZYZ/QFAXX/IV/NBO/A/000/999 A) CYSN B) 2609121300 C) 2609131300 E) X)');
    expect(n.q?.value.centre).toBeNull();
    expect(n.q?.value.radiusNm).toBeNull();
  });

  it('keeps malformed pieces as unparsed and never throws', () => {
    const raw = '(ZZZZ NOTAMN Q) BAD/QQQ A) CYSN B) 26091 E) TEXT)';
    const n = decodeNotam(raw);
    expect(n.id).toBeNull();
    expect(n.q).toBeNull();
    expect(n.from).toBeNull();
    expect(n.unparsed.map((u) => u.text)).toEqual(['ZZZZ', 'BAD/QQQ', '26091']);
    for (const raw2 of ['', '()', 'E)', 'Q)', 'hello', '(A0001/26', ')(']) expect(() => decodeNotam(raw2)).not.toThrow();
  });

  it('is deterministic and JSON round-trippable', () => {
    for (const raw of corpus.slice(0, 5)) {
      expect(decodeNotam(raw)).toEqual(decodeNotam(raw));
      expect(JSON.parse(JSON.stringify(decodeNotam(raw)))).toEqual(decodeNotam(raw));
    }
  });
});

describe('decodeNotam — corpus invariants', () => {
  it('every record in the corpus has an id, type, Q line, locations, start, and text, with nothing unparsed', () => {
    expect(corpus.length).toBeGreaterThan(30);
    const failures: string[] = [];
    for (const raw of corpus) {
      const n = decodeNotam(raw);
      if (!n.id || !n.type || !n.q || !n.locations || !n.from || !n.text) failures.push(`missing field: ${raw.slice(0, 60)}`);
      if (n.unparsed.length > 0) failures.push(`unparsed ${JSON.stringify(n.unparsed.map((u) => u.text))}: ${raw.slice(0, 60)}`);
      for (const s of [n.id, n.type, n.refers, n.q, n.locations, n.from, n.to, n.schedule, n.text]) {
        if (s && (s.span.start < 0 || s.span.end > raw.length || s.span.start >= s.span.end)) failures.push(`bad span: ${raw.slice(0, 60)}`);
      }
      if (n.text && raw.slice(n.text.span.start, n.text.span.end) !== n.text.value) failures.push(`text span mismatch: ${raw.slice(0, 60)}`);
    }
    expect(failures).toEqual([]);
  });

  it('the corpus holds the expected distinct NOTAMs (FIR-wide ones repeat per site)', () => {
    const ids = new Set(corpus.map((r) => decodeNotam(r).id?.value.text));
    expect(ids.size).toBeLessThan(corpus.length);
    expect(ids.size).toBeGreaterThan(25);
  });
});
