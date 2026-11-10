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
import type { NavLog } from '../navlog/compute.js';
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

const UNSCANNED = 'read from the page image; the scan does not show it, so check it against your handbook';

/**
 * The handbook lines the plan rests on: the cruise cell the reserve's burn
 * is, the climb rows and the allowance note. A figure the scan did not bear
 * out says so in its citation, where the pilot reading the source sees it.
 */
function handbookCitations(log: NavLog): Citation[] {
  const h = log.handbook;
  if (!h) return [];
  const cite = (text: string): Citation => ({ kind: 'aircraft', station: null, raw: null, span: null, text: `${h.filename} ${text}`, sha256: h.sha256 });
  const out: Citation[] = [];
  const burnLeg = log.legs.find((l) => l.burn?.handbook && l.burn.gph === log.fuelGph);
  const cell = burnLeg?.burn?.handbook?.burnCell;
  if (cell) {
    const column = cell.columnC === 0 ? 'standard temperature' : `${Math.abs(cell.columnC)} °C ${cell.columnC > 0 ? 'above' : 'below'} standard`;
    out.push(
      cite(
        `p.${h.cruiseTable.page} (${h.cruiseTable.printedPage}), ${h.cruiseTable.figure}: ${cell.pressureAltitudeFt.toLocaleString('en')} ft, ${cell.rpm} RPM, ${column}: ${cell.gph} gal/h${cell.scanned.gph ? '' : ` — ${UNSCANNED}`}`,
      ),
    );
  }
  if (h.climb) {
    const from = h.climb.fromRowFt === 0 ? 'sea level' : `${h.climb.fromRowFt.toLocaleString('en')} ft`;
    out.push(
      cite(
        `p.${h.climbTable.page} (${h.climbTable.printedPage}), ${h.climbTable.figure}: ${from} to ${h.climb.toRowFt.toLocaleString('en')} ft, ${h.climb.gal} gal${h.climb.percent > 0 ? ` with ${h.climb.percent}% for ${h.climb.deviationC} °C above standard` : ''}`,
      ),
    );
  }
  out.push(cite(`p.${h.climbTable.page} (${h.climbTable.printedPage}), note 1: "${h.allowance.printed}"${h.allowance.scanned ? '' : ` — ${UNSCANNED}`}`));
  return out;
}

/** Where the burn came from, in words. */
function burnWords(log: NavLog): string {
  const leg = log.legs.find((l) => l.burn && l.burn.gph === log.fuelGph);
  if (!leg?.burn) return '';
  return leg.burn.source === 'aircraft'
    ? ` at ${leg.burn.gph} gal/h, the burn typed into the aircraft settings`
    : ` at ${leg.burn.gph} gal/h, the highest of the handbook's figures for ${leg.burn.handbook!.rpm} RPM around this flight`;
}

/**
 * The fuel finding. Always one, so a pilot reading the destination sees a
 * line about fuel whether or not there was enough of it — and whether or
 * not there was enough information to say.
 */
export function checkFuel(ctx: FuelContext, plan: FuelPlan, log: NavLog): Finding[] {
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
    ...handbookCitations(log),
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
    allowanceGal: plan.allowanceGal,
    climbGal: plan.climbGal,
    cruiseGal: plan.cruiseGal,
    burnGph: log.fuelGph,
    reserveMinutes: plan.reserve.minutes,
    reserveGal: plan.reserve.gal,
    requiredGal: plan.requiredGal,
    withAlternateGal: plan.withAlternateGal,
    aboardGal: plan.aboardGal,
    marginGal: plan.marginGal,
    marginMinutes: plan.marginMinutes,
  };
  const made =
    plan.allowanceGal !== null
      ? ` (${plan.allowanceGal} start, taxi and takeoff, ${plan.climbGal !== null ? `${plan.climbGal} climb, ` : ''}${plan.cruiseGal} cruise)`
      : '';
  const parts = `${plan.tripGal} gal for the trip${made} and ${plan.reserve.gal} gal for the ${plan.reserve.minutes}-minute ${plan.reserve.basis} reserve (${plan.reserve.rule})${burnWords(log)}`;

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
