import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { assembleBriefing, flightKey } from '../../src/brief/assemble.js';
import { canonicalJson, contentHash } from '../../src/brief/canonical.js';
import { parseFlightPlan } from '../../src/domain/flight.js';
import { parseAircraftLimits, parsePilotProfile } from '../../src/domain/profile.js';
import { AWC_BASE_URL, AwcClient } from '../../src/fetch/awc.js';
import { storeAndDecode } from '../../src/fetch/ingest.js';
import { readNasrDirectory } from '../../src/fetch/nasr.js';
import { resolveFlight } from '../../src/resolve/flight.js';
import { MemoryStore } from '../../src/store/memory.js';
import { FIXTURES, replayHttp } from '../helpers/http.js';

const root = join(__dirname, '..', '..', '..', '..');
const plan = parseFlightPlan(JSON.parse(readFileSync(join(root, 'flights', 'demo-kteb-khpn.json'), 'utf8')));
const profile = parsePilotProfile(JSON.parse(readFileSync(join(root, 'profiles', 'default.json'), 'utf8')));
const aircraft = parseAircraftLimits(JSON.parse(readFileSync(join(root, 'aircraft', 'c172.json'), 'utf8')));

async function seededStore(): Promise<MemoryStore> {
  const store = new MemoryStore();
  await store.putAirports(readNasrDirectory(join(FIXTURES, 'nasr', '2026-09-03')));
  const awc = new AwcClient(
    replayHttp({
      [`${AWC_BASE_URL}/metar?ids=KJFK,KTEB,KHPN&format=json`]: { status: 200, file: 'awc/metar-KJFK-KTEB-KHPN.json' },
      [`${AWC_BASE_URL}/taf?ids=KJFK,KTEB,KHPN&format=json`]: { status: 200, file: 'awc/taf-KJFK-KTEB-KHPN.json' },
    }),
  );
  const fetched = new Date('2026-09-07T12:00Z');
  const m = await awc.metars(['KJFK', 'KTEB', 'KHPN']);
  await storeAndDecode(store, m.reports, m.request, fetched);
  const t = await awc.tafs(['KJFK', 'KTEB', 'KHPN']);
  await storeAndDecode(store, t.reports, t.request, fetched);
  return store;
}

describe('canonical JSON', () => {
  it('sorts keys recursively, drops undefined, writes dates as ISO', () => {
    expect(canonicalJson({ b: 1, a: { d: new Date('2026-09-07T12:00:00Z'), c: [3, { z: 1, y: undefined }] } })).toBe(
      '{"a":{"c":[3,{"z":1}],"d":"2026-09-07T12:00:00.000Z"},"b":1}',
    );
  });
  it('hashes structurally equal values identically', () => {
    expect(contentHash({ a: 1, b: [1, 2] })).toBe(contentHash({ b: [1, 2], a: 1 }));
    expect(contentHash({ a: 1 })).not.toBe(contentHash({ a: 2 }));
  });
});

describe('assembleBriefing', () => {
  it('is content-addressed: same inputs, same hash; created time excluded', async () => {
    const store = await seededStore();
    const resolved = await resolveFlight(store, plan, new Date('2026-09-07T12:30:00Z'));
    const a = assembleBriefing(resolved, profile, aircraft, new Date('2026-09-07T12:31:00Z'));
    const b = assembleBriefing(resolved, profile, aircraft, new Date('2026-09-07T12:45:00Z'));
    expect(a.sha256).toBe(b.sha256);
    expect(a.sha256).toBe(contentHash(a.document));
    expect(a.createdAt).not.toEqual(b.createdAt);
  });

  it('records every report it was judged on and the versions of the code', async () => {
    const store = await seededStore();
    const resolved = await resolveFlight(store, plan, new Date('2026-09-07T12:30:00Z'));
    const b = assembleBriefing(resolved, profile, aircraft);
    const d = b.document;
    expect(d.format).toBe(2);
    expect(d.versions).toEqual({ rules: 1, metarDecoder: 2, tafDecoder: 1, notamDecoder: 1, notamPrompt: 1 });
    expect(d.notams).toBeNull();
    expect(d.asOf).toBe('2026-09-07T12:30:00.000Z');
    expect(d.inputs.points.map((p) => p.waypoint)).toEqual(['KTEB', 'N07', 'KHPN']);
    expect(d.inputs.points[1]!.forecast).toMatchObject({ station: 'KTEB', source: 'nearby' });
    expect(d.inputs.alternate?.waypoint).toBe('KJFK');
    // KTEB, KHPN, KJFK each contribute a TAF and a METAR; N07 borrows KTEB's TAF (already counted).
    expect(d.inputs.reports).toHaveLength(6);
    expect(d.inputs.reports.map((r) => r.kind).sort()).toEqual(['metar', 'metar', 'metar', 'taf', 'taf', 'taf']);
    for (const r of d.inputs.reports) expect(await store.getRaw(r.sha256)).not.toBeNull();
    expect(d.briefing.verdict).toBe('go');
  });

  it('a different profile is a different briefing of the same flight', async () => {
    const store = await seededStore();
    const resolved = await resolveFlight(store, plan, new Date('2026-09-07T12:30:00Z'));
    const a = assembleBriefing(resolved, profile, aircraft);
    const b = assembleBriefing(resolved, parsePilotProfile({ name: 'strict', ceilingAglFt: 5000, visibilitySm: 10, crosswindKt: 5 }), aircraft);
    expect(a.sha256).not.toBe(b.sha256);
    expect(a.flightKey).toBe(b.flightKey);
    expect(flightKey({ ...plan, airspace: null, profile: null })).toBe(a.flightKey);
    expect(flightKey({ ...plan, departureTime: '2026-09-07T16:00:00.000Z' })).not.toBe(a.flightKey);
  });

  it('round-trips through the store', async () => {
    const store = await seededStore();
    const resolved = await resolveFlight(store, plan, new Date('2026-09-07T12:30:00Z'));
    const b = assembleBriefing(resolved, profile, aircraft);
    expect(await store.putBriefing(b)).toEqual({ inserted: true });
    expect(await store.putBriefing(b)).toEqual({ inserted: false });
    expect((await store.listBriefings(b.flightKey))[0]?.sha256).toBe(b.sha256);
    expect(JSON.parse(JSON.stringify(b.document))).toEqual(b.document);
  });
});
