/**
 * Asking for upper winds where they actually exist.
 *
 * The trap this is here to catch: a flight from CYSN to CYKF asks its own
 * aerodromes for upper winds, gets nothing from either — neither is an
 * upper wind site — and reports no wind at all, when Toronto's column
 * forty miles away is exactly what the flight needs.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ingestUpperWinds, upperWindCandidates } from '../../src/fetch/winds.js';
import type { HttpClient } from '../../src/fetch/http.js';
import { NavCanadaClient } from '../../src/fetch/navcanada.js';
import { readOurAirportsDirectory } from '../../src/fetch/ourairports.js';
import { MemoryStore } from '../../src/store/memory.js';

const FIXTURES = join(__dirname, '..', 'fixtures', 'fetch');
const UPPERWIND = join(FIXTURES, 'navcanada', 'upperwind', '2026-09-14');

const CYSN = { lat: 43.191598, lon: -79.171686 };
const CYKF = { lat: 43.4608, lon: -80.378601 };

/** Answers for the sites that publish upper winds, and says nothing about the rest. */
function replay(): HttpClient & { requests: string[] } {
  const requests: string[] = [];
  return {
    requests,
    async get(url: string) {
      requests.push(url);
      const sites = [...url.matchAll(/site=([A-Z0-9]{3,4})/g)].map((m) => m[1]!);
      const data: unknown[] = [];
      for (const site of sites) {
        try {
          data.push(...(JSON.parse(readFileSync(join(UPPERWIND, `${site}.json`), 'utf8')) as { data: unknown[] }).data);
        } catch {
          // No fixture: the service publishes no upper winds for this site.
        }
      }
      return { status: 200, body: JSON.stringify({ meta: { count: { upperwind: data.length } }, data }), headers: {} };
    },
  };
}

async function seeded(): Promise<MemoryStore> {
  const store = new MemoryStore();
  await store.putAirports(readOurAirportsDirectory(join(FIXTURES, 'ourairports', '2026-09-07'), { snapshot: '2026-09-07' }));
  return store;
}

const NOW = new Date('2026-09-14T04:30:00Z');

describe('upperWindCandidates', () => {
  it('asks about the major fields near the route, not the route itself', async () => {
    const store = await seeded();
    const candidates = await upperWindCandidates(store, [CYSN, CYKF]);
    // Toronto is the biggest field within reach, and the one that publishes.
    expect(candidates).toContain('CYYZ');
    // A grass strip is never going to be an upper wind site.
    expect(candidates).not.toContain('CNC3');
    // Biggest first, so the likeliest site is asked about even under a cap.
    expect(candidates[0]).toBe('CYYZ');
  });

  it('finds nothing when the route is nowhere near a major field', async () => {
    const store = await seeded();
    expect(await upperWindCandidates(store, [{ lat: 46.8, lon: -71.2 }])).toEqual([]);
  });
});

describe('ingestUpperWinds', () => {
  it('gets Toronto in one request, and stores it under Toronto', async () => {
    const store = await seeded();
    const http = replay();
    const result = await ingestUpperWinds({ store, navcanada: new NavCanadaClient(http), now: () => NOW }, [CYSN, CYKF]);

    expect(http.requests).toHaveLength(1);
    expect(http.requests[0]).toContain('site=CYYZ');
    expect(result.counts.rawInserted).toBe(6);
    expect((await store.listRaw({ station: 'CYYZ', kind: 'upperwind', limit: 50 })).length).toBe(6);
    // Decoded on the way in, like every other kind of report.
    expect(result.counts.decodedInserted).toBe(6);
  });

  it('does not ask again inside the window', async () => {
    const store = await seeded();
    const http = replay();
    const deps = { store, navcanada: new NavCanadaClient(http), now: () => NOW };
    await ingestUpperWinds(deps, [CYSN, CYKF]);
    const again = await ingestUpperWinds({ ...deps, now: () => new Date(NOW.getTime() + 10 * 60_000) }, [CYSN, CYKF]);

    expect(again.skipped.map((s) => s.station)).toContain('CYYZ');
    // Three bulletins a day: asking every ten minutes would buy nothing.
    expect(http.requests.filter((u) => u.includes('site=CYYZ'))).toHaveLength(1);
  });

  it('asks again once the window has passed', async () => {
    const store = await seeded();
    const http = replay();
    const deps = { store, navcanada: new NavCanadaClient(http), now: () => NOW };
    await ingestUpperWinds(deps, [CYSN]);
    await ingestUpperWinds({ ...deps, now: () => new Date(NOW.getTime() + 2 * 3_600_000) }, [CYSN]);
    expect(http.requests).toHaveLength(2);
  });

  it('sends no request at all when there is nowhere to ask about', async () => {
    const store = await seeded();
    const http = replay();
    const result = await ingestUpperWinds({ store, navcanada: new NavCanadaClient(http), now: () => NOW }, [{ lat: 46.8, lon: -71.2 }]);
    expect(http.requests).toEqual([]);
    expect(result.sites).toEqual([]);
  });
});
