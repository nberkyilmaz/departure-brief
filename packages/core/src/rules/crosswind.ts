import type { Wind } from '../decode/groups/wind.js';
import { windKnots } from '../decode/metar/derive.js';
import type { Airport, RunwayEnd } from '../domain/airport.js';
import type { DegreesTrue, Knots } from '../domain/units.js';
import { kt } from '../domain/units.js';

/** Wind components on one runway end. Positive headwind; negative is tailwind. */
export interface RunwayWind {
  readonly runway: string;
  readonly end: string;
  readonly heading: DegreesTrue;
  /** From the sustained speed. */
  readonly crosswind: Knots;
  readonly headwind: Knots;
  /** From the gust speed when one is reported, else equal to `crosswind`. */
  readonly crosswindGust: Knots;
  readonly headwindGust: Knots;
}

export interface CrosswindAnalysis {
  /** Speeds in knots as evaluated. */
  readonly speed: Knots;
  readonly gust: Knots | null;
  /** `VRB`: components are the full speed on every runway (worst case). */
  readonly variable: boolean;
  readonly calm: boolean;
  /** Every runway end with a known heading, best (lowest gust crosswind) first. */
  readonly runways: readonly RunwayWind[];
  /** Runway ends skipped for lack of a true heading. */
  readonly unknownHeading: readonly string[];
}

const rad = (d: number) => (d * Math.PI) / 180;

/** Components of a wind on a runway heading; both true. */
export function components(windFrom: DegreesTrue, speed: Knots, heading: DegreesTrue): { crosswind: Knots; headwind: Knots } {
  const angle = rad(windFrom - heading);
  return { crosswind: kt(Math.abs(speed * Math.sin(angle))), headwind: kt(speed * Math.cos(angle)) };
}

/**
 * Wind against every runway end of an airport. Returns `null` when the wind
 * direction is not reported (`///`) — that is a finding for the caller, not
 * a zero.
 */
export function analyseCrosswind(wind: Wind, airport: Airport): CrosswindAnalysis | null {
  const { speed, gust } = windKnots(wind);
  if (speed === null) return null;
  const variable = wind.direction === 'VRB';
  if (wind.direction === null) return null;
  const calm = speed === 0 && (gust === null || gust === 0);
  const runways: RunwayWind[] = [];
  const unknownHeading: string[] = [];
  for (const r of airport.runways) {
    for (const end of r.ends) {
      if (end.trueHeading === null) {
        unknownHeading.push(end.id);
        continue;
      }
      runways.push(runwayWind(r.id, end, wind.direction, speed, gust, variable));
    }
  }
  // Reciprocal ends have equal crosswind up to floating point; break the tie on headwind.
  const near = (x: number, y: number) => Math.abs(x - y) < 0.01;
  runways.sort((a, b) =>
    near(a.crosswindGust, b.crosswindGust) ? b.headwindGust - a.headwindGust : a.crosswindGust - b.crosswindGust,
  );
  return { speed, gust, variable, calm, runways, unknownHeading };
}

function runwayWind(
  runway: string,
  end: RunwayEnd,
  from: DegreesTrue | 'VRB',
  speed: Knots,
  gust: Knots | null,
  variable: boolean,
): RunwayWind {
  const heading = end.trueHeading!;
  if (variable || from === 'VRB') {
    // Direction unknown: the whole speed may be across any runway.
    return {
      runway,
      end: end.id,
      heading,
      crosswind: speed,
      headwind: kt(0),
      crosswindGust: gust ?? speed,
      headwindGust: kt(0),
    };
  }
  const sustained = components(from, speed, heading);
  const g = gust === null ? sustained : components(from, gust, heading);
  return {
    runway,
    end: end.id,
    heading,
    crosswind: sustained.crosswind,
    headwind: sustained.headwind,
    crosswindGust: g.crosswind,
    headwindGust: g.headwind,
  };
}
