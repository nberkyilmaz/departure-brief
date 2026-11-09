import { hrefFor } from './router.js';
import { measuredWords } from './summary.js';
import type { FuelPlan, NavLog, NavLogLeg, StoredBriefing } from './types.js';

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

/**
 * CARs 602.88 as a short table: the trip, the reserve the regulation adds,
 * the sum, and what the pilot said is aboard. A row that cannot be filled
 * says why underneath rather than leaving a dash for the reader to guess
 * at. The regulation is a floor, and the table says nothing about whether
 * to go: that is what the margin row is for the pilot to read.
 */
function Fuel({ plan }: { plan: FuelPlan | undefined }) {
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
            <tr>
              <td>
                Reserve, {plan.reserve.minutes} min at cruise <span className="muted">({plan.reserve.rule}, {plan.reserve.basis})</span>
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
  const notes = [...leg.gaps, ...(leg.wind?.measured ? [measuredWords(leg.wind.measured.by, leg.wind.measured.at, leg.wind.distanceNm)] : [])];
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
        {log.tas} kt true at {log.altitudeFt.toLocaleString('en')} ft. Each leg uses the wind where it ends, forecast in Canada and measured by the nearest balloon in the US, and the variation where it begins,
        from NOAA&apos;s World Magnetic Model for the day you fly.
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

      {log.fuelGph === null && (
        <p className="field-note">
          No fuel figures yet: add your cruise burn from the handbook under <a href={hrefFor({ name: 'minimums' })}>Your minimums</a> and they are worked
          out here. Nothing guesses one for you.
        </p>
      )}

      <h3>Fuel</h3>
      <Fuel plan={briefing.document.fuel} />
    </section>
  );
}
