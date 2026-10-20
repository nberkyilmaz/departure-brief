import { describe, expect, it } from 'vitest';
import { AWC_BASE_URL, AwcClient } from '../../src/fetch/awc.js';
import { ingestNeighbourhood, neighbourhoodCell } from '../../src/fetch/neighbourhood.js';
import { observationAt } from '../../src/resolve/observation.js';
import { readOurAirportsDirectory } from '../../src/fetch/ourairports.js';
import { MemoryStore } from '../../src/store/memory.js';
import { storeAndDecode } from '../../src/store/decode.js';
import { rawReport } from '../../src/store/types.js';
import { FIXTURES, replayHttp } from '../helpers/http.js';
import { join } from 'node:path';

/**
 * Fetching a field's neighbourhood so it has something to borrow.
 *
 * The recorded response is the real one: the AWC asked at 03:33Z on 19
 * September for every station reporting in the box around CYSN. CYSN is not
 * in it, because St. Catharines had closed for the night. KIAG is, because
 * Niagara Falls reports all night. That is the case this exists for.
 */

const CYSN = { lat: 43.191598, lon: -79.171686 };
const BOX_URL = `${AWC_BASE_URL}/metar?bbox=42,-81.41,45,-77.59&format=json`;
const NIGHT = new Date('2026-09-19T03:40:00Z');

const awcFrom = (routes: Record<string, { status: number; file?: string; body?: string }>) => new AwcClient(replayHttp(routes));
const recorded = { [BOX_URL]: { status: 200, file: 'awc/metar-bbox-CYSN.json' } };

async function storeWithAirports() {
  const store = new MemoryStore();
  /*
   * The Niagara-area slice, not the small shared one: borrowing is about
   * which field is nearest, so the answer is only meaningful against an
   * airport table that holds the neighbours. These are the twenty fields
   * from the recorded box response that OurAirports knows as airports —
   * the marine stations on the list are not aerodromes and so cannot be
   * borrowed from, which is why the nearest reporting *airport* is what
   * this returns.
   */
  await store.putAirports(readOurAirportsDirectory(join(FIXTURES, 'ourairports', '2026-09-19-niagara'), { snapshot: '2026-09-19' }));
  return store;
}

describe('the box a neighbourhood is asked about', () => {
  it('covers the borrowing radius from anywhere in its cell', () => {
    const { box } = neighbourhoodCell(CYSN);
    // A degree of latitude is 60 nm, so a cell plus a degree on each side
    // covers 60 nm from any point inside it.
    expect(box.minLat).toBeCloseTo(42, 5);
    expect(box.maxLat).toBeCloseTo(45, 5);
    // Longitude is padded wider, because a degree of it is shorter here.
    expect(box.maxLon - box.minLon).toBeGreaterThan(box.maxLat - box.minLat);
  });

  it('names the cell, not the position, so two briefings nearby ask once', () => {
    expect(neighbourhoodCell(CYSN).scope).toBe('BOX:43,-80');
    expect(neighbourhoodCell({ lat: 43.9, lon: -79.01 }).scope).toBe('BOX:43,-80');
    expect(neighbourhoodCell({ lat: 44.01, lon: -79.01 }).scope).toBe('BOX:44,-80');
  });

  it('does not run away near the poles or wrap past the world', () => {
    for (const lat of [88.5, -88.5]) {
      const { box } = neighbourhoodCell({ lat, lon: 10 });
      expect(box.maxLon - box.minLon).toBeLessThanOrEqual(61);
      expect(Number.isFinite(box.minLon)).toBe(true);
    }
  });
});

describe('asking who is reporting near a field', () => {
  it('asks when the field has nothing of its own, and stores what comes back', async () => {
    const store = await storeWithAirports();
    const result = await ingestNeighbourhood({ store, awc: awcFrom(recorded) }, CYSN, 'CYSN', NIGHT);

    expect(result.asked).toBe(true);
    expect(result.reports).toBe(31);
    expect(result.scope).toBe('BOX:43,-80');
    // Including the one across the river that reports all night.
    const kiag = await store.listRaw({ station: 'KIAG', kind: 'metar', limit: 1 });
    expect(kiag[0]?.body).toMatch(/^METAR KIAG/);
  });

  it('does not ask when the field is reporting for itself', async () => {
    const store = await storeWithAirports();
    await storeAndDecode(
      store,
      [
        rawReport({
          kind: 'metar',
          source: 'awc',
          station: 'CYSN',
          body: 'METAR CYSN 190330Z 01008KT 15SM SKC 12/07 A3025 RMK SLP245',
          issuedAt: new Date('2026-09-19T03:30:00Z'),
          upstream: null,
        }),
      ],
      'test',
      NIGHT,
    );

    // No routes: any request would throw rather than be answered.
    const result = await ingestNeighbourhood({ store, awc: awcFrom({}) }, CYSN, 'CYSN', NIGHT);
    expect(result.asked).toBe(false);
    expect(result.reason).toMatch(/CYSN is reporting/);
  });

  it('asks once an hour for an area, however many briefings pass through it', async () => {
    const store = await storeWithAirports();
    const http = replayHttp(recorded);
    const awc = new AwcClient(http);

    await ingestNeighbourhood({ store, awc }, CYSN, 'CYSN', NIGHT);
    const again = await ingestNeighbourhood({ store, awc }, { lat: 43.9, lon: -79.9 }, 'CYKZ', new Date('2026-09-19T04:10:00Z'));
    expect(again.asked).toBe(false);
    expect(again.reason).toMatch(/asked about within the hour/);
    expect(http.calls).toHaveLength(1);

    // Past the window it asks again.
    const later = await ingestNeighbourhood({ store, awc }, CYSN, 'CYSN', new Date('2026-09-19T05:00:00Z'));
    expect(later.asked).toBe(true);
    expect(http.calls).toHaveLength(2);
  });

  it('remembers asking even when an area has no reporting stations, so it is not re-asked', async () => {
    const store = new MemoryStore();
    const empty = { [`${AWC_BASE_URL}/metar?bbox=42,-81.41,45,-77.59&format=json`]: { status: 200, body: '[]' } };
    const http = replayHttp(empty);
    const awc = new AwcClient(http);

    expect((await ingestNeighbourhood({ store, awc }, CYSN, 'CYSN', NIGHT)).reports).toBe(0);
    expect((await ingestNeighbourhood({ store, awc }, CYSN, 'CYSN', new Date('2026-09-19T04:00:00Z'))).asked).toBe(false);
    expect(http.calls).toHaveLength(1);
  });
});

describe('what the borrowing does with what was fetched', () => {
  it('reads Niagara Falls when St. Catharines has gone to bed', async () => {
    const store = await storeWithAirports();
    await ingestNeighbourhood({ store, awc: awcFrom(recorded) }, CYSN, 'CYSN', NIGHT);

    const observation = await observationAt(store, CYSN, 'CYSN', NIGHT);
    expect(observation).not.toBeNull();
    expect(observation!.source).toBe('nearby');
    expect(observation!.station).toBe('KIAG');
    // Across the river, not across the province: the reason the box is
    // fetched rather than the flight plan's own stations.
    expect(observation!.distance).toBeLessThan(15);
    expect(observation!.report.body).toMatch(/^METAR KIAG/);
  });
});
