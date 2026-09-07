import type { FeetAgl, Knots, StatuteMiles } from './units.js';

/**
 * A pilot's personal minimums. These are the pilot's own numbers, usually
 * stricter than any regulation and always distinct from the aircraft's
 * limits. Versioned so a briefing can say which profile it was judged
 * against.
 */
export interface PilotProfile {
  readonly version: number;
  readonly name: string;
  /** Lowest acceptable ceiling, feet AGL. */
  readonly ceiling: FeetAgl;
  readonly visibility: StatuteMiles;
  /** Highest acceptable crosswind component. */
  readonly crosswind: Knots;
  /** Whether the crosswind limit is judged against the gust speed when one is reported. */
  readonly crosswindIncludesGust: boolean;
  /** Largest acceptable gust spread (gust − sustained); `null` for no limit. */
  readonly maxGustSpread: Knots | null;
  readonly nightAllowed: boolean;
}

/** What the POH says. `null` until the figure is known — never guessed. */
export interface AircraftLimits {
  readonly type: string;
  readonly demonstratedCrosswind: Knots | null;
}

function positive(o: Record<string, unknown>, key: string): number {
  const v = o[key];
  if (typeof v !== 'number' || !(v > 0)) throw new Error(`profile: "${key}" must be a positive number`);
  return v;
}

export function parsePilotProfile(input: unknown): PilotProfile {
  if (input === null || typeof input !== 'object') throw new Error('profile must be a JSON object');
  const o = input as Record<string, unknown>;
  const spread = o['maxGustSpreadKt'];
  return {
    version: typeof o['version'] === 'number' ? o['version'] : 1,
    name: typeof o['name'] === 'string' ? o['name'] : 'unnamed',
    ceiling: positive(o, 'ceilingAglFt') as FeetAgl,
    visibility: positive(o, 'visibilitySm') as StatuteMiles,
    crosswind: positive(o, 'crosswindKt') as Knots,
    crosswindIncludesGust: o['crosswindIncludesGust'] !== false,
    maxGustSpread: typeof spread === 'number' && spread > 0 ? (spread as Knots) : null,
    nightAllowed: o['nightAllowed'] !== false,
  };
}

export function parseAircraftLimits(input: unknown): AircraftLimits {
  if (input === null || typeof input !== 'object') throw new Error('aircraft must be a JSON object');
  const o = input as Record<string, unknown>;
  if (typeof o['type'] !== 'string' || o['type'].trim() === '') throw new Error('aircraft: "type" is required');
  const x = o['demonstratedCrosswindKt'];
  return {
    type: o['type'].trim(),
    demonstratedCrosswind: typeof x === 'number' && x > 0 ? (x as Knots) : null,
  };
}
