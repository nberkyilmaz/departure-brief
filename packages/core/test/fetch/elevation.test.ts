/**
 * Open-Meteo's elevation API, over answers recorded from it on 9 November
 * 2026 for a flight from Vancouver to Calgary, and the refusal it gives for
 * a position that does not exist.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ELEVATION_BATCH, ElevationClient, ElevationError, OPEN_METEO_ELEVATION_URL } from '../../src/fetch/elevation.js';
import { HttpError, type HttpClient } from '../../src/fetch/response.js';

const DIR = join(__dirname, '..', 'fixtures', 'fetch', 'open-meteo', 'elevation-2026-11-09');
const read = <T>(name: string): T => JSON.parse(readFileSync(join(DIR, name), 'utf8')) as T;
const flight = read<{ url: string; status: number; body: string }[]>('CYVR-CYYC.json');

/** Answers by the exact URL they were recorded under, so a request that drifted finds nothing. */
function replay(): HttpClient & { asked: string[] } {
  const asked: string[] = [];
  return {
    asked,
    async get(url) {
      asked.push(url);
      const found = flight.find((r) => r.url === url);
      if (!found) throw new Error(`nothing recorded for ${url}`);
      return { status: found.status, body: found.body, headers: {} };
    },
  };
}

/** The positions the recorded requests asked about, read back out of them. */
const positions = flight.flatMap((r) => {
  const q = new URL(r.url).searchParams;
  const lons = q.get('longitude')!.split(',').map(Number);
  return q.get('latitude')!.split(',').map((lat, i) => ({ lat: Number(lat), lon: lons[i]! }));
});

describe('asking how high the ground is', () => {
  it('asks a hundred positions at a time and gives each height back in order', async () => {
    const http = replay();
    const heights = await new ElevationClient(http).elevations(positions);
    expect(positions.length).toBeGreaterThan(ELEVATION_BATCH);
    expect(http.asked).toEqual(flight.map((r) => r.url));
    expect(http.asked.every((u) => u.startsWith(OPEN_METEO_ELEVATION_URL))).toBe(true);
    expect(heights).toEqual(flight.flatMap((r) => (JSON.parse(r.body) as { elevation: number[] }).elevation));
    expect(heights).toHaveLength(positions.length);
  });

  it('reads the sea as nothing above it', async () => {
    const two = read<{ status: number; body: string }>('two-points-on-the-water.json');
    const client = new ElevationClient({ get: async () => ({ ...two, headers: {} }) });
    expect(await client.elevations([{ lat: 30, lon: -40 }, { lat: 49.3, lon: -124 }])).toEqual([0, 0]);
  });

  it('will not line up heights with positions when the counts differ', async () => {
    const two = read<{ status: number; body: string }>('two-points-on-the-water.json');
    const client = new ElevationClient({ get: async () => ({ ...two, headers: {} }) });
    await expect(client.elevations([{ lat: 30, lon: -40 }, { lat: 49.3, lon: -124 }, { lat: 45, lon: -80 }])).rejects.toBeInstanceOf(ElevationError);
  });

  it('raises the refusal it was given', async () => {
    const refused = read<{ status: number; body: string }>('bad-latitude.json');
    const client = new ElevationClient({ get: async () => ({ ...refused, headers: {} }) });
    const error = await client.elevations([{ lat: 999, lon: 0 }]).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(HttpError);
    expect((error as HttpError).status).toBe(400);
    expect((error as HttpError).body).toContain('Latitude must be in range');
  });
});
