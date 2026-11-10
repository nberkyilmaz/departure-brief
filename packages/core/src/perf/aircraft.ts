/**
 * The handbook's performance tables, put to the aircraft and the form.
 */
import { readCruise } from './read.js';
import type { PerformanceSpec } from './types.js';

/**
 * The tables, when they are for the aircraft being flown. The type decides,
 * as it names the aeroplane everywhere else; a burn table for a 172 applied
 * to a Cherokee would be a fuel plan for the wrong aeroplane.
 */
export function performanceFor(aircraft: { readonly type: string }, spec: PerformanceSpec | null): PerformanceSpec | null {
  return spec && spec.aircraftType.toUpperCase() === aircraft.type.trim().toUpperCase() ? spec : null;
}

/** The power settings the cruise table prints at every row either side of an altitude, highest first. */
export function rpmsAt(spec: PerformanceSpec, altitudeFt: number): number[] {
  const all = [...new Set(spec.cruise.rows.map((r) => r.rpm))].sort((a, b) => b - a);
  return all.filter((rpm) => !('problem' in readCruise(spec.cruise, altitudeFt, null, rpm)));
}

/**
 * What a power setting gives before the temperature at cruise is known:
 * the lowest speed and the range of burns across every column either side
 * of the altitude. The speed is what the form puts in the true airspeed
 * box; the briefing reads the burn again for each leg's temperature.
 */
export function cruiseAtAnyTemperature(
  spec: PerformanceSpec,
  altitudeFt: number,
  rpm: number,
): { readonly ktas: number; readonly gphLow: number; readonly gphHigh: number } | { readonly problem: string } {
  const read = readCruise(spec.cruise, altitudeFt, null, rpm);
  if ('problem' in read) return read;
  return { ktas: read.ktas, gphLow: Math.min(...read.around.map((c) => c.gph)), gphHigh: read.gph };
}
