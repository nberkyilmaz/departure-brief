import { describe, expect, it } from 'vitest';
import { downloadOurAirports, ensureAirportData, OURAIRPORTS_BASE } from '../../src/fetch/seed.js';
import { MemoryStore } from '../../src/store/memory.js';
import { replayHttp } from '../helpers/http.js';

/**
 * Seeding an empty store, against the recorded OurAirports slice.
 *
 * This is the path a deployed instance takes on its first boot, and it is
 * the only path by which a host that nobody has a shell on gets airport
 * data at all. Every response here is a verbatim slice of the 2026-09-07
 * snapshot.
 */

const routes = (headers?: Record<string, string>) => ({
  [`${OURAIRPORTS_BASE}/airports.csv`]: { status: 200, file: 'ourairports/2026-09-07/airports.csv', ...(headers ? { headers } : {}) },
  [`${OURAIRPORTS_BASE}/runways.csv`]: { status: 200, file: 'ourairports/2026-09-07/runways.csv' },
});

const at = (iso: string) => () => new Date(iso);

describe('downloading an airport snapshot', () => {
  it('takes the snapshot date from the server rather than the clock', async () => {
    const http = replayHttp(routes({ 'last-modified': 'Mon, 07 Sep 2026 03:14:00 GMT' }));
    const { snapshot, airports } = await downloadOurAirports(http, { now: at('2026-09-18T00:00:00Z') });
    expect(snapshot).toBe('2026-09-07');
    expect(airports.every((a) => a.cycle === '2026-09-07')).toBe(true);
  });

  it('falls back to the day it was fetched when the server does not say', async () => {
    const http = replayHttp(routes());
    const { snapshot } = await downloadOurAirports(http, { now: at('2026-09-18T00:00:00Z') });
    expect(snapshot).toBe('2026-09-18');
  });

  it('carries both sides of the border, because a Canadian field borrows across it', async () => {
    const http = replayHttp(routes());
    const { airports } = await downloadOurAirports(http, { now: at('2026-09-18T00:00:00Z') });
    const countries = new Set(airports.map((a) => a.country));
    expect(countries).toContain('CA');
    expect(countries).toContain('US');
  });

  it('asks for one country when told to', async () => {
    const http = replayHttp(routes());
    const { airports } = await downloadOurAirports(http, { countries: ['CA'], now: at('2026-09-18T00:00:00Z') });
    expect(airports.length).toBeGreaterThan(0);
    expect(airports.every((a) => a.country === 'CA')).toBe(true);
  });
});

describe('ensuring an instance has airport data', () => {
  it('loads a snapshot into an empty store, with its runways', async () => {
    const store = new MemoryStore();
    const http = replayHttp(routes());
    const result = await ensureAirportData(store, http, { now: at('2026-09-18T00:00:00Z') });

    expect(result.state).toBe('loaded');
    expect(result.inserted).toBeGreaterThan(0);
    expect(await store.countAirports()).toBe(result.inserted);

    const cnc3 = await store.getAirport('CNC3');
    expect(cnc3?.name).toBe('Brampton-Caledon Airport');
    expect(cnc3?.runways.length).toBeGreaterThan(0);
  });

  it('does not fetch when the store already holds airports', async () => {
    const store = new MemoryStore();
    const first = replayHttp(routes());
    await ensureAirportData(store, first, { now: at('2026-09-18T00:00:00Z') });

    // No routes at all: any request would throw rather than be answered.
    const second = replayHttp({});
    const result = await ensureAirportData(store, second, { now: at('2026-09-19T00:00:00Z') });
    expect(result).toEqual({ state: 'present', inserted: 0, snapshot: null, reason: null });
    expect(second.calls).toEqual([]);
  });

  it('reports why rather than throwing when the download fails', async () => {
    const store = new MemoryStore();
    const result = await ensureAirportData(store, replayHttp({}), { now: at('2026-09-18T00:00:00Z') });
    expect(result.state).toBe('failed');
    expect(result.inserted).toBe(0);
    expect(result.reason).toMatch(/could not download the airport snapshot/);
    expect(await store.countAirports()).toBe(0);
  });

  it('treats a snapshot that parses to nothing as a failure, not an empty load', async () => {
    const store = new MemoryStore();
    const http = replayHttp({
      [`${OURAIRPORTS_BASE}/airports.csv`]: { status: 200, body: 'id,ident,type,name\n' },
      [`${OURAIRPORTS_BASE}/runways.csv`]: { status: 200, body: 'id,airport_ident\n' },
    });
    const result = await ensureAirportData(store, http, { now: at('2026-09-18T00:00:00Z') });
    expect(result.state).toBe('failed');
    expect(result.reason).toMatch(/format has changed/);
  });

  it('reports why rather than throwing when the store refuses the write', async () => {
    const store = new MemoryStore();
    const broken = {
      countAirports: () => store.countAirports(),
      putAirports: async () => {
        throw new Error('connection terminated unexpectedly');
      },
    };
    const result = await ensureAirportData(broken, replayHttp(routes()), { now: at('2026-09-18T00:00:00Z') });
    expect(result.state).toBe('failed');
    expect(result.reason).toMatch(/could not write the airport snapshot: connection terminated/);
  });

  it('says what it is doing, because a first boot is otherwise a silent minute', async () => {
    const store = new MemoryStore();
    const said: string[] = [];
    await ensureAirportData(store, replayHttp(routes()), { now: at('2026-09-18T00:00:00Z'), onProgress: (m) => said.push(m) });
    expect(said.join('\n')).toMatch(/no airport data/);
    expect(said.join('\n')).toMatch(/loading \d+ aerodromes/);
  });
});
