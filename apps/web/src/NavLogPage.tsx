import { hrefFor } from './router.js';
import { measuredWords } from './summary.js';
import type { CruiseCellRef, FuelPlan, NavLog, NavLogHandbook, NavLogLeg, StoredBriefing } from './types.js';

/**
 * The nav log: the arithmetic a pilot does on the kitchen table, laid out
 * the way they lay it out.
 *
 * Every column is either measured or worked out from something measured,
 * and where a number is missing the reason is printed underneath rather
 * than left as a blank for the reader to interpret. A nav log with a
 * plausible figure in place of a missing forecast is worse than one with a
 * hole in it.
 */

const minutes = (m: number | null): string => {
  if (m === null) return '—';
  const h = Math.floor(m / 60);
  return h > 0 ? `${h}:${String(m % 60).padStart(2, '0')}` : `${m} min`;
};

const deg = (d: number | null): string => (d === null ? '—' : `${String(d).padStart(3, '0')}°`);

const gal = (g: number | null): string => (g === null ? '—' : `${g} gal`);

/** Variation as a chart prints it: whole degrees, east or west, never split across a line. */
export const variationText = (v: number | null): string => {
  if (v === null) return '—';
  const d = Math.round(Math.abs(v));
  return d === 0 ? '0°' : `${d}°${v < 0 ? 'W' : 'E'}`;
};

const feet = (n: number): string => `${n.toLocaleString('en')} ft`;

/** A temperature column of the cruise table, in words. */
const columnWords = (c: number): string => (c === 0 ? 'standard' : `${Math.abs(c)} °C ${c > 0 ? 'above' : 'below'}`);

const UNSCANNED = 'read from the page image; the scan does not show it, so check it against your handbook';

/** "a, b and c" */
const listed = (items: readonly string[]): string => (items.length < 2 ? (items[0] ?? '') : `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`);

/**
 * Where a leg's burn came from: the printed figures either side of the
 * flight it was the highest of, so the reader can find them on the page.
 */
export function burnNote(leg: NavLogLeg): string | null {
  const h = leg.burn?.handbook;
  if (!leg.burn || !h) return null;
  const altitudes = [...new Set(h.around.map((c: CruiseCellRef) => c.pressureAltitudeFt))].map(feet);
  const columns = [...new Set(h.around.map((c: CruiseCellRef) => c.columnC))].map(columnWords);
  const where = h.deviationC === null ? `${listed(altitudes)}, every temperature column, there being no temperature at cruise` : `${listed(altitudes)}, ${listed(columns)}`;
  const printed = h.around.map((c: CruiseCellRef) => String(c.gph));
  const figures = printed.length === 1 ? `the handbook's figure` : `the highest of the handbook's ${listed(printed)}`;
  return `${leg.burn.gph} gal/h: ${figures} for ${h.rpm} RPM at ${where}${h.burnCell.scanned.gph ? '' : ` — ${UNSCANNED}`}`;
}

/** What the handbook added before the first leg, and where it prints it. */
export function beforeNote(h: NavLogHandbook): string {
  const c = h.climb;
  const climb = c
    ? `, and its climb from ${c.fromRowFt === 0 ? 'sea level' : feet(c.fromRowFt)} to ${feet(c.toRowFt)}: ${c.nm} nm and ${c.minutes} min${c.percent > 0 ? `, ${c.percent}% more for ${c.deviationC} °C above standard` : ''}. The climb's distance comes off the first leg's cruise; the leg's time is left as it was`
    : '';
  const notes = h.notes.map((n) => `; ${n}`).join('');
  return `${h.model} handbook, ${h.climbTable.figure} (page ${h.climbTable.printedPage}): note 1's start, taxi and takeoff allowance${h.allowance.scanned ? '' : ` (${UNSCANNED})`}${climb}${notes}.`;
}

/**
 * CARs 602.88 as a short table: the trip, the reserve the regulation adds,
 * the sum, and what the pilot said is aboard. A row that cannot be filled
 * says why underneath rather than leaving a dash for the reader to guess
 * at. The regulation is a floor, and the table says nothing about whether
 * to go: that is what the margin row is for the pilot to read.
 */
