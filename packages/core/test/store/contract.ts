import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { readNasrDirectory } from '../../src/fetch/nasr.js';
import { readOurAirportsDirectory } from '../../src/fetch/ourairports.js';
import type { StoredBriefing } from '../../src/brief/types.js';
import { rawReport, type Store } from '../../src/store/types.js';
import { FIXTURES } from '../helpers/http.js';

/**
 * The behaviour every Store must have. Run against MemoryStore always and
 * against PostgresStore when a database is reachable.
 */
export function storeContract(name: string, make: () => Promise<Store>): void {
  const metar = rawReport({
    kind: 'metar',
    source: 'awc',
    station: 'KJFK',
    body: 'METAR KJFK 071151Z 34007KT 10SM CLR 19/11 A3015 RMK AO2 SLP210 T01890106 10194 20156 53020 $',
    issuedAt: new Date('2026-09-07T11:51:00Z'),
    upstream: { receiptTime: '2026-09-07T11:54:08.892Z' },
  });
  const earlier = rawReport({
    kind: 'metar',
    source: 'awc',
    station: 'KJFK',
    body: 'METAR KJFK 071051Z 33005KT 10SM CLR 16/10 A3013 RMK AO2 SLP202 T01610100 $',
    issuedAt: new Date('2026-09-07T10:51:00Z'),
    upstream: null,
  });
  const t0 = new Date('2026-09-07T12:00:00Z');
  const t1 = new Date('2026-09-07T12:05:00Z');

  describe(`ReportStore contract: ${name}`, () => {
    it('content-addresses raw reports and records every fetch', async () => {
      const store = await make();
      try {
        expect(metar.sha256).toMatch(/^[0-9a-f]{64}$/);
        expect(await store.putRaw(metar, { fetchedAt: t0, request: 'r1' })).toEqual({ inserted: true });
        expect(await store.putRaw(metar, { fetchedAt: t1, request: 'r2' })).toEqual({ inserted: false });
        const got = await store.getRaw(metar.sha256);
        expect(got).toEqual(metar);
        expect(await store.getRaw('0'.repeat(64))).toBeNull();
      } finally {
        await store.close();
      }
    });

    it('lists a station\'s reports newest first', async () => {
      const store = await make();
      try {
        await store.putRaw(earlier, { fetchedAt: t0, request: 'r' });
        await store.putRaw(metar, { fetchedAt: t0, request: 'r' });
        const list = await store.listRaw({ station: 'KJFK', kind: 'metar' });
        expect(list.map((r) => r.sha256)).toEqual([metar.sha256, earlier.sha256]);
        expect(await store.listRaw({ station: 'KJFK', kind: 'metar', limit: 1 })).toHaveLength(1);
        expect(await store.listRaw({ station: 'KJFK', kind: 'taf' })).toEqual([]);
        expect(await store.listRaw({ station: 'KTEB', kind: 'metar' })).toEqual([]);
      } finally {
        await store.close();
      }
    });

    it('stores one decoding per report per decoder version, never overwriting', async () => {
      const store = await make();
      try {
        await store.putRaw(metar, { fetchedAt: t0, request: 'r' });
        const row = { sha256: metar.sha256, kind: 'metar' as const, decoderVersion: 1, decoded: { a: 1 }, decodedAt: t0 };
        expect(await store.putDecoded(row)).toEqual({ inserted: true });
        expect(await store.putDecoded({ ...row, decoded: { a: 2 } })).toEqual({ inserted: false });
        expect((await store.getDecoded(metar.sha256, 1))?.decoded).toEqual({ a: 1 });
        expect(await store.getDecoded(metar.sha256, 2)).toBeNull();
        expect(await store.putDecoded({ ...row, decoderVersion: 2, decoded: { a: 2 } })).toEqual({ inserted: true });
        expect((await store.getDecoded(metar.sha256, 2))?.decoded).toEqual({ a: 2 });
      } finally {
        await store.close();
      }
    });

    it('loads NASR airports once per cycle and looks them up by ICAO or FAA id, newest cycle first', async () => {
      const store = await make();
      try {
        const airports = readNasrDirectory(join(FIXTURES, 'nasr', '2026-09-03'));
        expect(await store.putAirports(airports, t0)).toEqual({ inserted: airports.length });
        expect(await store.putAirports(airports, t1)).toEqual({ inserted: 0 });
        const jfk = await store.getAirport('kjfk');
        expect(jfk).toEqual(airports.find((a) => a.faaId === 'JFK'));
        expect((await store.getAirport('JFK'))?.icaoId).toBe('KJFK');
        expect((await store.getAirport('N07'))?.icaoId).toBeNull();
        expect(await store.getAirport('KZZZ')).toBeNull();

        // A newer cycle supersedes on lookup; the older rows remain.
        const older = airports.map((a) => ({ ...a, cycle: '2026-08-06', name: `${a.name} (OLD)` }));
        const newer = airports.filter((a) => a.faaId === 'JFK').map((a) => ({ ...a, cycle: '2026-10-01', name: 'NEWER' }));
        await store.putAirports([...older, ...newer], t1);
        expect((await store.getAirport('KJFK'))?.name).toBe('NEWER');
        expect((await store.getAirport('KTEB'))?.name).toBe(airports.find((a) => a.faaId === 'TEB')!.name);

        // OurAirports never shadows NASR for a US field, whatever its date...
        const oa = readOurAirportsDirectory(join(FIXTURES, 'ourairports', '2026-09-07'), { snapshot: '2027-01-01' });
        expect(oa.some((a) => a.icaoId === 'KJFK')).toBe(true);
        await store.putAirports(oa, t1);
        expect((await store.getAirport('KJFK'))?.source).toBe('nasr');
        expect((await store.getAirport('CYKF'))?.source).toBe('ourairports');
        // ...but NASR's incomplete border-area foreign entries lose to OurAirports.
        const nasrForeign = { ...airports.find((a) => a.faaId === 'TEB')!, icaoId: 'CYSN', faaId: 'CYSN', country: 'CA', siteNo: 'x1.', name: 'NASR CYSN' };
        await store.putAirports([nasrForeign], t1);
        expect((await store.getAirport('CYSN'))?.source).toBe('ourairports');
        expect((await store.getAirport('CYSN'))?.runways[1]?.ends[0]?.trueHeading).toBe(52.7);
        expect((await store.getAirport('CYKF'))?.runways.map((r) => r.id).sort()).toEqual(['08/26', '14/32']);
        const near = await store.listAirportsNear(43.19, -79.17, 40);
        expect(near[0]?.icaoId).toBe('CYSN');
        expect(near.map((a) => a.icaoId)).toContain('CYHM');
      } finally {
        await store.close();
      }
    });

    it('stores briefings immutably by content hash and lists a flight\'s briefings newest first', async () => {
      const store = await make();
      try {
        const doc = { format: 1, plan: { departure: 'CYSN' }, briefing: { verdict: 'go' } } as unknown as StoredBriefing['document'];
        const a: StoredBriefing = { sha256: 'a'.repeat(64), flightKey: 'f1', asOf: t0, createdAt: t0, document: doc };
        const b: StoredBriefing = { sha256: 'b'.repeat(64), flightKey: 'f1', asOf: t1, createdAt: t1, document: doc };
        const other: StoredBriefing = { sha256: 'c'.repeat(64), flightKey: 'f2', asOf: t1, createdAt: t1, document: doc };
        expect(await store.putBriefing(a)).toEqual({ inserted: true });
        expect(await store.putBriefing(a)).toEqual({ inserted: false });
        await store.putBriefing(b);
        await store.putBriefing(other);
        expect((await store.getBriefing(a.sha256))?.document).toEqual(doc);
        expect((await store.getBriefing(a.sha256))?.asOf).toEqual(t0);
        expect(await store.getBriefing('0'.repeat(64))).toBeNull();
        expect((await store.listBriefings('f1')).map((x) => x.sha256)).toEqual([b.sha256, a.sha256]);
        expect(await store.listBriefings('f1', 1)).toHaveLength(1);
        expect(await store.listBriefings('none')).toEqual([]);
      } finally {
        await store.close();
      }
    });
  });
}
