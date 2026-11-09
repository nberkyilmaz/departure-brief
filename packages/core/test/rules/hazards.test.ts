/**
 * Whether a hazard advisory is about this flight, over the real advisories
 * the service was carrying on 14 September 2026.
 *
 * The routes here are built from the advisories' own corners, so "through
 * it" and "nowhere near it" are facts about the published geometry rather
 * than about a shape invented to make the test pass.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { decodeSigmet } from '../../src/decode/sigmet/decode.js';
import type { LatLon } from '../../src/domain/geo.js';
import { areaIsTestable, routeDistanceToAreaNm } from '../../src/domain/polygon.js';
import { parseGairmetCache } from '../../src/fetch/awcCache.js';
import { hazardsKnownBy } from '../../src/resolve/hazards.js';
import { checkHazards, NEAR_HAZARD_NM, type HazardAdvisory } from '../../src/rules/hazards.js';
import { storeAndDecode } from '../../src/store/decode.js';
import { MemoryStore } from '../../src/store/memory.js';
import { rawReport } from '../../src/store/types.js';

const DIR = join(__dirname, '..', 'fixtures', 'fetch', 'awc', 'sigmet-2026-09-14');

function advisories(name: string): HazardAdvisory[] {
  const records = JSON.parse(readFileSync(join(DIR, `${name}.json`), 'utf8')) as unknown[];
  return records.map((r) => {
    const body = JSON.stringify(r);
    return {
      report: rawReport({ kind: 'sigmet', source: 'awc', station: null, body, issuedAt: null, upstream: r }),
      decoded: decodeSigmet(body),
    };
  });
}

const ALL = [...advisories('isigmet'), ...advisories('airsigmet')];

/** One with geometry this can test, a known altitude band and a hazard. */
const sample = ALL.find((a) => areaIsTestable(a.decoded.area) === null && a.decoded.validFrom && a.decoded.topFt !== null && a.decoded.hazard)!;

/** A route straight across it, from one of its own corners to another. */
const through: LatLon[] = [sample.decoded.area[0]!, sample.decoded.area[Math.floor(sample.decoded.area.length / 2)]!];
/** The same shape, a long way away. */
const elsewhere: LatLon[] = through.map((p) => ({ lat: -p.lat, lon: p.lon > 0 ? p.lon - 120 : p.lon + 120 }));

const inside = { from: sample.decoded.validFrom!, to: sample.decoded.validTo ?? new Date(sample.decoded.validFrom!.getTime() + 3_600_000) };
const altitude = Math.max(sample.decoded.baseFt ?? 0, 1000);

const ctx = (route: LatLon[], over = {}) => ({
  waypoint: 'CYSN',
  at: inside.from,
  route,
  window: inside,
  leg: inside,
  cruiseAltitudeFt: altitude,
  ...over,
});

describe('checkHazards', () => {
  it('reports one the route goes through, cited to the bulletin', () => {
    const findings = checkHazards(ctx(through), [sample]);
    expect(findings).toHaveLength(1);
    const f = findings[0]!;
    expect(f.rule).toBe('hazard.onRoute');
    // A SIGMET is a warning to everything in the air.
    expect(f.attention).toBe(sample.decoded.kind === 'airmet' ? 'caution' : 'alert');
    expect(f.summary).toContain('your route goes through it');
    expect(f.citations[0]!.raw).toBe(sample.report.body);
    expect(f.citations[0]!.text).toBe(sample.decoded.bulletin!.value);
  });

  it('says nothing about one somewhere else entirely', () => {
    expect(checkHazards(ctx(elsewhere), [sample])).toEqual([]);
  });

  it('says nothing about one that has expired, or not started', () => {
    const after = { from: new Date(inside.to.getTime() + 86_400_000), to: new Date(inside.to.getTime() + 90_000_000) };
    expect(checkHazards(ctx(through, { window: after }), [sample])).toEqual([]);
    const before = { from: new Date(inside.from.getTime() - 90_000_000), to: new Date(inside.from.getTime() - 86_400_000) };
    expect(checkHazards(ctx(through, { window: before }), [sample])).toEqual([]);
  });

  it('says nothing about one that sits above the aircraft', () => {
    const high = ALL.find((a) => (a.decoded.baseFt ?? 0) > 10000 && areaIsTestable(a.decoded.area) === null);
    if (!high) return;
    const route = [high.decoded.area[0]!, high.decoded.area[1]!];
    const window = { from: high.decoded.validFrom!, to: high.decoded.validTo! };
    // A Cessna at 3,500 ft is not in a band that starts in the flight levels.
    expect(checkHazards(ctx(route, { window, cruiseAltitudeFt: 3500 }), [high])).toEqual([]);
    // The same advisory does concern something flying in it.
    expect(checkHazards(ctx(route, { window, cruiseAltitudeFt: high.decoded.baseFt! + 1000 }), [high])).toHaveLength(1);
  });

  it('reports an area whose geometry it cannot answer for, rather than dropping it', () => {
    const untestable = ALL.find((a) => areaIsTestable(a.decoded.area) !== null && a.decoded.validFrom);
    if (!untestable) return;
    const window = { from: untestable.decoded.validFrom!, to: untestable.decoded.validTo! };
    const findings = checkHazards(ctx(through, { window, cruiseAltitudeFt: untestable.decoded.baseFt ?? 3500 }), [untestable]);
    expect(findings).toHaveLength(1);
    expect(findings[0]!.rule).toBe('hazard.untestable');
    expect(findings[0]!.summary).toContain('checked by eye');
  });

  it('mentions one the route passes close to, without calling it a violation', () => {
    // Every advisory, against a route through the first one: whatever else
    // is nearby is advisory, and only what is crossed is a violation.
    const findings = checkHazards(ctx(through), ALL);
    for (const f of findings) {
      if (f.rule === 'hazard.near') {
        expect(f.attention).toBe('note');
        expect(Number(f.values['distanceNm'])).toBeLessThanOrEqual(NEAR_HAZARD_NM);
      }
    }
    expect(findings.some((f) => f.rule === 'hazard.onRoute')).toBe(true);
  });
});

