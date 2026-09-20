import { describe, expect, it } from 'vitest';
import type { FuelPlan } from '../../src/navlog/fuel.js';
import { checkFuel } from '../../src/rules/fuel.js';

/**
 * The fuel line on the destination.
 *
 * It says what the plan says and stops: short by so much, covered with so
 * much to spare, or not computable because a number is missing. Never
 * whether to go.
 */

const AT = new Date('2026-09-14T16:00:00Z');
const ctx = { waypoint: 'CYKF', at: AT, nightAt: null };

const plan = (over: Partial<FuelPlan> = {}): FuelPlan => ({
  tripGal: 8,
  alternateGal: null,
  reserve: { minutes: 30, basis: 'day', rule: 'CARs 602.88(3)', gal: 4 },
  requiredGal: 12,
  withAlternateGal: null,
  aboardGal: 20,
  marginGal: 8,
  marginMinutes: 60,
  gaps: [],
  ...over,
});

const only = (findings: ReturnType<typeof checkFuel>) => {
  expect(findings).toHaveLength(1);
  return findings[0]!;
};

describe('checkFuel', () => {
  it('reports the margin, with every number it came from, when there is enough', () => {
    const f = only(checkFuel(ctx, plan()));
    expect(f.rule).toBe('fuel.reserve');
    expect(f.attention).toBe('routine');
    expect(f.summary).toBe(
      'fuel aboard 20 gal covers the 12 gal required with 8 gal, 60 min at cruise to spare — 8 gal for the trip and 4 gal for the 30-minute day reserve (CARs 602.88(3))',
    );
    expect(f.waypoint).toBe('CYKF');
    expect(f.basisKind).toBe('plan');
    expect(f.values).toMatchObject({ tripGal: 8, reserveGal: 4, requiredGal: 12, aboardGal: 20, marginGal: 8 });
  });

  it('is an alert when what is aboard does not cover the requirement', () => {
    const f = only(checkFuel(ctx, plan({ aboardGal: 10, marginGal: -2, marginMinutes: -15 })));
    expect(f.rule).toBe('fuel.reserve');
    expect(f.attention).toBe('alert');
    expect(f.summary).toBe('fuel aboard 10 gal is 2 gal short of the 12 gal required — 8 gal for the trip and 4 gal for the 30-minute day reserve (CARs 602.88(3))');
  });

  it('never says whether to go', () => {
    for (const p of [plan(), plan({ aboardGal: 10, marginGal: -2, marginMinutes: -15 }), plan({ requiredGal: null, gaps: ['x'] })]) {
      const text = checkFuel(ctx, p)[0]!.summary.toLowerCase();
      for (const forbidden of ['go', 'no-go', 'safe', 'unsafe', 'ok to', 'fits', 'legal', 'illegal', 'sufficient', 'insufficient']) {
        expect(text.split(/\W+/)).not.toContain(forbidden);
      }
    }
  });

  it('cites the regulation and which subsection, and the point that made it night', () => {
    const night = only(checkFuel({ ...ctx, nightAt: 'CYKF' }, plan({ reserve: { minutes: 45, basis: 'night', rule: 'CARs 602.88(4)', gal: 6 }, requiredGal: 14, marginGal: 6, marginMinutes: 45 })));
    expect(night.citations).toHaveLength(1);
    expect(night.citations[0]!.kind).toBe('plan');
    expect(night.citations[0]!.text).toBe('CARs 602.88(4): 45 min at cruise after the destination (night at CYKF)');
    expect(night.summary).toContain('45-minute night reserve (CARs 602.88(4))');
  });

  it('mentions the alternate when one is planned, as a separate figure', () => {
    const f = only(checkFuel(ctx, plan({ alternateGal: 4, withAlternateGal: 16 })));
    expect(f.summary).toContain('reaching the alternate as well would take 16 gal');
    expect(f.values['withAlternateGal']).toBe(16);
  });

  it('is a note saying what is missing when the plan could not be made', () => {
    const f = only(checkFuel(ctx, plan({ requiredGal: null, marginGal: null, marginMinutes: null, gaps: ['no fuel aboard given in the flight plan'] })));
    expect(f.rule).toBe('fuel.inputs');
    expect(f.attention).toBe('note');
    expect(f.summary).toBe('no fuel plan: no fuel aboard given in the flight plan');
  });

  it('is still one line, not none, when nothing at all is known', () => {
    const f = only(
      checkFuel(
        ctx,
        plan({
          tripGal: null,
          reserve: { minutes: 30, basis: 'day', rule: 'CARs 602.88(3)', gal: null },
          requiredGal: null,
          aboardGal: null,
          marginGal: null,
          marginMinutes: null,
          gaps: ['no cruise burn rate in the aircraft file, so neither the trip fuel nor the reserve can be worked out', 'no fuel aboard given in the flight plan'],
        }),
      ),
    );
    expect(f.rule).toBe('fuel.inputs');
    expect(f.summary).toContain('no cruise burn rate');
    expect(f.summary).toContain('no fuel aboard');
  });
});
