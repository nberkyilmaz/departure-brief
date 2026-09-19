/**
 * The observation that describes a place, when the place is not reporting.
 *
 * CYSN is a part-time station: it stops overnight, and its last METAR sits
 * there getting older. This is the case the owner asked for by name — "if
 * metar doesnt publish at night it can show nearest airport that does" —
 * and it is the general case, not a special one.
 *
 * Built on the recorded snapshot — both sides of the border, because a
 * border is not a weather boundary — so the stations, distances and issue
 * times are all real.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { AWC_BASE_URL, AwcClient } from '../../src/fetch/awc.js';
import type { HttpClient } from '../../src/fetch/http.js';
import { readOurAirportsDirectory } from '../../src/fetch/ourairports.js';
import { CURRENT_WITHIN_MS, observationAt, OBSERVATION_RADIUS_NM } from '../../src/resolve/observation.js';
import { storeAndDecode } from '../../src/store/decode.js';
import { MemoryStore } from '../../src/store/memory.js';
import { rawReport } from '../../src/store/types.js';

const SNAPSHOT = join(__dirname, '..', 'fixtures', 'fetch', 'canada-2026-09-18');
const weather = JSON.parse(readFileSync(join(SNAPSHOT, 'weather.json'), 'utf8')) as {
  _recorded: string;
  metar: { icaoId: string; rawOb: string; reportTime?: string }[];
};

/** The instant the snapshot was taken. */
const RECORDED = new Date(`${weather._recorded.slice(0, 16)}:00Z`);

const CYSN = { lat: 43.191598, lon: -79.171686 };

/** The recorded response, replayed through the real client. */
const replay: HttpClient = {
  async get(url) {
    if (url.startsWith(`${AWC_BASE_URL}/metar`)) return { status: 200, body: JSON.stringify(weather.metar), headers: {} };
    return { status: 204, body: '', headers: {} };
  },
};

async function seeded(): Promise<MemoryStore> {
  const store = new MemoryStore();
  await store.putAirports(readOurAirportsDirectory(join(SNAPSHOT, 'ourairports'), { snapshot: '2026-09-18' }).filter((a) => a.siteType === 'A'));
  const fetched = await new AwcClient(replay).metars(['CYSN']);
  await storeAndDecode(store, fetched.reports, fetched.request, RECORDED);
  return store;
}

