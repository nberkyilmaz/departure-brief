/**
 * Which upper wind a place reads, and that a measured one says so. Over the
 * balloon files of 9 November 2026 and NAV CANADA's forecasts of 14
 * September, with the country's real aerodromes.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CatalogStore, type AirportIndex, type AirportCell } from '../../src/demo/airports.js';
import { soundingStation } from '../../src/domain/soundings.js';
import { soundingReport } from '../../src/fetch/soundings.js';
import { balloonWindAt, isAmerican, SOUNDING_RADIUS_NM, windAt } from '../../src/resolve/wind.js';
import { checkWindAloft } from '../../src/rules/windAloft.js';
import { storeAndDecode } from '../../src/store/decode.js';

const FIXTURES = join(__dirname, '..', 'fixtures', 'fetch');
const DIR = join(FIXTURES, 'noaa', 'soundings-2026-11-09');
const DEMO = join(__dirname, '..', '..', '..', '..', 'apps', 'web', 'public', 'demo', 'airports');
const MODIFIED = JSON.parse(readFileSync(join(DIR, 'last-modified.json'), 'utf8')) as Record<string, string>;
const RECORDED = new Date('2026-11-09T04:53:45Z');
const SOON = new Date('2026-11-09T06:00:00Z');
const ALBANY = { lat: 42.748, lon: -73.802 };

async function seeded(skip: readonly string[] = []): Promise<CatalogStore> {
  const index = JSON.parse(readFileSync(join(DEMO, 'index.json'), 'utf8')) as AirportIndex;
  const store = new CatalogStore(index, async (name) => JSON.parse(readFileSync(join(DEMO, `${name}.json`), 'utf8')) as AirportCell);
  const reports = readdirSync(DIR)
    .filter((n) => n.endsWith('.txt') && !skip.some((s) => n.includes(s)))
    .flatMap((n) => soundingReport(readFileSync(join(DIR, n), 'latin1'), new Date(MODIFIED[n] ?? RECORDED)) ?? []);
  await storeAndDecode(store, reports, 'recorded', RECORDED);
  return store;
}

describe('a US field', () => {
  it('reads the nearest balloon, and says it was measured', async () => {
    const store = await seeded();
    const w = (await windAt(store, ALBANY, 'KALB', 6500, SOON, RECORDED))!;
    expect(w.station).toBe('72518');
    expect(w.measured).toEqual({ by: 'Albany', at: new Date('2026-11-09T00:00:00Z') });
    expect(w.wind).toMatchObject({ directionTrue: 271, speedKt: 27, basis: 'interpolated' });
    expect(Math.round(w.distance)).toBe(0);
  });

  it('passes to the next balloon when the nearest reported nothing', async () => {
    // Omaha's 00Z file holds no levels at all.
    const store = await seeded();
    const valley = soundingStation('72558')!;
    const w = (await balloonWindAt(store, valley, 6500, SOON, RECORDED))!;
    expect(w.station).not.toBe('72558');
    expect(w.distance).toBeGreaterThan(50);
  });

  it('has none past eighteen hours after the balloon flew', async () => {
    const store = await seeded();
    expect(await windAt(store, ALBANY, 'KALB', 6500, new Date('2026-11-09T17:59:00Z'), RECORDED)).not.toBeNull();
    expect(await windAt(store, ALBANY, 'KALB', 6500, new Date('2026-11-09T18:00:00Z'), RECORDED)).toBeNull();
  });

  it('knows nothing of a sounding that had not been recorded by the briefing', async () => {
    const store = await seeded();
    expect(await windAt(store, ALBANY, 'KALB', 6500, SOON, new Date('2026-11-09T04:00:00Z'))).toBeNull();
  });

  it('has none out of reach of every balloon', async () => {
    const store = await seeded();
    expect(await balloonWindAt(store, { lat: 61.2, lon: -149.9 }, 6500, SOON, RECORDED)).toBeNull();
    expect(SOUNDING_RADIUS_NM).toBe(200);
  });

  it('is told so in the finding, with the balloon and the hour', async () => {
    const store = await seeded();
    const w = (await windAt(store, ALBANY, 'KALB', 6500, SOON, RECORDED))!;
    const [finding] = checkWindAloft({ waypoint: 'KALB', at: SOON, cruiseAltitude: 6500 }, w);
    expect(finding!.summary).toBe('wind at 6,500 ft: 271°T at 27 kt, -1 °C, measured by the Albany balloon at 00Z');
    expect(finding!.basis).toBe('measured upper wind');
    expect(finding!.values).toMatchObject({ measuredBy: 'Albany', measuredAt: '2026-11-09T00:00:00.000Z' });
  });

  it('says how far away the balloon was', async () => {
    const store = await seeded();
    const boston = { lat: 42.364, lon: -71.005 };
    const w = (await windAt(store, boston, 'KBOS', 6500, SOON, RECORDED))!;
    const [finding] = checkWindAloft({ waypoint: 'KBOS', at: SOON, cruiseAltitude: 6500 }, w);
    expect(finding!.summary).toMatch(/measured by the Gray balloon at 00Z, 97 nm away$/);
  });
});

describe('which country a place is in', () => {
  it('goes by the named field, or the nearest one', async () => {
    const store = await seeded();
    expect(await isAmerican(store, ALBANY, 'KALB')).toBe(true);
    expect(await isAmerican(store, { lat: 43.68, lon: -79.63 }, 'CYYZ')).toBe(false);
    expect(await isAmerican(store, ALBANY, null)).toBe(true);
  });

  it('leaves a Canadian field with no forecast in store to the balloon across the border, rather than nothing', async () => {
    const store = await seeded();
    // No forecasts were stored here. Buffalo is 60 nm from Toronto.
    const w = (await windAt(store, { lat: 43.68, lon: -79.63 }, 'CYYZ', 6500, SOON, RECORDED))!;
    expect(w.measured?.by).toBe('Buffalo');
  });
});
