/**
 * Text a decoder could not read, said rather than skipped.
 *
 * Every report here came off the live feed on 5 November 2026. Kingsville's
 * TAF has a change group whose time lost a digit — `FM52000` — so the
 * group's wind and visibility were never read, and the period before it
 * would have carried on unchallenged. Its last group, `FN20008`, is a
 * forecaster's typo for a temperature, and `-SHA` one for `-SHRA`.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { aerodromeReport } from '../../src/aerodrome/report.js';
import { decodeMetar } from '../../src/decode/metar/index.js';
import { decodeTaf } from '../../src/decode/taf/index.js';
import { CatalogStore, type AirportCell, type AirportIndex } from '../../src/demo/airports.js';
import { parseAircraftLimits, parsePilotProfile } from '../../src/domain/profile.js';
import { checkUnread } from '../../src/rules/unread.js';
import { storeAndDecode } from '../../src/store/decode.js';
import { rawReport } from '../../src/store/types.js';

const FIXTURES = join(__dirname, '..', 'fixtures', 'unread');
const read = (name: string) => readFileSync(join(FIXTURES, name), 'utf8').trim();
const KNTU = read('kntu-taf-2026-11-05.txt');
const KNRB = read('knrb-taf-2026-11-05.txt');
const KTTS = read('ktts-metar-2026-11-05.txt');
const CYSN = read('cysn-taf-2026-11-05.txt');
const AT = new Date('2026-11-05T21:00:00Z');

const taf = (raw: string, station: string) => ({ waypoint: station, at: AT, basis: 'forecast', basisKind: 'forecast' as const, source: { kind: 'taf' as const, station, raw, sha256: null } });

describe('checkUnread', () => {
  it('says which parts of a TAF were not read, each quoted and pointed at', () => {
    const decoded = decodeTaf(KNTU);
    const [f] = checkUnread(taf(decoded.raw, 'KNTU'), decoded.unparsed);
    expect(f!.rule).toBe('report.unread');
    expect(f!.attention).toBe('caution');
    // Tokens side by side are one run of text, as a pilot would read them.
    expect(f!.citations.map((c) => c.text)).toEqual(['FM52000 18009KT 9999', '-SHA', 'FN20008']);
    for (const c of f!.citations) expect(decoded.raw.slice(c.span!.start, c.span!.end)).toBe(c.text);
    expect(f!.summary).toBe('part of the KNTU TAF could not be read, so nothing in it was checked: "FM52000 18009KT 9999", "-SHA", "FN20008". Read it in the report');
  });

  it('says nothing about a report whose weather it read whole, remarks and all', () => {
    // `RMK NXT FCST BY 061400Z` is a note about when the next one is due, and the decoder keeps it unread; it is not weather.
    const cysn = decodeTaf(CYSN);
    expect(cysn.unparsed.map((u) => u.section)).toEqual(['remarks', 'remarks', 'remarks', 'remarks']);
    expect(checkUnread(taf(cysn.raw, 'CYSN'), cysn.unparsed)).toEqual([]);
  });

  it('reads a METAR the same way', () => {
    const metar = decodeMetar(KTTS);
    const [f] = checkUnread({ ...taf(KTTS, 'KTTS'), basis: 'observed 1955Z', basisKind: 'observed', source: { kind: 'metar', station: 'KTTS', raw: KTTS, sha256: null } }, metar.unparsed);
    // The stray `M` after the temperature group.
    expect(f!.citations.map((c) => c.text)).toEqual(['M']);
    expect(f!.summary).toContain('KTTS METAR');
  });

  it('quotes a stray group at the end of a TAF as it stands', () => {
    const decoded = decodeTaf(KNRB);
    const [f] = checkUnread(taf(decoded.raw, 'KNRB'), decoded.unparsed);
    expect(f!.citations.map((c) => c.text)).toEqual(['FN21025']);
  });
});

describe('on the aerodrome page and in a briefing', () => {
  it("puts the unread part of Kingsville's TAF among its findings", async () => {
    const DEMO = join(__dirname, '..', '..', '..', '..', 'apps', 'web', 'public', 'demo');
    const json = <T,>(name: string): T => JSON.parse(readFileSync(join(DEMO, name), 'utf8')) as T;
    const store = new CatalogStore(json<AirportIndex>('airports/index.json'), async (cell) => json<AirportCell>(`airports/${cell}.json`));
    const report = rawReport({ kind: 'taf', source: 'awc', station: 'KNTU', body: KNTU, issuedAt: new Date('2026-11-05T15:00:00Z'), upstream: null });
    await storeAndDecode(store, [report], 'recorded', AT);
    const root = join(__dirname, '..', '..', '..', '..');
    const profile = parsePilotProfile(JSON.parse(readFileSync(join(root, 'profiles', 'default.json'), 'utf8')));
    const aircraft = parseAircraftLimits(JSON.parse(readFileSync(join(root, 'aircraft', 'c172.json'), 'utf8')));
    const field = (await aerodromeReport(store, 'KNTU', AT, profile, aircraft))!;
    const unread = field.findings.filter((f) => f.rule === 'report.unread');
    expect(unread).toHaveLength(1);
    expect(unread[0]!.citations[0]!.sha256).toBe(report.sha256);
  });
});
