/**
 * Whether what is aboard covers what the regulation requires.
 *
 * One finding, on the destination, because that is where the reserve has
 * to still be in the tanks. It reads the fuel plan and says what it says:
 * short by so much, or covered with so much to spare, or not computable
 * because a number is missing. It does not say whether to go — the
 * regulation is a floor, and a pilot with exactly the legal minimum and a
 * headwind that has not been forecast is the person this line is written
 * for.
 */
import type { FuelPlan } from '../navlog/fuel.js';
import type { Citation, Finding } from './types.js';

export interface FuelContext {
  /** The destination — the point the reserve has to survive to. */
  readonly waypoint: string;
  /** The destination ETA. */
  readonly at: Date;
  /** Which point made this a night flight, for the citation; null by day. */
  readonly nightAt: string | null;
}

/**
 * The fuel finding. Always one, so a pilot reading the destination sees a
 * line about fuel whether or not there was enough of it — and whether or
 * not there was enough information to say.
 */
export function checkFuel(ctx: FuelContext, plan: FuelPlan): Finding[] {
  /*
   * No report behind this one: it is the nav log's arithmetic against the
   * plan's own numbers. So it cites the plan and the regulation, which is
   * what it was derived from — the same standard every other finding is
   * held to, not an exemption from it.
   */
  const citations: Citation[] = [
    {
      kind: 'plan',
      station: ctx.waypoint,
      raw: null,
      span: null,
      text: `${plan.reserve.rule}: ${plan.reserve.minutes} min at cruise after the destination${ctx.nightAt ? ` (night at ${ctx.nightAt})` : ''}`,
      sha256: null,
    },
  ];
  const base = {
    waypoint: ctx.waypoint,
    basis: 'fuel',
    basisKind: 'plan' as const,
    at: ctx.at.toISOString(),
    citations,
  };

  if (plan.requiredGal === null || plan.aboardGal === null) {
    return [
      {
        ...base,
        rule: 'fuel.inputs',
        attention: 'note',
        summary: `no fuel plan: ${plan.gaps.join('; ')}`,
        values: { gaps: plan.gaps, tripGal: plan.tripGal, reserveGal: plan.reserve.gal, aboardGal: plan.aboardGal },
      },
    ];
  }

  const values = {
    tripGal: plan.tripGal,
    reserveMinutes: plan.reserve.minutes,
    reserveGal: plan.reserve.gal,
    requiredGal: plan.requiredGal,
    withAlternateGal: plan.withAlternateGal,
    aboardGal: plan.aboardGal,
    marginGal: plan.marginGal,
    marginMinutes: plan.marginMinutes,
  };
  const parts = `${plan.tripGal} gal for the trip and ${plan.reserve.gal} gal for the ${plan.reserve.minutes}-minute ${plan.reserve.basis} reserve (${plan.reserve.rule})`;

  if (plan.marginGal !== null && plan.marginGal < 0) {
    return [
      {
        ...base,
        rule: 'fuel.reserve',
        attention: 'alert',
        summary: `fuel aboard ${plan.aboardGal} gal is ${Math.abs(plan.marginGal)} gal short of the ${plan.requiredGal} gal required — ${parts}`,
        values,
      },
    ];
  }

  const spare = plan.marginMinutes === null ? `${plan.marginGal} gal` : `${plan.marginGal} gal, ${plan.marginMinutes} min at cruise`;
  const alternate = plan.withAlternateGal !== null ? `; reaching the alternate as well would take ${plan.withAlternateGal} gal` : '';
  return [
    {
      ...base,
      rule: 'fuel.reserve',
      attention: 'routine',
      summary: `fuel aboard ${plan.aboardGal} gal covers the ${plan.requiredGal} gal required with ${spare} to spare — ${parts}${alternate}`,
      values,
    },
  ];
}
