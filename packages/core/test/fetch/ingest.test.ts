import { describe, expect, it } from 'vitest';
import { METAR_DECODER_VERSION, type DecodedMetar } from '../../src/decode/metar/index.js';
import { TAF_DECODER_VERSION, type DecodedTaf } from '../../src/decode/taf/index.js';
import { AWC_BASE_URL, AwcClient } from '../../src/fetch/awc.js';
import { ingestStation, storeAndDecode } from '../../src/fetch/ingest.js';
import { MemoryStore } from '../../src/store/memory.js';
import { rawReport } from '../../src/store/types.js';
import { replayHttp } from '../helpers/http.js';

const routes = {
  [`${AWC_BASE_URL}/metar?ids=KHPN&format=json`]: { status: 200, file: 'awc/metar-KJFK-KTEB-KHPN.json' },
  [`${AWC_BASE_URL}/taf?ids=KHPN&format=json`]: { status: 200, file: 'awc/taf-KHPN.json' },
};

describe('ingestStation', () => {
  it('stores raw and decoded rows, and a second run on unchanged data writes nothing', async () => {
    const store = new MemoryStore();
    const awc = new AwcClient(replayHttp(routes));
    const t0 = new Date('2026-09-07T12:00:00Z');
    const first = await ingestStation({ store, awc, now: () => t0 }, 'khpn');
    expect(first.station).toBe('KHPN');
    expect(first.metar).toEqual({ fetched: 3, rawInserted: 3, decodedInserted: 3 });
    expect(first.taf).toEqual({ fetched: 1, rawInserted: 1, decodedInserted: 1 });
    expect(first.notam).toBeNull();

    const tafs = await store.listRaw({ station: 'KHPN', kind: 'taf' });
    expect(tafs).toHaveLength(1);
    const decoded = (await store.getDecoded(tafs[0]!.sha256, TAF_DECODER_VERSION))?.decoded as DecodedTaf;
    expect(decoded.station?.value).toBe('KHPN');
    expect(decoded.periods.length).toBe(4);

    const metars = await store.listRaw({ station: 'KHPN', kind: 'metar' });
    const m = (await store.getDecoded(metars[0]!.sha256, METAR_DECODER_VERSION))?.decoded as DecodedMetar;
    expect(m.raw).toBe(metars[0]!.body);

    const t1 = new Date('2026-09-07T12:05:00Z');
    const second = await ingestStation({ store, awc, now: () => t1 }, 'KHPN');
    expect(second.metar).toEqual({ fetched: 3, rawInserted: 0, decodedInserted: 0 });
    expect(second.taf).toEqual({ fetched: 1, rawInserted: 0, decodedInserted: 0 });
    // Both fetches are on record even though nothing changed.
    expect(store.fetchLog().filter((f) => f.event.fetchedAt === t1)).toHaveLength(4);
  });
});

describe('storeAndDecode', () => {
  it('decodes a known report again under a newer decoder version', async () => {
    const store = new MemoryStore();
    const r = rawReport({ kind: 'metar', source: 'awc', station: 'KJFK', body: 'METAR KJFK 071151Z 34007KT 10SM CLR 19/11 A3015', issuedAt: null, upstream: null });
    await store.putRaw(r, { fetchedAt: new Date(0), request: 'x', station: null });
    await store.putDecoded({ sha256: r.sha256, kind: 'metar', decoderVersion: METAR_DECODER_VERSION - 1, decoded: {}, decodedAt: new Date(0) });
    const counts = await storeAndDecode(store, [r], 'x', new Date(1));
    expect(counts).toEqual({ fetched: 1, rawInserted: 0, decodedInserted: 1 });
    expect(await store.getDecoded(r.sha256, METAR_DECODER_VERSION)).not.toBeNull();
  });

  it('decodes NOTAMs too, and records which station a fetch was for', async () => {
    const store = new MemoryStore();
    const r = rawReport({ kind: 'notam', source: 'navcanada-cfps', station: null, body: '(A0001/26 NOTAMN Q) CZYZ/QMRLC/IV/NBO/A/000/999 A) CYSN B) 2609140000 C) 2609150000 E) RWY 06/24 CLSD)', issuedAt: null, upstream: null });
    expect(await storeAndDecode(store, [r], 'x', new Date(1), 'CYKF')).toEqual({ fetched: 1, rawInserted: 1, decodedInserted: 1 });
    expect((await store.listRaw({ station: 'CYKF', kind: 'notam' })).map((x) => x.sha256)).toEqual([r.sha256]);
    expect(store.fetchLog()[0]?.event.station).toBe('CYKF');
  });
});