function Fuel({ plan, gph }: { plan: FuelPlan | undefined; gph: number | null }) {
  if (!plan) return null;
  const short = plan.marginGal !== null && plan.marginGal < 0;
  return (
    <>
      <div className="table-scroll">
        <table className="wb-table fuel">
          <tbody>
            <tr>
              <td>Trip, departure to destination</td>
              <td>{gal(plan.tripGal)}</td>
            </tr>
            {plan.allowanceGal !== null && (
              <>
                <tr className="part">
                  <td>start, taxi and takeoff</td>
                  <td>{gal(plan.allowanceGal)}</td>
                </tr>
                {plan.climbGal !== null && (
                  <tr className="part">
                    <td>climb</td>
                    <td>{gal(plan.climbGal)}</td>
                  </tr>
                )}
                <tr className="part">
                  <td>cruise</td>
                  <td>{gal(plan.cruiseGal)}</td>
                </tr>
              </>
            )}
            <tr>
              <td>
                Reserve, {plan.reserve.minutes} min at cruise{gph !== null ? `, ${gph} gal/h` : ''}{' '}
                <span className="muted">
                  ({plan.reserve.rule}, {plan.reserve.basis})
                </span>
              </td>
              <td>{gal(plan.reserve.gal)}</td>
            </tr>
            <tr className="total">
              <td>Required at departure</td>
              <td>{gal(plan.requiredGal)}</td>
            </tr>
            {plan.withAlternateGal !== null && (
              <tr>
                <td>
                  With the alternate as well <span className="muted">(not required for VFR; what a diversion would take)</span>
                </td>
                <td>{gal(plan.withAlternateGal)}</td>
              </tr>
            )}
            <tr>
              <td>Aboard, as you entered it</td>
              <td>{gal(plan.aboardGal)}</td>
            </tr>
            <tr className={`total${short ? ' over' : ''}`}>
              <td>{short ? 'Short by' : 'To spare'}</td>
              <td>
                {plan.marginGal === null ? '—' : `${Math.abs(plan.marginGal)} gal`}
                {plan.marginMinutes !== null && <span className="muted"> · {Math.abs(plan.marginMinutes)} min at cruise</span>}
              </td>
            </tr>
          </tbody>
        </table>
      </div>
      {plan.gaps.length > 0 && (
        <p className="field-note">
          {plan.gaps.map((g) => g.charAt(0).toUpperCase() + g.slice(1)).join('. ')}.
        </p>
      )}
    </>
  );
}

function Leg({ leg, label }: { leg: NavLogLeg; label?: string }) {
  const burn = burnNote(leg);
  const notes = [...leg.gaps, ...(leg.wind?.measured ? [measuredWords(leg.wind.measured.by, leg.wind.measured.at, leg.wind.distanceNm)] : []), ...(burn ? [burn] : [])];
  return (
    <>
      <tr>
        <td className="leg-name">
          {label && <span className="strip-label">{label} </span>}
          {leg.from} → {leg.to}
        </td>
        {/* Labelled, so on a phone each leg reads as a card of named numbers rather than thirteen columns off the edge. */}
        <td data-label="Distance">{leg.distanceNm} nm</td>
        <td data-label="True course">{deg(leg.trueCourse)}</td>
        <td data-label="Variation">{variationText(leg.variation)}</td>
        <td data-label="Magnetic course">{deg(leg.magneticCourse)}</td>
        <td data-label="Wind">{leg.wind ? `${String(leg.wind.directionTrue).padStart(3, '0')}°/${leg.wind.speedKt}` : '—'}</td>
        <td data-label="Correction">{leg.windCorrectionAngle === null ? '—' : `${leg.windCorrectionAngle > 0 ? '+' : ''}${leg.windCorrectionAngle}°`}</td>
        <td data-label="True heading">{deg(leg.trueHeading)}</td>
        <td data-label="Magnetic heading">{deg(leg.magneticHeading)}</td>
        <td data-label="Groundspeed">{leg.groundspeedKt === null ? '—' : `${leg.groundspeedKt} kt`}</td>
        <td data-label="Time">{minutes(leg.minutes)}</td>
        <td data-label="Elapsed">{minutes(leg.cumulativeMinutes)}</td>
        <td data-label="Fuel">{leg.fuelGal ?? '—'}</td>
      </tr>
      {notes.length > 0 && (
        <tr className="leg-gaps">
          <td colSpan={13}>
            {notes.map((g, i) => (
              <span key={i} className="field-note">
                {g}
                {i < notes.length - 1 ? ' · ' : ''}
              </span>
            ))}
          </td>
        </tr>
      )}
    </>
  );
}

