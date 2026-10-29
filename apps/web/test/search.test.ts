/**
 * Seventeen thousand fields share a lot of names. What someone types should
 * find the one they mean first: the identifier itself, either kind, then
 * the field that reports weather over the private strip named after it.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { AirportIndex } from '@depbrief/core/judge';
import type { Aerodrome } from '../src/engine.js';
import { aerodromeSearch } from '../src/search.js';

const index = JSON.parse(readFileSync(join(__dirname, '..', 'public', 'demo', 'airports', 'index.json'), 'utf8')) as AirportIndex;
const all: Aerodrome[] = index.airports.map(([icao, faa, name, lat, lon]) => ({ id: icao || faa, faaId: icao && faa !== icao ? faa : null, name, lat, lon }));
const search = aerodromeSearch(all, new Set(['KMIA', 'KTMB', 'KOPF', 'CYYZ', 'CYTZ']));
const ids = (q: string, limit?: number) => search(q, limit).map((a) => a.id);

describe('looking up an aerodrome', () => {
  it('puts the identifier itself first, ICAO or FAA', () => {
    expect(ids('KMIA')[0]).toBe('KMIA');
    expect(ids('mia')[0]).toBe('KMIA');
    expect(ids('CYSN')[0]).toBe('CYSN');
  });

  it('puts fields that report weather ahead of the ones that only share a name', () => {
    expect(ids('Miami', 3)).toEqual(['KMIA', 'KOPF', 'KTMB']);
    expect(ids('Toronto', 2).sort()).toEqual(['CYTZ', 'CYYZ']);
  });

  it('finds nothing for nothing', () => {
    expect(search('  ')).toEqual([]);
  });
});
