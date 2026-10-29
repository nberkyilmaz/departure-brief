/**
 * Build the aerodromes the public site carries: every aeroplane field in
 * Canada and the United States, from one OurAirports snapshot.
 *
 * Download the two files into `data/raw/ourairports/<YYYY-MM-DD>/` (see
 * `src/fetch/ourairports.ts`) and run
 *
 *   npx tsx packages/core/scripts/build-airports.ts data/raw/ourairports/<YYYY-MM-DD>
 *
 * It writes an index of every field and one file per square of
 * `CELL_DEGREES` to `apps/web/public/demo/airports/`, replacing what is
 * there. Run `build-demo.ts` afterwards: the recorded briefing is built over
 * these same files, and has to be rebuilt when they change.
 */
import { deepStrictEqual } from 'node:assert';
import { mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import { packCatalog, unpackAirport } from '../src/demo/airports.js';
import { readOurAirportsDirectory } from '../src/fetch/ourairports.js';

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, '..', '..', '..', 'apps', 'web', 'public', 'demo', 'airports');

/*
 * Saint-Pierre and Miquelon too: two French fields off Newfoundland, inside
 * the Gander FIR, that a flight along that coast can use.
 */
const COUNTRIES = new Set(['CA', 'US', 'PM']);

const dir = process.argv[2];
if (!dir) throw new Error('usage: build-airports.ts <directory holding airports.csv and runways.csv>');
const snapshot = basename(resolve(dir));
if (!/^\d{4}-\d{2}-\d{2}$/.test(snapshot)) throw new Error(`the directory should be named for its snapshot date, YYYY-MM-DD, not "${snapshot}"`);

// Aeroplane fields only, as before: this is a tool for an aeroplane on wheels.
const airports = readOurAirportsDirectory(dir, { snapshot }).filter((a) => a.siteType === 'A' && COUNTRIES.has(a.country));
const { index, cells } = packCatalog(airports, snapshot);

// Every record comes back out exactly as it went in, or nothing is written.
const unpacked = new Map([...cells.values()].flatMap((c) => c.airports.map((p) => unpackAirport(p, c))).map((a) => [`${a.siteNo}|${a.siteType}`, a]));
for (const a of airports) deepStrictEqual(unpacked.get(`${a.siteNo}|${a.siteType}`), a);

mkdirSync(out, { recursive: true });
for (const f of readdirSync(out)) if (f.endsWith('.json')) rmSync(join(out, f));
const write = (name: string, value: unknown): number => {
  const body = JSON.stringify(value);
  writeFileSync(join(out, name), body + '\n');
  return gzipSync(body).length;
};
const indexGz = write('index.json', index);
let cellsGz = 0;
for (const [name, cell] of cells) cellsGz += write(`${name}.json`, cell);

const by = new Map<string, number>();
for (const a of airports) by.set(a.country, (by.get(a.country) ?? 0) + 1);
console.log(`${airports.length} aerodromes from OurAirports ${snapshot}: ${[...by].map(([c, n]) => `${n} ${c}`).join(', ')}`);
console.log(`  index: ${(indexGz / 1024).toFixed(0)} KB gzipped`);
console.log(`  ${cells.size} squares of ${index.cellDegrees}°: ${(cellsGz / 1024).toFixed(0)} KB gzipped in all, ${(cellsGz / cells.size / 1024).toFixed(1)} KB on average`);
