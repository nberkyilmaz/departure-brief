import type { FeetMsl, Knots } from './units.js';

/**
 * Airspace class at a waypoint, as the pilot states it until the airspace
 * layer (plan step 8) can derive it. Canadian terms for CARs, letters for
 * FAR 91.155.
 */
export type AirspaceClass = 'control-zone' | 'controlled' | 'uncontrolled' | 'B' | 'C' | 'D' | 'E' | 'G';

export const AIRSPACE_CLASSES: readonly AirspaceClass[] = ['control-zone', 'controlled', 'uncontrolled', 'B', 'C', 'D', 'E', 'G'];

/**
 * The most enroute waypoints a plan may name. Every one of them costs a
 * weather fetch and a set of findings, so an unbounded route is a way to
 * make this server work — and ask its upstreams for things — without limit.
 * A VFR cross-country that needs more than this wants to be two flights.
 */
export const MAX_ROUTE_WAYPOINTS = 25;

/**
 * What the pilot tells us about the flight. Times are Zulu ISO strings; the
 * route is a list of waypoint specs — an airport identifier (`KTEB`, `N07`)
 * or a `lat,lon` pair — excluding departure and destination.
 */
export interface FlightPlan {
  readonly departure: string;
  readonly destination: string;
  readonly alternate: string | null;
  readonly route: readonly string[];
  /** ISO 8601 with `Z`. */
  readonly departureTime: string;
  readonly cruise: {
    readonly tas: Knots;
    readonly altitude: FeetMsl;
  };
  /** Airspace class by waypoint id, when the pilot supplies it. */
  readonly airspace: Readonly<Record<string, AirspaceClass>> | null;
  /** Paths of the profile and aircraft files, relative to the plan, when given. */
  readonly profile: string | null;
  readonly aircraft: string | null;
}

/** Validate untrusted JSON into a FlightPlan, or throw with a message a pilot can act on. */
export function parseFlightPlan(input: unknown): FlightPlan {
  if (input === null || typeof input !== 'object') throw new Error('flight plan must be a JSON object');
  const o = input as Record<string, unknown>;
  const id = (key: string, required: boolean): string | null => {
    const v = o[key];
    if (v === undefined || v === null || v === '') {
      if (required) throw new Error(`flight plan: "${key}" is required`);
      return null;
    }
    if (typeof v !== 'string' || v.trim() === '') throw new Error(`flight plan: "${key}" must be a string`);
    return v.trim().toUpperCase();
  };
  const departure = id('departure', true)!;
  const destination = id('destination', true)!;
  const alternate = id('alternate', false);
  const route = o['route'] ?? [];
  if (!Array.isArray(route) || !route.every((r) => typeof r === 'string')) {
    throw new Error('flight plan: "route" must be an array of strings');
  }
  if (route.length > MAX_ROUTE_WAYPOINTS) {
    throw new Error(`flight plan: "route" has ${route.length} waypoints; ${MAX_ROUTE_WAYPOINTS} is the most this will plan`);
  }
  const departureTime = o['departureTime'];
  if (typeof departureTime !== 'string' || Number.isNaN(Date.parse(departureTime)) || !/Z$/.test(departureTime)) {
    throw new Error('flight plan: "departureTime" must be an ISO 8601 instant ending in Z');
  }
  const cruise = o['cruise'];
  if (cruise === null || typeof cruise !== 'object') throw new Error('flight plan: "cruise" is required');
  const c = cruise as Record<string, unknown>;
  if (typeof c['tas'] !== 'number' || !(c['tas'] > 0)) throw new Error('flight plan: "cruise.tas" must be a positive number of knots');
  if (typeof c['altitude'] !== 'number') throw new Error('flight plan: "cruise.altitude" must be a number of feet MSL');
  let airspace: Record<string, AirspaceClass> | null = null;
  if (o['airspace'] !== undefined && o['airspace'] !== null) {
    if (typeof o['airspace'] !== 'object') throw new Error('flight plan: "airspace" must be an object of waypoint id → class');
    airspace = {};
    for (const [k, v] of Object.entries(o['airspace'] as Record<string, unknown>)) {
      if (typeof v !== 'string' || !AIRSPACE_CLASSES.includes(v as AirspaceClass)) {
        throw new Error(`flight plan: airspace for "${k}" must be one of ${AIRSPACE_CLASSES.join(', ')}`);
      }
      airspace[k.trim().toUpperCase()] = v as AirspaceClass;
    }
  }
  const path = (key: string): string | null => (typeof o[key] === 'string' && (o[key] as string).trim() !== '' ? (o[key] as string).trim() : null);
  return {
    departure,
    destination,
    alternate,
    // Upper-cased like every other identifier here; a `lat,lon` pair is unaffected.
    route: route.map((r) => (r as string).trim().toUpperCase()),
    departureTime: new Date(departureTime).toISOString(),
    cruise: { tas: c['tas'] as Knots, altitude: c['altitude'] as FeetMsl },
    airspace,
    profile: path('profile'),
    aircraft: path('aircraft'),
  };
}
