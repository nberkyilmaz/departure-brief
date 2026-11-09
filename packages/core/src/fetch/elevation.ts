/**
 * The height of the ground at a list of positions, from Open-Meteo's
 * elevation API: the Copernicus GLO-90 model, 90 metres between points, with
 * no key.
 *
 * Unlike the weather services it sends CORS headers, so a page calls it
 * directly and not through the relay. There would be nothing for the relay
 * to keep: every route asks a different question, and the free allowance is
 * per caller, so a visitor's questions count against that visitor's own.
 *
 * Open-Meteo's terms require a credit to the Copernicus programme and a
 * reference to Open-Meteo wherever this is shown.
 */
import type { LatLon } from '../domain/geo.js';
import { expectOk, type HttpClient } from './response.js';

export const OPEN_METEO_ELEVATION_URL = 'https://api.open-meteo.com/v1/elevation';
/** The most positions the service takes in one request. */
export const ELEVATION_BATCH = 100;

export class ElevationError extends Error {
  constructor(
    message: string,
    readonly url: string,
  ) {
    super(message);
    this.name = 'ElevationError';
  }
}

/** To about ten metres, finer than the model it is asking. */
const coordinate = (n: number): string => n.toFixed(4);

export class ElevationClient {
  constructor(
    private readonly http: HttpClient,
    private readonly url: string = OPEN_METEO_ELEVATION_URL,
  ) {}

  /** Metres above sea level for each position, in order. */
  async elevations(points: readonly LatLon[]): Promise<number[]> {
    const out: number[] = [];
    for (let i = 0; i < points.length; i += ELEVATION_BATCH) {
      const batch = points.slice(i, i + ELEVATION_BATCH);
      const url = `${this.url}?latitude=${batch.map((p) => coordinate(p.lat)).join(',')}&longitude=${batch.map((p) => coordinate(p.lon)).join(',')}`;
      const res = expectOk(url, await this.http.get(url, { headers: { Accept: 'application/json' } }));
      let parsed: { elevation?: unknown };
      try {
        parsed = JSON.parse(res.body) as { elevation?: unknown };
      } catch {
        throw new ElevationError('response is not JSON', url);
      }
      const heights = parsed.elevation;
      if (!Array.isArray(heights) || heights.length !== batch.length || !heights.every((h) => typeof h === 'number' && Number.isFinite(h))) {
        throw new ElevationError(`asked for ${batch.length} heights and did not get them`, url);
      }
      out.push(...(heights as number[]));
    }
    return out;
  }
}
