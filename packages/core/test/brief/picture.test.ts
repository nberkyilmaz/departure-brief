/**
 * The route picture, over the products the relay held on the evening of
 * 8 November 2026: every report from the ground the flights cross, the
 * SIGMETs over Alberta, NAV CANADA's upper winds, all at their real times
 * and positions. Vancouver to Calgary crosses the Rockies with five stations
 * beside it and two severe mountain wave SIGMETs near its far end.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { routePicture, type PictureStation } from '../../src/brief/picture.js';
import { parseFlightPlan } from '../../src/domain/flight.js';
import { pointInArea } from '../../src/domain/polygon.js';
import { AwcCacheClient } from '../../src/fetch/awcCache.js';
import { AwcClient } from '../../src/fetch/awc.js';
import { NavCanadaClient } from '../../src/fetch/navcanada.js';
import { readOurAirportsDirectory } from '../../src/fetch/ourairports.js';
import type { HttpClient } from '../../src/fetch/response.js';
import { resolveFlight } from '../../src/resolve/flight.js';
import { storeAndDecode } from '../../src/store/decode.js';
import { MemoryStore } from '../../src/store/memory.js';

const FETCH = join(__dirname, '..', 'fixtures', 'fetch');
const SNAPSHOT = join(FETCH, 'rockies-2026-11-08');
const file = (name: string) => readFileSync(join(SNAPSHOT, name), 'utf8');
const RECORDED = new Date('2026-11-09T01:26:00Z');

const http: HttpClient = {
  async get(url) {
    const name = url.includes('metars') ? 'metars.cache.csv' : url.includes('tafs') ? 'tafs.cache.xml' : url.includes('isigmet') ? 'isigmet.json' : url.includes('airsigmet') ? 'airsigmet.json' : 'upperwind.json';
    return { status: 200, body: file(name), headers: {} };
  },
};

async function seeded(options: { winds?: boolean } = {}): Promise<MemoryStore> {
  const store = new MemoryStore();
  await store.putAirports(readOurAirportsDirectory(join(FETCH, 'canada-2026-09-18', 'ourairports'), { snapshot: '2026-09-18' }).filter((a) => a.siteType === 'A'));
  const cache = new AwcCacheClient(http, 'https://relay.example/awc/cache');
  for (const batch of [await cache.metars(), await cache.tafs()]) await storeAndDecode(store, batch.reports, batch.request, RECORDED);
  const hazards = await new AwcClient(http, 'https://relay.example/awc').sigmets();
  await storeAndDecode(store, hazards.reports, hazards.request, RECORDED, 'WORLD');
  if (options.winds !== false) {
    const winds = await new NavCanadaClient(http, 'https://relay.example/cfps/').upperWinds(['CYVR', 'CYYC', 'CYEG']);
    for (const site of ['CYVR', 'CYYC', 'CYEG']) await storeAndDecode(store, winds.reports.filter((r) => r.station === site), winds.request, RECORDED, site);
  }
  return store;
}

const plan = (departure: string, destination: string, departureTime: string) =>
  parseFlightPlan({ departure, destination, alternate: null, route: [], departureTime, cruise: { tas: 110, altitude: 11500 }, airspace: null });

async function picture(departure: string, destination: string, departureTime: string, store?: MemoryStore) {
  const s = store ?? (await seeded());
  const flight = await resolveFlight(s, plan(departure, destination, departureTime), RECORDED);
  return { flight, picture: await routePicture(s, flight) };
}

const named = (stations: readonly PictureStation[], id: string): PictureStation => {
  const found = stations.find((s) => s.id === id);
  if (!found) throw new Error(`${id} is not on the route`);
  return found;
};

describe('the stations on the picture', () => {
  it('has both ends and every station beside the track, in the order they are passed', async () => {
    const { picture: p, flight } = await picture('CYVR', 'CYYC', '2026-11-09T03:00:00Z');
    expect(p.stations.map((s) => [s.id, s.role])).toEqual([
      ['CYVR', 'departure'],
      ['CYXX', 'along'],
      ['CYHE', 'along'],
      ['CYDC', 'along'],
      ['CYLW', 'along'],
      ['CYBW', 'along'],
      ['CYYC', 'destination'],
    ]);
    expect(p.totalNm).toBe(flight.route.total);
    expect(p.cruiseFt).toBe(11500);
    // The clock is the briefing's own: the same ETA "Along the way" prints.
    for (const s of flight.enroute) expect(named(p.stations, s.station).at).toBe(s.eta.toISOString());
  });

  it('puts a TAF cloud base on the altitude scale with the elevation of its station', async () => {
    const { picture: p } = await picture('CYVR', 'CYYC', '2026-11-09T03:00:00Z');
    const cyxx = named(p.stations, 'CYXX');
    expect(cyxx.elevationFt).toBe(195);
    expect(cyxx.reading?.from).toBe('forecast');
    // TAF CYXX: FEW020 SCT060 BKN140.
    expect(cyxx.reading?.sky?.layers.map((l) => [l.amount, l.baseMsl])).toEqual([
      ['FEW', 2195],
      ['SCT', 6195],
      ['BKN', 14195],
    ]);
    expect(cyxx.reading?.sky?.visibility).toBe('>6 SM');
    expect(named(p.stations, 'CYLW').reading?.sky?.layers).toEqual([]);
  });

  it('carries a TEMPO separately from what prevails', async () => {
    const { picture: p } = await picture('CYVR', 'CYYC', '2026-11-09T03:00:00Z');
    const overlays = named(p.stations, 'CYXX').reading!.overlays;
    expect(overlays.map((o) => o.label)).toEqual(['TEMPO']);
    expect(overlays[0]!.sky.layers.map((l) => [l.amount, l.baseMsl])).toEqual([['BKN', 6195]]);
  });

  it('uses the elevation of the station whose forecast it is, when a named field borrows one', async () => {
    const { picture: p, flight } = await picture('CYVR', 'CYHE', '2026-11-09T02:00:00Z');
    const hope = named(p.stations, 'CYHE');
    expect(hope.elevationFt).toBe(128);
    const borrowed = flight.points[1]!.forecast!;
    expect(borrowed.source).toBe('nearby');
    expect(hope.reading?.station).toBe(borrowed.station);
    expect(hope.reading?.distanceNm).toBe(borrowed.distance);
    const whose = (await (await seeded()).getAirport(borrowed.station))!.elevation!;
    expect(whose).not.toBe(128);
    const first = borrowed.resolved.prevailing!.conditions.sky.map((s) => s.value).find((v) => v.kind === 'layer');
    expect(first?.kind).toBe('layer');
    if (first?.kind === 'layer') expect(hope.reading?.sky?.layers[0]?.baseMsl).toBe(first.base! + whose);
  });

  it('draws an observation only while it says something about the time you pass', async () => {
    // CYHE reported at 01:00Z. Leaving 01:30Z you pass it 66 minutes later, inside the ninety.
    const soon = (await picture('CYVR', 'CYYC', '2026-11-09T01:30:00Z')).picture;
    const hope = named(soon.stations, 'CYHE');
    expect(hope.reading?.from).toBe('observed');
    expect(hope.reading?.issuedAt).toBe('2026-11-09T01:00:00.000Z');
    expect(hope.reading?.sky?.layers.map((l) => [l.amount, l.baseMsl])).toEqual([['OVC', 5628]]);
    expect(hope.reading?.sky?.visibility).toBe('9 SM');

    // Leaving 03:00Z you pass it 155 minutes after it reported: the letter stays, the sky does not.
    const later = (await picture('CYVR', 'CYYC', '2026-11-09T03:00:00Z')).picture;
    const reading = named(later.stations, 'CYHE').reading;
    expect(reading?.from).toBe('observed');
    expect(reading?.issuedAt).toBe('2026-11-09T01:00:00.000Z');
    expect(reading?.sky).toBeNull();
    expect(reading?.overlays).toEqual([]);
  });

  it('survives the trip to the browser unchanged', async () => {
    const { picture: p } = await picture('CYVR', 'CYYC', '2026-11-09T03:00:00Z');
    expect(JSON.parse(JSON.stringify(p))).toEqual(p);
  });
});

describe('the advisories on the picture', () => {
  it('finds how far along the route it is inside each area, by the geometry the rules use', async () => {
    const { picture: p, flight } = await picture('CYYC', 'CYLW', '2026-11-09T01:30:00Z');
    expect(p.hazards.map((h) => [h.kind, h.what, h.qualifier, h.region, h.baseFt, h.topFt])).toEqual([
      ['sigmet', 'mountain wave', 'SEV', 'CZEG', 0, 22000],
      ['sigmet', 'mountain wave', 'SEV', 'CZEG', 0, 14000],
    ]);
    const [a, b] = [flight.route.points[0]!.waypoint.position, flight.route.points[1]!.waypoint.position];
    for (const h of p.hazards) {
      const steps = 4000;
      const inside: number[] = [];
      for (let i = 0; i <= steps; i++) {
        const f = i / steps;
        if (pointInArea({ lat: a.lat + (b.lat - a.lat) * f, lon: a.lon + (b.lon - a.lon) * f }, h.area)) inside.push(f * p.totalNm);
      }
      expect(h.stretches).toHaveLength(1);
      expect(Math.abs(h.stretches[0]!.fromNm - inside[0]!)).toBeLessThan(0.5);
      expect(Math.abs(h.stretches[0]!.toNm - inside[inside.length - 1]!)).toBeLessThan(0.5);
    }
    expect(p.hazardsMissed).toEqual([]);
  });

  it('leaves nothing on the picture from an area the route has nothing to do with', async () => {
    const { picture: p, flight } = await picture('CYYC', 'CYLW', '2026-11-09T01:30:00Z');
    expect(flight.hazards.length).toBeGreaterThan(p.hazards.length);
    expect(JSON.stringify(p)).not.toContain('KZAK');
  });

  it('stops a stretch where the advisory ends, when that is while you are inside it', async () => {
    // Leaving 03:00Z, the SIGMET to 03:15Z has fifteen minutes left: twenty-seven and a half miles at 110 kt.
    const { picture: p } = await picture('CYYC', 'CYLW', '2026-11-09T03:00:00Z');
    const ending = p.hazards.find((h) => h.validTo === '2026-11-09T03:15:00.000Z')!;
    expect(ending.stretches[0]!.endsInside).toBe(true);
    expect(ending.stretches[0]!.toNm).toBeCloseTo(27.5, 6);
    expect(ending.stretches[0]!.toAt).toBe('2026-11-09T03:15:00.000Z');
    const running = p.hazards.find((h) => h.validTo === '2026-11-09T04:20:00.000Z')!;
    expect(running.stretches[0]!.endsInside).toBe(false);
  });

  it('says so, rather than drawing it, when an advisory is over before you reach it', async () => {
    // The flight is under way while both are in force, but they end before you get to Alberta.
    const { picture: p } = await picture('CYVR', 'CYYC', '2026-11-09T03:00:00Z');
    expect(p.hazards).toEqual([]);
    expect(p.hazardsMissed.map((h) => [h.why, h.validTo])).toEqual(
      expect.arrayContaining([
        ['over-before-you-reach-it', '2026-11-09T03:15:00.000Z'],
        ['over-before-you-reach-it', '2026-11-09T04:20:00.000Z'],
      ]),
    );
    for (const h of p.hazardsMissed) expect(Date.parse(h.at)).toBeGreaterThan(Date.parse(h.validTo!));
  });

  it('counts the advisories whose area cannot be drawn, without placing them', async () => {
    const { picture: p } = await picture('CYVR', 'CYYC', '2026-11-09T03:00:00Z');
    expect(p.hazardsUntestable).toBe(2);
  });
});

describe('the freezing level on the picture', () => {
  it('reads it wherever there are upper-air temperatures, for the time you pass', async () => {
    const { picture: p } = await picture('CYVR', 'CYYC', '2026-11-09T03:00:00Z');
    // Vancouver is already below zero at 6,000 ft, the lowest level with a temperature; Calgary crosses between 6,000 and 9,000.
    expect(p.freezing.map((f) => [f.station, f.nm === 0 ? 'departure' : 'destination', f.crossingsFt, f.belowFt])).toEqual([
      ['CYVR', 'departure', [], 6000],
      ['CYYC', 'destination', [7000], null],
    ]);
    expect(p.freezing.every((f) => f.distanceNm === 0)).toBe(true);
  });

  it('says how far off a borrowed site is', async () => {
    const { picture: p, flight } = await picture('CYXX', 'CYLW', '2026-11-09T03:00:00Z');
    const abbotsford = p.freezing.find((f) => f.nm === 0)!;
    expect(abbotsford.station).toBe('CYVR');
    expect(abbotsford.distanceNm).toBe(flight.points[0]!.wind!.distance);
    expect(abbotsford.distanceNm).toBeGreaterThan(20);
  });

  it('has none where no upper-air temperatures reach', async () => {
    const { picture: p } = await picture('CYVR', 'CYYC', '2026-11-09T03:00:00Z', await seeded({ winds: false }));
    expect(p.freezing).toEqual([]);
  });
});
