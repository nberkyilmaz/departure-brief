import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { decodeSigmet } from '../../src/decode/sigmet/decode.js';
import { decodeUpperWind } from '../../src/decode/upperwind/decode.js';
import { reviveSigmet, reviveUpperWind } from '../../src/store/revive.js';
import { MemoryStore } from '../../src/store/memory.js';
import { storeAndDecode } from '../../src/store/decode.js';
import { rawReport, type Store } from '../../src/store/types.js';
import { upperWindFor } from '../../src/resolve/wind.js';
import { UPPERWIND_DECODER_VERSION } from '../../src/decode/upperwind/decode.js';

/**
 * A decoded record that has been through JSON, which is what the store does
 * to one on its way to a database.
 *
 * `JSON.parse(JSON.stringify(x))` is exactly what Postgres does to a JSONB
 * column: a `Date` goes in and an ISO string comes back. The in-memory store
 * hands back the object it was given, so this class of bug is invisible to
 * every test that uses it and appears the first time a deployed instance
 * reads back something it stored before restarting.
 */

const FIXTURES = join(__dirname, '..', 'fixtures', 'fetch');
const roundTrip = (v: unknown): unknown => JSON.parse(JSON.stringify(v));

/** A real upper wind record, as NAV CANADA sent it on 18 September. */
const BULLETIN = (() => {
  const fixture = JSON.parse(readFileSync(join(FIXTURES, 'canada-2026-09-18', 'upperwind.json'), 'utf8')) as { data: { text?: string }[] };
  const body = fixture.data.find((r) => typeof r.text === 'string')?.text;
  if (typeof body !== 'string') throw new Error('the recorded upper wind fixture has no record to decode');
  return body;
})();

describe('reviving an upper wind record', () => {
  it('turns the stored strings back into instants', () => {
    const decoded = decodeUpperWind(BULLETIN);
    const revived = reviveUpperWind(roundTrip(decoded));

    for (const field of ['issuedAt', 'basedOn', 'validAt', 'useFrom', 'useTo'] as const) {
      const before = decoded[field];
      const after = revived[field];
      if (before === null) {
        expect(after).toBeNull();
        continue;
      }
      expect(after?.value).toBeInstanceOf(Date);
      expect(after?.value.getTime()).toBe(before.value.getTime());
      // The span survives too, so the citation still points at the text.
      expect(after?.span).toEqual(before.span);
    }
  });

  it('leaves everything else exactly as it was', () => {
    const decoded = decodeUpperWind(BULLETIN);
    const revived = reviveUpperWind(roundTrip(decoded));
    expect(revived.levels).toEqual(decoded.levels);
    expect(revived.unparsed).toEqual(decoded.unparsed);
    expect(revived.bulletin).toEqual(decoded.bulletin);
  });

  it('is harmless on a record that never went through JSON', () => {
    const decoded = decodeUpperWind(BULLETIN);
    expect(reviveUpperWind(decoded)).toEqual(decoded);
  });

  it('treats an unreadable date as absent rather than as a guess', () => {
    const decoded = decodeUpperWind(BULLETIN);
    const broken = { ...(roundTrip(decoded) as Record<string, unknown>), useFrom: { value: 'not a date', span: { start: 0, end: 1 } } };
    expect(reviveUpperWind(broken).useFrom).toBeNull();
  });
});

describe('reviving a hazard advisory', () => {
  const raw = 'WSCN31 CWUL 181530\nSIGMET A1 VALID 181530/181930 CWUL-\nCWUL MONTREAL FIR SEV TURB FCST BLW FL100 MOV E 20KT NC';

  it('turns the validity window back into instants', () => {
    const decoded = decodeSigmet(raw);
    const revived = reviveSigmet(roundTrip(decoded));
    if (decoded.validFrom !== null) {
      expect(revived.validFrom).toBeInstanceOf(Date);
      expect(revived.validFrom?.getTime()).toBe(decoded.validFrom.getTime());
    }
    if (decoded.validTo !== null) {
      expect(revived.validTo).toBeInstanceOf(Date);
      expect(revived.validTo?.getTime()).toBe(decoded.validTo.getTime());
    }
    expect(revived.area).toEqual(decoded.area);
  });
});

describe('the bug this was written for', () => {
  /*
   * The second briefing a deployed instance serves. The first decodes the
   * bulletin in process and works; this one reads the stored record back,
   * which is where it used to throw "useFrom?.value.getTime is not a
   * function" and fail the whole request with a 500.
   */
  it('resolves an upper wind from a record that came back out of the store', async () => {
    const store = new MemoryStore();
    const now = new Date('2026-09-18T18:00:00Z');
    const report = rawReport({ kind: 'upperwind', source: 'navcanada', station: 'CYSN', body: BULLETIN, issuedAt: now, upstream: null });
    await storeAndDecode(store, [report], 'test', now);

    /*
     * A store that hands decoded records back the way a database does. The
     * in-memory one returns the very object it was given, Dates and all,
     * which is the reason this bug survived seven hundred tests.
     */
    // Object.create rather than a spread: the store's methods live on its
    // prototype, so a spread would copy its fields and none of its
    // behaviour. This inherits everything and replaces one thing.
    const throughJson: Store = Object.assign(Object.create(store) as Store, {
      getDecoded: async (sha: string, version: number) => {
        const row = await store.getDecoded(sha, version);
        return row === null ? null : { ...row, decoded: roundTrip(row.decoded) };
      },
    });

    const decoded = decodeUpperWind(BULLETIN);
    expect(decoded.useFrom).not.toBeNull();
    const within = new Date(decoded.useFrom!.value.getTime() + 60_000);

    // Cast rather than revived, this threw "useFrom?.value.getTime is not a
    // function" and the whole briefing came back a 500.
    const found = await upperWindFor(throughJson, 'CYSN', 3000, within, within);
    expect(found).not.toBeNull();
    expect(found!.forecast.useFrom?.value.getTime()).toBe(decoded.useFrom!.value.getTime());
  });
});
