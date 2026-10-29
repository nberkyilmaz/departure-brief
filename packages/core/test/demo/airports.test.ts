/**
 * The page holds an index of every aerodrome and fetches the full records
 * a square at a time. The claim that makes that safe is that a store built
 * this way answers every question exactly as one holding the whole
 * continent would — so that is what is tested, over the files the site
 * publishes, at places chosen to be awkward: the edge of a square, a
 * duplicated identifier, and the antimeridian.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CatalogStore, cellOf, packAirport, unpackAirport, UnpackableAirportError, type AirportCell, type AirportIndex } from '../../src/demo/airports.js';
import type { Airport } from '../../src/domain/airport.js';
import { readOurAirportsDirectory } from '../../src/fetch/ourairports.js';
import { MemoryStore } from '../../src/store/memory.js';
import { FIXTURES } from '../helpers/http.js';

const DIR = join(__dirname, '..', '..', '..', '..', 'apps', 'web', 'public', 'demo', 'airports');
const read = <T,>(name: string): T => JSON.parse(readFileSync(join(DIR, name), 'utf8')) as T;
const index = read<AirportIndex>('index.json');

function catalog(): { store: CatalogStore; loads: string[] } {
  const loads: string[] = [];
  const store = new CatalogStore(index, async (cell) => {
    loads.push(cell);
    return read<AirportCell>(`${cell}.json`);
  });
  return { store, loads };
}

async function everything(): Promise<MemoryStore> {
  const store = new MemoryStore();
  for (const f of readdirSync(DIR)) {
    if (f === 'index.json') continue;
    const cell = read<AirportCell>(f);
    await store.putAirports(cell.airports.map((p) => unpackAirport(p, cell)));
  }
  return store;
}

const ids = (airports: readonly Airport[]) => airports.map((a) => `${a.icaoId ?? a.faaId}#${a.siteNo}`);

describe('the aerodromes the page carries', () => {
  it('cover Canada and the United States, Miami included', () => {
    const countries = new Set(index.airports.map((r) => r[0].slice(0, 1)));
    expect(index.airports.length).toBeGreaterThan(17_000);
    expect(countries.has('C') && countries.has('K')).toBe(true);
    expect(index.airports.some((r) => r[0] === 'KMIA' && r[1] === 'MIA')).toBe(true);
  });

  it('answers as a store holding every one of them would', async () => {
    const full = await everything();
    const { store } = catalog();
    // ICAO and FAA forms; an FAA identifier OurAirports lists twice; one in both countries; one in neither.
    for (const id of ['CYSN', 'KMIA', 'MIA', 'X51', 'cykf', '5MO', 'CA69', 'EGLL']) {
      expect((await store.getAirport(id))?.siteNo ?? null, id).toBe((await full.getAirport(id))?.siteNo ?? null);
    }
    const places: [string, number, number, number][] = [
      ['St. Catharines', 43.1916, -79.1717, 60],
      ['Miami', 25.796, -80.29, 60],
      ['the upper wind radius around Toronto', 43.6772, -79.6306, 150],
      // On a square's corner, so a question reaches into all four.
      ['a corner', 42, -80, 60],
      ['the antimeridian, between Shemya and Adak', 52, 179.9, 300],
    ];
    for (const [name, lat, lon, r] of places) {
      expect(ids(await store.listAirportsNear(lat, lon, r)), name).toEqual(ids(await full.listAirportsNear(lat, lon, r)));
    }
  }, 60_000);

  it('fetches only the squares a question is about, and each one once', async () => {
    const { store, loads } = catalog();
    await Promise.all([store.getAirport('KMIA'), store.getAirport('KMIA')]);
    expect(loads).toEqual([cellOf(25.796, -80.29)]);
    await store.getAirport('MIA');
    expect(loads).toHaveLength(1);
    expect(await store.getAirport('EGLL')).toBeNull();
    expect(loads).toHaveLength(1);
    await store.listAirportsNear(25.796, -80.29, 60);
    expect(loads.length).toBeLessThanOrEqual(6);
  });

  it('asks again for a square that did not arrive, rather than remembering it as empty', async () => {
    let fail = true;
    const store = new CatalogStore(index, async (cell) => {
      if (fail) throw new Error('offline');
      return read<AirportCell>(`${cell}.json`);
    });
    await expect(store.getAirport('KMIA')).rejects.toThrow('offline');
    fail = false;
    expect((await store.getAirport('KMIA'))?.name).toBe('Miami International Airport');
  });

  it('names a square for its south-west corner', () => {
    expect(cellOf(25.796, -80.29)).toBe('N24W082');
    expect(cellOf(43.19, -79.17)).toBe('N42W080');
    expect(cellOf(52.71, 174.11)).toBe('N52E174');
  });
});

describe('packing an airport', () => {
  const airports = readOurAirportsDirectory(join(FIXTURES, 'canada-2026-09-18', 'ourairports'), { snapshot: '2026-09-14' });

  it('gives back every OurAirports record exactly', () => {
    for (const a of airports) expect(unpackAirport(packAirport(a), { source: 'ourairports', snapshot: '2026-09-14' })).toEqual(a);
  });

  it('refuses a record it would lose part of', () => {
    expect(() => packAirport({ ...airports[0]!, magneticVariation: -10 })).toThrow(UnpackableAirportError);
  });
});
