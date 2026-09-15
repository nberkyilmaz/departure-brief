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
import { areaIsTestable } from '../../src/domain/polygon.js';
import { checkHazards, NEAR_HAZARD_NM, type HazardAdvisory } from '../../src/rules/hazards.js';
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
