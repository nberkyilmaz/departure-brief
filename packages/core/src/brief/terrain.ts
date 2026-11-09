/**
 * The ground under the route, for the side view.
 *
 * A station's elevation says how high the ground is at one aerodrome. Across
 * the Rockies that leaves two hundred miles with nothing known, which is the
 * stretch a pilot would most like to see. So the centre line is sampled
 * against a published elevation model, and the picture says what that is and
 * is not: spot heights along one line, not a clearance. A peak between two
 * samples, or a mile to the side, is not on it.
 *
 * Nothing here is a judgement, and it is kept out of the briefing for the
 * same reason the rest of the picture is. It also arrives later, from a
 * service that may not answer, and a briefing must not wait for it.
 */
import { distanceNm, pointAlong, type LatLon } from '../domain/geo.js';
import type { ElevationClient } from '../fetch/elevation.js';

/** Close enough to show a ridge at the scale of the chart. */
const SPACING_NM = 2;
/** Three requests' worth. A longer route is sampled more widely rather than asked for more. */
const MAX_SAMPLES = 300;
const FEET_PER_METRE = 1 / 0.3048;

export interface TerrainSample {
  /** From the departure, along the track. */
  readonly nm: number;
  readonly ft: number;
}

export interface RouteTerrain {
  readonly spacingNm: number;
  readonly samples: readonly TerrainSample[];
  readonly highest: TerrainSample;
}

/** Evenly spaced positions along a drawn line, both ends included. */
export function samplesAlong(line: readonly LatLon[]): { nm: number; position: LatLon }[] {
  const lengths = line.slice(1).map((p, i) => distanceNm(line[i]!, p) as number);
  const total = lengths.reduce((sum, l) => sum + l, 0);
  const steps = Math.max(1, Math.min(MAX_SAMPLES - 1, Math.ceil(total / SPACING_NM)));
  const out: { nm: number; position: LatLon }[] = [];
  let segment = 0;
  let start = 0;
  for (let i = 0; i <= steps; i++) {
    const nm = (total * i) / steps;
    while (segment < lengths.length - 1 && nm > start + lengths[segment]!) {
      start += lengths[segment]!;
      segment++;
    }
    const position = i === 0 ? line[0]! : i === steps ? line[line.length - 1]! : pointAlong(line[segment]!, line[segment + 1]!, nm - start);
    out.push({ nm, position });
  }
  return out;
}

export async function routeTerrain(client: ElevationClient, line: readonly LatLon[]): Promise<RouteTerrain> {
  const points = samplesAlong(line);
  const heights = await client.elevations(points.map((p) => p.position));
  const samples = points.map(({ nm }, i): TerrainSample => ({ nm, ft: Math.round(heights[i]! * FEET_PER_METRE) }));
  return { spacingNm: points[1]!.nm, samples, highest: samples.reduce((high, s) => (s.ft > high.ft ? s : high)) };
}
