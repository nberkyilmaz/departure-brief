/**
 * Whether a SIGMET on the route could be in force while you are inside it,
 * over the two severe mountain wave SIGMETs NAV CANADA had out for the
 * Rockies on the evening of 8 November 2026: D8, 23:15Z to 03:15Z up to
 * 22,000 ft, and D1, 00:20Z to 04:20Z up to 14,000 ft.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { routePicture } from '../../src/brief/picture.js';
import { parseFlightPlan } from '../../src/domain/flight.js';
import { parseAircraftLimits, parsePilotProfile } from '../../src/domain/profile.js';
import { AwcCacheClient } from '../../src/fetch/awcCache.js';
import { AwcClient } from '../../src/fetch/awc.js';
import { readOurAirportsDirectory } from '../../src/fetch/ourairports.js';
import type { HttpClient } from '../../src/fetch/response.js';
import { resolveFlight } from '../../src/resolve/flight.js';
import { evaluateFlight } from '../../src/rules/evaluate.js';
import { storeAndDecode } from '../../src/store/decode.js';
import { MemoryStore } from '../../src/store/memory.js';

const FETCH = join(__dirname, '..', 'fixtures', 'fetch');
const SNAPSHOT = join(FETCH, 'rockies-2026-11-08');
const RECORDED = new Date('2026-11-09T01:26:00Z');
const profile = parsePilotProfile({ version: 1, name: 'default', ceilingAglFt: 2500, visibilitySm: 5, crosswindKt: 15, crosswindIncludesGust: true });
const c172 = parseAircraftLimits({ type: 'C172', demonstratedCrosswindKt: 15 });
const http: HttpClient = {
  get: async (url) => ({ status: 200, body: readFileSync(join(SNAPSHOT, url.includes('metars') ? 'metars.cache.csv' : url.includes('tafs') ? 'tafs.cache.xml' : 'isigmet.json'), 'utf8'), headers: {} }),
};

let store: MemoryStore;
beforeAll(async () => {
  store = new MemoryStore();
  await store.putAirports(readOurAirportsDirectory(join(FETCH, 'canada-2026-09-18', 'ourairports'), { snapshot: '2026-09-18' }).filter((a) => a.siteType === 'A'));
  const cache = new AwcCacheClient(http, 'https://relay.example/awc/cache');
  for (const batch of [await cache.metars(), await cache.tafs()]) await storeAndDecode(store, batch.reports, batch.request, RECORDED);
  const hazards = await new AwcClient(http, 'https://relay.example/awc').sigmets();
  await storeAndDecode(store, hazards.reports, hazards.request, RECORDED, 'WORLD');
});

const resolved = (departure: string, destination: string, departureTime: string) =>
  resolveFlight(store, parseFlightPlan({ departure, destination, alternate: null, route: [], departureTime, cruise: { tas: 110, altitude: 11500 }, airspace: null }), RECORDED);

async function sigmet(departure: string, destination: string, departureTime: string, series: string) {
  const briefing = evaluateFlight(await resolved(departure, destination, departureTime), profile, c172);
  return briefing.points.flatMap((p) => p.findings.filter((f) => f.summary.startsWith(`SIGMET ${series} (CZEG)`)).map((f) => ({ at: p.waypoint, rule: f.rule, attention: f.attention, summary: f.summary })));
}

describe('a SIGMET on the route, against when you would be inside it', () => {
  // Vancouver to Calgary at 110 kt, which gets to them in the last hour of the flight.
  it.each([
    ['03:00', 'D1', 'note'],
    ['03:00', 'D8', 'note'],
    ['02:00', 'D1', 'alert'],
    ['02:00', 'D8', 'note'],
    ['01:30', 'D1', 'alert'],
    ['01:30', 'D8', 'alert'],
  ])('leaving Vancouver at %sZ, %s is a %s', async (leaving, series, attention) => {
    const found = await sigmet('CYVR', 'CYYC', `2026-11-09T${leaving}:00Z`, series);
    expect(found.map((f) => [f.at, f.attention, f.rule])).toEqual([['CYYC', attention, attention === 'alert' ? 'hazard.onRoute' : 'hazard.notInForce']]);
  });

  it('says when it ends and when you would get there, and to look for a reissue', async () => {
    const [found] = await sigmet('CYVR', 'CYYC', '2026-11-09T03:00:00Z', 'D1');
    expect(found!.summary).toBe('SIGMET D1 (CZEG): sev mountain wave between 0 and 14,000 ft — on your route, but it ends 04:20Z and you would reach it about 05:51Z. Check whether it has been reissued');
  });

  it('notes one that will not have begun until you could be past it', async () => {
    // The other way, D1 is crossed in the first hour and begins at 00:20Z.
    const crossing = (await sigmet('CYYC', 'CYVR', '2026-11-08T22:00:00Z', 'D1')).find((f) => f.rule !== 'hazard.near');
    expect(crossing).toMatchObject({ at: 'CYVR', rule: 'hazard.notInForce', attention: 'note' });
    expect(crossing!.summary).toContain('on your route, but it begins 00:20Z and you would be past it about 22:30Z');
  });

  it('says the same at the departure as on the leg, for an area the flight starts inside', async () => {
    // D8 lies over Calgary and along the leg, and begins while a slow flight would still be in it. Timed from the field alone, the field would have called it over.
    const found = await sigmet('CYYC', 'CYVR', '2026-11-08T22:00:00Z', 'D8');
    expect(found.map((f) => [f.at, f.rule, f.attention])).toEqual([
      ['CYYC', 'hazard.onRoute', 'alert'],
      ['CYVR', 'hazard.onRoute', 'alert'],
    ]);
  });

  it('leaves one in force while you fly through it an alert', async () => {
    const found = await sigmet('CYYC', 'CYEG', '2026-11-09T02:00:00Z', 'D8');
    expect(found.map((f) => [f.rule, f.attention])).toEqual([
      ['hazard.onRoute', 'alert'],
      ['hazard.onRoute', 'alert'],
    ]);
    expect(found[0]!.summary).toContain('your route goes through it');
  });

  it('leaves the chart on the exact time of passing, so inside the margin it can say not drawn', async () => {
    // A tail wind and an early start would reach D1 by 03:35Z, so the text keeps the alert. The plan as filed reaches it after it ends.
    expect((await sigmet('CYVR', 'CYYC', '2026-11-09T02:00:00Z', 'D1'))[0]!.attention).toBe('alert');
    const flight = await resolved('CYVR', 'CYYC', '2026-11-09T02:00:00Z');
    const picture = await routePicture(store, flight);
    const endsLikeD1 = (h: { validTo: string | null }) => h.validTo === '2026-11-09T04:20:00.000Z';
    expect(picture.hazards.some(endsLikeD1)).toBe(false);
    expect(picture.hazardsMissed.find(endsLikeD1)).toMatchObject({ why: 'over-before-you-reach-it' });
  });
});