/** The AWC's G-AIRMET file of 04:53Z on 9 November 2026, and Albany to Pittsburgh underneath it. */
describe('checkHazards on G-AIRMETs', () => {
  const xml = readFileSync(join(__dirname, '..', 'fixtures', 'fetch', 'northeast-2026-11-09', 'gairmets.cache.xml'), 'utf8');
  const pictures: HazardAdvisory[] = parseGairmetCache(xml, 'recorded').map((report) => ({ report, decoded: decodeSigmet(report.body) }));
  const ALBANY = { lat: 42.748, lon: -73.802 };
  const PITTSBURGH = { lat: 40.492, lon: -80.233 };
  const z = (hhmm: string) => new Date(`2026-11-09T${hhmm}:00Z`);
  const flying = (from: string, to: string, over = {}) => ({
    waypoint: 'KPIT',
    at: z(to),
    route: [ALBANY, PITTSBURGH],
    window: { from: z('05:30'), to: z('08:20') },
    leg: { from: z(from), to: z(to) },
    cruiseAltitudeFt: 6500,
    ...over,
  });
  const about = (series: string, findings: ReturnType<typeof checkHazards>) => findings.filter((f) => f.summary.startsWith(`AIRMET ${series}:`));

  it('says one hazard once, however many of its pictures the leg touches', () => {
    expect(pictures.filter((p) => p.decoded.series === 'TANGO 3W' && p.decoded.hazard === 'turbulence').length).toBeGreaterThan(1);
    const found = about('TANGO 3W', checkHazards(flying('05:30', '08:20'), pictures));
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ rule: 'hazard.onRoute', attention: 'caution', summary: 'AIRMET TANGO 3W: mod turbulence between 0 and 8,000 ft — your route goes through it' });
  });

  it('keeps what is above the cruise out of it', () => {
    expect(about('TANGO 4W', checkHazards(flying('05:30', '08:20'), pictures))).toEqual([]);
  });

  it('goes by the hours the leg is flown, not the whole flight', () => {
    const picturesCited = (from: string, to: string) => about('ZULU 4C', checkHazards(flying(from, to), pictures)).map((f) => /<valid_time>[^T]+T(\d\d)/.exec(f.citations[0]!.raw!)![1]);
    expect(picturesCited('05:30', '07:00')).toEqual(['06']);
    // The moment between two pictures belongs to the later one.
    expect(picturesCited('07:30', '08:20')).toEqual(['09']);
  });

  it('counts on-route over near, when one picture has the route inside it and another only beside it', () => {
    const grouped = new Map<string, HazardAdvisory[]>();
    for (const p of pictures) grouped.set(`${p.decoded.series}|${p.decoded.hazard}`, [...(grouped.get(`${p.decoded.series}|${p.decoded.hazard}`) ?? []), p]);
    const pair = [...grouped.values()].flatMap((group) =>
      group.flatMap((inside) =>
        group.flatMap((outside) => inside.decoded.area.filter((corner) => {
          const away = routeDistanceToAreaNm([corner], outside.decoded.area);
          return away > 1 && away <= NEAR_HAZARD_NM;
        }).map((corner) => ({ inside, outside, corner }))),
      ),
    )[0]!;
    const at = { from: new Date(pair.outside.decoded.validFrom!), to: new Date(pair.inside.decoded.validTo!) };
    const ctx = { waypoint: 'X', at: at.from, route: [pair.corner], window: at, leg: { from: new Date(Math.min(at.from.getTime(), pair.inside.decoded.validFrom!.getTime())), to: new Date(Math.max(at.to.getTime(), pair.outside.decoded.validTo!.getTime()) - 1) }, cruiseAltitudeFt: pair.inside.decoded.baseFt ?? 0 };
    const earlierFirst = checkHazards(ctx, [pair.outside, pair.inside]);
    const laterFirst = checkHazards(ctx, [pair.inside, pair.outside]);
    for (const found of [earlierFirst, laterFirst]) {
      expect(found.map((f) => f.rule)).toEqual(['hazard.onRoute']);
    }
  });
});

describe('hazardsKnownBy on G-AIRMETs', () => {
  const xml = readFileSync(join(__dirname, '..', 'fixtures', 'fetch', 'northeast-2026-11-09', 'gairmets.cache.xml'), 'utf8');
  const AT = new Date('2026-11-09T05:00:00Z');

  it('lets only the latest issue of a product speak', async () => {
    const store = new MemoryStore();
    const sierra = parseGairmetCache(xml, 'recorded').filter((r) => r.body.includes('<product>SIERRA</product>'));
    // The same products as issued, one of them filed as the issue before this one.
    const superseded = rawReport({ ...sierra[0]!, issuedAt: new Date(sierra[0]!.issuedAt!.getTime() - 6 * 3_600_000) });
    const current = sierra.slice(1, 3);
    await storeAndDecode(store, [superseded, ...current], 'recorded', AT, 'WORLD');
    const known = await hazardsKnownBy(store, AT, new Date('2026-11-09T09:00:00Z'));
    expect(known.map((h) => h.report.sha256).sort()).toEqual(current.map((r) => r.sha256).sort());
  });
});