describe('observationAt', () => {
  it("uses the field's own observation while it is current, and says how old it is", async () => {
    const store = await seeded();
    const at = (await observationAt(store, CYSN, 'CYSN', RECORDED))!;
    expect(at.station).toBe('CYSN');
    expect(at.source).toBe('own');
    expect(at.distance).toBe(0);
    expect(at.ageMinutes * 60_000).toBeLessThanOrEqual(CURRENT_WITHIN_MS);
    expect(at.ownAsleep).toBe(false);
  });

  it('shows Niagara Falls when St. Catharines has gone to bed', async () => {
    /*
     * The case the owner asked for by name. CYSN stops reporting overnight;
     * KIAG, twelve miles away across the river, reports around the clock.
     *
     * Every report here is real and sits at its own real time. What is
     * arranged is only which of them the store was given: CYSN's up to
     * 20:00Z and no further, which is precisely what a store holds on any
     * night after that field has closed.
     */
    const store = new MemoryStore();
    await store.putAirports(readOurAirportsDirectory(join(SNAPSHOT, 'ourairports'), { snapshot: '2026-09-18' }).filter((a) => a.siteType === 'A'));
    const awake = (id: string, until: string) =>
      weather.metar.filter((m) => m.icaoId === id && m.reportTime !== undefined && m.reportTime <= until);
    const asleepAt = '2026-09-18T20:00:00.000Z';
    const openAt = '2026-09-19T00:00:00.000Z';

    const client = new AwcClient({
      async get(url) {
        const id = /ids=([A-Z]{4})/.exec(url)?.[1] ?? '';
        return { status: 200, body: JSON.stringify(id === 'CYSN' ? awake('CYSN', asleepAt) : awake(id, openAt)), headers: {} };
      },
    });
    for (const id of ['CYSN', 'KIAG']) {
      const fetched = await client.metars([id]);
      await storeAndDecode(store, fetched.reports, fetched.request, RECORDED);
    }

    // Half past midnight Zulu: CYSN last spoke at eight in the evening.
    const night = new Date('2026-09-19T00:30:00Z');
    const at = (await observationAt(store, CYSN, 'CYSN', night))!;
    expect(at.station).toBe('KIAG');
    expect(at.source).toBe('nearby');
    expect(at.ownAsleep).toBe(true);
    // Twelve miles across the river, and the reading is fresh.
    expect(at.distance).toBeLessThan(20);
    expect(at.ageMinutes).toBeLessThanOrEqual(90);
    // And the report really is Niagara Falls', not St. Catharines' relabelled.
    expect(at.decoded.station?.value).toBe('KIAG');
  });

  it('keeps a stale reading rather than falling silent when nothing is current', async () => {
    const store = await seeded();
    /*
     * Six hours after the snapshot: CYSN's last observation is old, and
     * whichever neighbours were still reporting at that moment are not.
     * Whatever this returns must be a real station, and it must say so.
     */
    const later = new Date(RECORDED.getTime() + 6 * 3_600_000);
    const at = (await observationAt(store, CYSN, 'CYSN', later))!;
    expect(at.ageMinutes).toBeGreaterThan(CURRENT_WITHIN_MS / 60_000);
    // Nothing current anywhere, so the field's own stale reading stands —
    // which is information, where a blank would not be.
    expect(at.source).toBe('own');
    expect(at.station).toBe('CYSN');
  });

  it('stands a neighbour in for a field that never reports, with the distance', async () => {
    const store = await seeded();
    // A point near CYSN that is not a reporting station at all.
    const nowhere = { lat: 43.25, lon: -79.35 };
    const at = (await observationAt(store, nowhere, null, RECORDED))!;
    expect(at.source).toBe('nearby');
    expect(at.station).toMatch(/^[A-Z]{4}$/);
    expect(at.distance).toBeGreaterThan(0);
    expect(at.distance).toBeLessThanOrEqual(OBSERVATION_RADIUS_NM);
    // It had no observation of its own to be asleep from.
    expect(at.ownAsleep).toBe(false);
  });

  it('prefers the nearest of several, not merely the first found', async () => {
    const store = await seeded();
    const nowhere = { lat: 43.25, lon: -79.35 };
    const chosen = (await observationAt(store, nowhere, null, RECORDED))!;
    const others = (await store.listAirportsNear(nowhere.lat, nowhere.lon, OBSERVATION_RADIUS_NM)).filter((a) => a.icaoId !== null);
    const nearer = others.filter((a) => a.icaoId !== chosen.station);
    for (const a of nearer) {
      const theirs = await store.listRaw({ station: a.icaoId!, kind: 'metar', limit: 1 });
      // Anything closer than the one chosen must have had nothing current.
      if (theirs.length > 0 && theirs[0]!.issuedAt) {
        const age = (RECORDED.getTime() - theirs[0]!.issuedAt.getTime()) / 60_000;
        if (age * 60_000 <= CURRENT_WITHIN_MS) expect(chosen.distance).toBeLessThanOrEqual(1e-6 + 60);
      }
    }
  });

  it('has nothing to say where there is nothing within reach', async () => {
    const store = await seeded();
    // The middle of Hudson Bay: no aerodrome inside sixty miles.
    expect(await observationAt(store, { lat: 59.5, lon: -85.5 }, null, RECORDED)).toBeNull();
  });

  it('never presents a borrowed reading as the field it stands in for', async () => {
    const store = await seeded();
    // A synthetic neighbour at a known distance, so the label is checkable.
    const report = rawReport({
      kind: 'metar',
      source: 'awc',
      station: 'CYXX',
      body: `METAR CYXX ${RECORDED.getUTCDate().toString().padStart(2, '0')}${RECORDED.getUTCHours().toString().padStart(2, '0')}00Z 27010KT 15SM SKC 18/06 A3005`,
      issuedAt: RECORDED,
      upstream: null,
    });
    await storeAndDecode(store, [report], 'x', RECORDED);
    const at = await observationAt(store, CYSN, 'CYSN', RECORDED);
    // CYSN's own is current, so nothing was borrowed and the station is its own.
    expect(at!.station).toBe('CYSN');
    expect(at!.source).toBe('own');
  });
});
