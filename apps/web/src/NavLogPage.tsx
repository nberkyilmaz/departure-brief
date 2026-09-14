import type { NavLog, NavLogLeg, StoredBriefing } from './types.js';

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

function Leg({ leg, label }: { leg: NavLogLeg; label?: string }) {
  return (
    <>
      <tr>
        <td className="leg-name">
          {label && <span className="strip-label">{label} </span>}
          {leg.from} → {leg.to}
        </td>
        <td>{leg.distanceNm}</td>
        <td>{deg(leg.trueCourse)}</td>
        <td>{deg(leg.magneticCourse)}</td>
        <td>{leg.wind ? `${String(leg.wind.directionTrue).padStart(3, '0')}°/${leg.wind.speedKt}` : '—'}</td>
        <td>{leg.windCorrectionAngle === null ? '—' : `${leg.windCorrectionAngle > 0 ? '+' : ''}${leg.windCorrectionAngle}°`}</td>
        <td>{deg(leg.trueHeading)}</td>
        <td>{deg(leg.magneticHeading)}</td>
        <td>{leg.groundspeedKt ?? '—'}</td>
        <td>{minutes(leg.minutes)}</td>
        <td>{minutes(leg.cumulativeMinutes)}</td>
        <td>{leg.fuelGal ?? '—'}</td>
      </tr>
      {leg.gaps.length > 0 && (
        <tr className="leg-gaps">
          <td colSpan={12}>
            {leg.gaps.map((g, i) => (
              <span key={i} className="field-note">
                {g}
                {i < leg.gaps.length - 1 ? ' · ' : ''}
              </span>
            ))}
          </td>
        </tr>
      )}
    </>
  );
}

export function NavLogPage({ briefing }: { briefing: StoredBriefing | null }) {
  const log: NavLog | null = briefing?.document.navlog ?? null;
  if (!log) {
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
        {log.tas} kt true at {log.altitudeFt.toLocaleString('en')} ft. The wind for a leg is the one forecast at the point it ends at — the usual
        simplification, and the finer alternative would need a forecast at the midpoint, which nobody publishes. Courses and headings are true unless a
        magnetic column is filled in; the airport data has to publish the variation for that, and not every source does.
      </p>

      <div className="table-scroll">
        <table className="wb-table navlog-table">
          <thead>
            <tr>
              <th>Leg</th>
              <th>nm</th>
              <th>TC</th>
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
              <td>Total</td>
              <td>{log.totalDistanceNm}</td>
              <td colSpan={7}></td>
              <td>{minutes(log.totalMinutes)}</td>
              <td></td>
              <td>{log.totalFuelGal ?? '—'}</td>
            </tr>
            {log.alternate && <Leg leg={log.alternate} label="alternate" />}
          </tbody>
        </table>
      </div>

      {log.fuelGph === null && (
        <p className="field-note">
          No fuel column: the handbook prints burn against power setting and altitude, and nothing here will invent a figure for it. Put your cruise burn in
          the aircraft box on the briefing page and it will be filled in.
        </p>
      )}
    </section>
  );
}
