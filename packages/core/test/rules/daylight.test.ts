/**
 * How much daylight is left on arrival — the question before "is this a
 * night flight", and the one that catches out a late afternoon departure.
 */
import { describe, expect, it } from 'vitest';
import { checkDaylight, THIN_MARGIN_MINUTES } from '../../src/rules/daylight.js';
import { solarEvents } from '../../src/domain/sun.js';

const CYKF = { lat: 43.4608, lon: -80.378601 };
/** Alert: the sun spends months not bothering with either end of the day. */
const CYLT = { lat: 82.5178, lon: -62.2806 };

const only = (findings: ReturnType<typeof checkDaylight>) => {
  expect(findings).toHaveLength(1);
  return findings[0]!;
};

/** Last light at Waterloo on the evening of 14 September 2026. */
const DUSK = solarEvents(CYKF, new Date('2026-09-14T12:00:00Z')).civilDusk!;

describe('checkDaylight', () => {
  it('says when last light is and how much of it is left', () => {
    const at = new Date(DUSK.getTime() - 4 * 3_600_000);
    const f = only(checkDaylight({ waypoint: 'CYKF', position: CYKF, at, nightAllowed: true }));
    expect(f.severity).toBe('ok');
    // Waterloo's last light that evening is after midnight Zulu, which is
    // the case the "next event" framing exists for.
    expect(f.summary).toMatch(/last light \d{2}:\d{2}Z/);
    expect(f.summary).toContain('4 h 0 min of daylight after arrival');
    expect(f.values['marginMinutes']).toBe(240);
  });

  it('speaks up when the margin is thin', () => {
    const at = new Date(DUSK.getTime() - 30 * 60_000);
    const f = only(checkDaylight({ waypoint: 'CYKF', position: CYKF, at, nightAllowed: true }));
    expect(f.severity).toBe('advisory');
    expect(f.values['marginMinutes']).toBe(30);
    // An hour is the line; either side of it behaves.
    const roomy = only(checkDaylight({ waypoint: 'CYKF', position: CYKF, at: new Date(DUSK.getTime() - (THIN_MARGIN_MINUTES + 5) * 60_000), nightAllowed: true }));
    expect(roomy.severity).toBe('ok');
  });

  it('says so when the pilot does not fly at night and the light is going', () => {
    const at = new Date(DUSK.getTime() - 20 * 60_000);
    const f = only(checkDaylight({ waypoint: 'CYKF', position: CYKF, at, nightAllowed: false }));
    expect(f.summary).toContain('does not fly at night');
    // Still advisory: whether twenty minutes is enough is the pilot's call,
    // and the night rules answer the legal half of it separately.
    expect(f.severity).toBe('advisory');
  });

  it('reports first light instead when it is already dark', () => {
    const at = new Date(DUSK.getTime() + 90 * 60_000);
    const f = only(checkDaylight({ waypoint: 'CYKF', position: CYKF, at, nightAllowed: true }));
    expect(f.summary).toMatch(/^night here; first light \d{2}:\d{2}Z/);
    expect(f.values['night']).toBe(true);
  });

  it('handles a sun that does not set, and one that does not rise', () => {
    const june = only(checkDaylight({ waypoint: 'CYLT', position: CYLT, at: new Date('2026-06-21T12:00:00Z'), nightAllowed: true }));
    expect(june.summary).toBe('the sun does not set here today');
    const december = only(checkDaylight({ waypoint: 'CYLT', position: CYLT, at: new Date('2026-12-21T12:00:00Z'), nightAllowed: true }));
    expect(december.summary).toContain('does not rise');
  });
});
