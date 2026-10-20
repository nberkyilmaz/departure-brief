/**
 * The sun's day, checked against itself rather than against a table.
 *
 * A published sunrise time would be a fixture whose provenance is somebody
 * else's arithmetic. What can be checked exactly is that the instants this
 * returns are the instants where the elevation crosses the boundary it
 * claims — and that the day either side of each one is on the right side
 * of it.
 */
import { describe, expect, it } from 'vitest';
import { CIVIL_TWILIGHT_ELEVATION, HORIZON_ELEVATION, isNight, solarElevation, solarEvents } from '../../src/domain/sun.js';

const CYSN = { lat: 43.191598, lon: -79.171686 };
/** Iqaluit: far enough north for the sun to misbehave. */
const CYFB = { lat: 63.7564, lon: -68.5558 };
/** Alert, the northernmost inhabited place there is. */
const CYLT = { lat: 82.5178, lon: -62.2806 };

const minutes = (a: Date, b: Date) => Math.abs(a.getTime() - b.getTime()) / 60_000;

describe('solarEvents', () => {
  it('puts each event exactly where the elevation crosses its boundary', () => {
    const e = solarEvents(CYSN, new Date('2026-09-14T12:00:00Z'))!;
    for (const [at, boundary] of [
      [e.sunrise!, HORIZON_ELEVATION],
      [e.sunset!, HORIZON_ELEVATION],
      [e.civilDawn!, CIVIL_TWILIGHT_ELEVATION],
      [e.civilDusk!, CIVIL_TWILIGHT_ELEVATION],
    ] as const) {
      expect(solarElevation(CYSN, at)).toBeCloseTo(boundary, 2);
      // And the minute either side is on the side it should be.
      const before = solarElevation(CYSN, new Date(at.getTime() - 60_000));
      const after = solarElevation(CYSN, new Date(at.getTime() + 60_000));
      expect(Math.sign(before - boundary)).not.toBe(Math.sign(after - boundary));
    }
  });

  it('answers with the next of each, in the order they come', () => {
    // Midday Zulu is morning in Ontario, so the sun sets this evening and
    // rises again tomorrow — the next sunrise is after the next sunset.
    const e = solarEvents(CYSN, new Date('2026-09-14T12:00:00Z'));
    expect(e.sunset!.getTime()).toBeLessThan(e.civilDusk!.getTime());
    expect(e.civilDawn!.getTime()).toBeLessThan(e.sunrise!.getTime());
    expect(e.sunset!.getTime()).toBeGreaterThan(new Date('2026-09-14T12:00:00Z').getTime());
    // In June the same place's last light lands after midnight Zulu, which
    // is exactly why these are "next" rather than "today's": asked for the
    // 21st, the answer is on the 22nd, and it is still that evening's.
    const june = solarEvents(CYSN, new Date('2026-06-21T12:00:00Z'));
    expect(june.civilDusk!.toISOString().slice(0, 10)).toBe('2026-06-22');
    expect(june.sunset!.toISOString().slice(0, 10)).toBe('2026-06-22');
    // Civil twilight is about half an hour at this latitude.
    expect(minutes(e.sunset!, e.civilDusk!)).toBeGreaterThan(20);
    expect(minutes(e.sunset!, e.civilDusk!)).toBeLessThan(45);
  });

  it('agrees with the night rule it shares its arithmetic with', () => {
    const e = solarEvents(CYSN, new Date('2026-09-14T12:00:00Z'));
    expect(isNight(CYSN, new Date(e.civilDusk!.getTime() + 60_000))).toBe(true);
    expect(isNight(CYSN, new Date(e.civilDusk!.getTime() - 60_000))).toBe(false);
    expect(isNight(CYSN, new Date(e.civilDawn!.getTime() - 60_000))).toBe(true);
    expect(isNight(CYSN, new Date(e.civilDawn!.getTime() + 60_000))).toBe(false);
  });

  it('says when the sun does not set, and when it does not rise', () => {
    // Alert in June: the sun never goes down. In December it never comes up.
    const june = solarEvents(CYLT, new Date('2026-06-21T12:00:00Z'));
    expect(june.allDay).toBe(true);
    expect(june.sunset).toBeNull();
    const december = solarEvents(CYLT, new Date('2026-12-21T12:00:00Z'));
    expect(december.allNight).toBe(true);
    expect(december.sunrise).toBeNull();
  });

  it('handles a northern day that still has both ends', () => {
    const e = solarEvents(CYFB, new Date('2026-09-14T12:00:00Z'));
    expect(e.sunrise).not.toBeNull();
    expect(e.sunset).not.toBeNull();
    expect(e.allDay).toBe(false);
    expect(e.allNight).toBe(false);
    // Twilight lasts longer the further north you go.
    expect(minutes(e.sunset!, e.civilDusk!)).toBeGreaterThan(30);
  });
});
