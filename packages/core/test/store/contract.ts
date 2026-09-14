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
        expect(await store.putRaw(metar, { fetchedAt: t0, request: 'r1', station: null })).toEqual({ inserted: true });
        expect(await store.putRaw(metar, { fetchedAt: t1, request: 'r2', station: null })).toEqual({ inserted: false });
        const got = await store.getRaw(metar.sha256);
        expect(got).toEqual(metar);
        expect(await store.getRaw('0'.repeat(64))).toBeNull();
      } finally {
        await store.close();
      }
    });

    it('lists reports fetched *for* a station even when they are about no station, honouring knownBy', async () => {
      const store = await make();
      try {
        const firWide = rawReport({ kind: 'notam', source: 'x', station: null, body: '(G0001/26 NOTAMN Q) CZXX/QGWAU/IV/NBO/E/000/999 A) CZYZ B) 2609140400 C) 2609181059 E) GPS INTERFERENCE)', issuedAt: null, upstream: null });
        await store.putRaw(firWide, { fetchedAt: t0, request: 'cysn', station: 'CYSN' });
        await store.putRaw(firWide, { fetchedAt: t1, request: 'cykf', station: 'CYKF' });
        expect((await store.listRaw({ station: 'CYSN', kind: 'notam' })).map((r) => r.sha256)).toEqual([firWide.sha256]);
        expect((await store.listRaw({ station: 'CYKF', kind: 'notam' })).map((r) => r.sha256)).toEqual([firWide.sha256]);
        expect(await store.listRaw({ station: 'CYHM', kind: 'notam' })).toEqual([]);
        // Known as of t0: only the CYSN association existed.
        expect(await store.listRaw({ station: 'CYKF', kind: 'notam', knownBy: t0 })).toEqual([]);
        expect(await store.listRaw({ station: 'CYSN', kind: 'notam', knownBy: t0 })).toHaveLength(1);
        expect(await store.listRaw({ station: 'CYSN', kind: 'metar' })).toEqual([]);
      } finally {
        await store.close();
      }
    });

    it('lists a station\'s reports newest first', async () => {
      const store = await make();
      try {
        await store.putRaw(earlier, { fetchedAt: t0, request: 'r', station: null });
        await store.putRaw(metar, { fetchedAt: t0, request: 'r', station: null });
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
        await store.putRaw(metar, { fetchedAt: t0, request: 'r', station: null });
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

    it('records a forecast and, later, what arrived — both written once, never rewritten', async () => {
      const store = await make();
      try {
        const taf = rawReport({ kind: 'taf', source: 'awc', station: 'CYSN', body: 'TAF CYSN 121140Z 1212/1312 18010KT P6SM BKN030', issuedAt: new Date('2026-09-12T11:40:00Z'), upstream: null });
        const metar = rawReport({ kind: 'metar', source: 'awc', station: 'CYSN', body: 'METAR CYSN 121500Z 18012KT 4SM BR BKN012', issuedAt: new Date('2026-09-12T15:00:00Z'), upstream: null });
        await store.putRaw(taf, { fetchedAt: new Date('2026-09-12T11:45:00Z'), request: 't', station: 'CYSN' });
        await store.putRaw(metar, { fetchedAt: new Date('2026-09-12T15:05:00Z'), request: 'm', station: 'CYSN' });

        const validAt = new Date('2026-09-12T15:00:00Z');
        const check = {
          key: 'k1',
          station: 'CYSN',
          validAt,
          tafSha256: taf.sha256,
          tafIssuedAt: taf.issuedAt,
          tafDecoderVersion: 1,
          leadHours: 3.3,
          ceilingFt: 3000,
          visibilitySm: 6,
          visibilityAtLeast: true,
          windDirTrue: 180,
          windKt: 10,
          gustKt: null,
          category: 'VFR' as const,
          overlayWorstCategory: null,
          createdAt: new Date('2026-09-12T11:50:00Z'),
        };
        expect(await store.putForecastCheck(check)).toEqual({ inserted: true });
        expect(await store.putForecastCheck(check)).toEqual({ inserted: false });

        // Before its moment passes it is not yet answerable; after, it is outstanding.
        expect(await store.listUnmatchedChecks({ before: new Date('2026-09-12T14:00:00Z') })).toEqual([]);
        const waiting = await store.listUnmatchedChecks({ before: new Date('2026-09-12T16:00:00Z') });
        expect(waiting.map((c) => c.key)).toEqual(['k1']);
        expect(waiting[0]!.validAt.toISOString()).toBe(validAt.toISOString());
        expect(waiting[0]!.ceilingFt).toBe(3000);
        expect(await store.listUnmatchedChecks({ station: 'CYKF', before: new Date('2026-09-12T16:00:00Z') })).toEqual([]);
        expect(await store.listVerificationPairs({})).toEqual([]);

        const outcome = {
          checkKey: 'k1',
          metarSha256: metar.sha256,
          observedAt: metar.issuedAt!,
          offsetMinutes: 0,
          ceilingFt: 1200,
          visibilitySm: 4,
          visibilityAtLeast: false,
          windDirTrue: 180,
          windKt: 12,
          gustKt: null,
          category: 'IFR' as const,
          matchedAt: new Date('2026-09-12T15:10:00Z'),
        };
        expect(await store.putForecastOutcome(outcome)).toEqual({ inserted: true });
        expect(await store.putForecastOutcome(outcome)).toEqual({ inserted: false });

        // Answered, so no longer outstanding, and now a pair.
        expect(await store.listUnmatchedChecks({ before: new Date('2026-09-12T16:00:00Z') })).toEqual([]);
        const pairs = await store.listVerificationPairs({ station: 'CYSN' });
        expect(pairs).toHaveLength(1);
        expect(pairs[0]!.check.key).toBe('k1');
        expect(pairs[0]!.check.leadHours).toBeCloseTo(3.3, 5);
        expect(pairs[0]!.outcome.ceilingFt).toBe(1200);
        expect(pairs[0]!.check.visibilityAtLeast).toBe(true);
        expect(pairs[0]!.outcome.visibilityAtLeast).toBe(false);
        expect(pairs[0]!.outcome.category).toBe('IFR');
        expect(pairs[0]!.outcome.observedAt.toISOString()).toBe('2026-09-12T15:00:00.000Z');
        expect(await store.listVerificationPairs({ station: 'CYKF' })).toEqual([]);
        expect(await store.listVerificationPairs({ since: new Date('2026-09-13T00:00:00Z') })).toEqual([]);
      } finally {
        await store.close();
      }
    });

    it('remembers being asked, even when the answer was nothing', async () => {
      const store = await make();
      const kind = 'sigmet' as const;
      // Nothing was received, so there is no report to hang a fetch on.
      expect(await store.lastFetchAt('WORLD', kind)).toBeNull();

      const at = new Date('2026-09-14T05:00:00Z');
      await store.putFetchAttempt({ scope: 'WORLD', kind, attemptedAt: at, request: 'https://example.test/isigmet' });
      expect((await store.lastFetchAt('WORLD', kind))?.getTime()).toBe(at.getTime());

      // The latest asking wins, and another kind is a different question.
      const later = new Date('2026-09-14T06:00:00Z');
      await store.putFetchAttempt({ scope: 'WORLD', kind, attemptedAt: later, request: 'x' });
      expect((await store.lastFetchAt('WORLD', kind))?.getTime()).toBe(later.getTime());
      expect(await store.lastFetchAt('WORLD', 'metar')).toBeNull();
      expect(await store.lastFetchAt('CYSN', kind)).toBeNull();
    });

  });
}