export function NavLogPage({ briefing }: { briefing: StoredBriefing | null }) {
  // Narrowed on the briefing rather than on the log, so everything else
  // read out of the document below is known to be there too.
  const log: NavLog | null = briefing?.document.navlog ?? null;
  if (!briefing || !log) {
    return (
      <section className="navlog-page">
        <h2>Nav log</h2>
        <p className="field-note">Nothing yet. Brief a flight and its legs will be worked out here.</p>
      </section>
    );
  }

  return (
    <section className="navlog-page">
      <h2>Nav log</h2>
      <p className="explain">
        {log.tas} kt true at {log.altitudeFt.toLocaleString('en')} ft{log.rpm !== null ? `, ${log.rpm} RPM` : ''}. Each leg uses the wind where it ends, forecast in Canada and measured by the nearest balloon in the US, and
        the variation where it begins, from NOAA&apos;s World Magnetic Model for the day you fly.
      </p>

      <div className="table-scroll">
        <table className="wb-table navlog-table">
          <thead>
            <tr>
              <th>Leg</th>
              <th>nm</th>
              <th>TC</th>
              <th>Var</th>
              <th>MC</th>
              <th>Wind</th>
              <th>WCA</th>
              <th>TH</th>
              <th>MH</th>
              <th>GS</th>
              <th>Time</th>
              <th>Total</th>
              <th>Fuel</th>
            </tr>
          </thead>
          <tbody>
            {/* Before the first leg, as the handbook's own sample problem lists them. */}
            {log.handbook && (
              <>
                <tr className="before">
                  <td className="leg-name">Start, taxi and takeoff</td>
                  <td colSpan={11}></td>
                  <td data-label="Fuel">{log.handbook.allowance.gal}</td>
                </tr>
                {log.handbook.climb && (
                  <tr className="before">
                    <td className="leg-name">Climb to {feet(log.handbook.climb.toRowFt)}</td>
                    <td colSpan={11}></td>
                    <td data-label="Fuel">{log.handbook.climb.gal}</td>
                  </tr>
                )}
                <tr className="leg-gaps">
                  <td colSpan={13}>
                    <span className="field-note">{beforeNote(log.handbook)}</span>
                  </td>
                </tr>
              </>
            )}
            {log.legs.map((leg) => (
              <Leg key={`${leg.from}-${leg.to}`} leg={leg} />
            ))}
            <tr className="total">
              <td className="leg-name">Total</td>
              <td data-label="Distance">{log.totalDistanceNm} nm</td>
              <td colSpan={8}></td>
              <td data-label="Time">{minutes(log.totalMinutes)}</td>
              <td></td>
              <td data-label="Fuel">{log.totalFuelGal ?? '—'}</td>
            </tr>
            {log.alternate && <Leg leg={log.alternate} label="alternate" />}
          </tbody>
        </table>
      </div>

      {log.fuelGph === null &&
        (log.handbook && log.rpm === null ? (
          <p className="field-note">
            No fuel figures yet: choose a power setting with the flight and the {log.handbook.model} handbook&apos;s cruise table gives the burn, or type your own under{' '}
            <a href={hrefFor({ name: 'minimums' })}>Your minimums</a>. Nothing guesses one for you.
          </p>
        ) : log.fuelProblem ? (
          <p className="field-note">No fuel figures: {log.fuelProblem}.</p>
        ) : (
          <p className="field-note">
            No fuel figures yet: add your cruise burn from the handbook under <a href={hrefFor({ name: 'minimums' })}>Your minimums</a> and they are worked
            out here. Nothing guesses one for you.
          </p>
        ))}

      <h3>Fuel</h3>
      <Fuel plan={briefing.document.fuel} gph={log.fuelGph} />
    </section>
  );
}
