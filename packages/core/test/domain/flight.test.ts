/**
 * What a flight plan is allowed to say. These messages are shown to a pilot
 * and the limits are what stands between a public form and an unbounded
 * amount of work, so both are tested rather than assumed.
 */
import { describe, expect, it } from 'vitest';
import { MAX_ROUTE_WAYPOINTS, parseFlightPlan } from '../../src/domain/flight.js';

const base = {
  departure: 'cysn',
  destination: 'CYKF',
  departureTime: '2026-09-14T15:00:00Z',
  cruise: { tas: 105, altitude: 3500 },
};

describe('parseFlightPlan', () => {
  it('upper-cases identifiers and normalises the time', () => {
    const plan = parseFlightPlan({ ...base, route: [' cyhm '] });
    expect(plan.departure).toBe('CYSN');
    expect(plan.route).toEqual(['CYHM']);
    expect(plan.departureTime).toBe('2026-09-14T15:00:00.000Z');
    expect(plan.alternate).toBeNull();
  });

  it('refuses a route longer than it will plan, and says how long it was', () => {
    const route = Array.from({ length: MAX_ROUTE_WAYPOINTS + 1 }, (_, i) => `CY${i}`);
    expect(() => parseFlightPlan({ ...base, route })).toThrow(new RegExp(`${route.length} waypoints`));
    // The limit itself is allowed: it is a cap, not a target to stay under.
    expect(parseFlightPlan({ ...base, route: route.slice(0, MAX_ROUTE_WAYPOINTS) }).route).toHaveLength(MAX_ROUTE_WAYPOINTS);
  });

  it('names the field that is wrong', () => {
    expect(() => parseFlightPlan({ ...base, departure: '' })).toThrow(/"departure" is required/);
    expect(() => parseFlightPlan({ ...base, route: 'CYHM' })).toThrow(/"route" must be an array/);
    expect(() => parseFlightPlan({ ...base, departureTime: '2026-09-14 15:00' })).toThrow(/ending in Z/);
    expect(() => parseFlightPlan({ ...base, cruise: { tas: 0, altitude: 3500 } })).toThrow(/positive number of knots/);
    expect(() => parseFlightPlan({ ...base, airspace: { CYSN: 'class-bravo' } })).toThrow(/airspace for "CYSN"/);
  });
});
