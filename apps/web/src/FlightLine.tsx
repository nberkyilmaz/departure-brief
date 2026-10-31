import { hhmmZ, localClock } from './time.js';
import type { AircraftInput, FlightPlanInput } from './types.js';

/**
 * The flight in one line, the way a pilot would say it out loud: one glance
 * to see that the briefing underneath belongs to the flight you meant.
 */
export function FlightLine({ plan, aircraft }: { plan: FlightPlanInput; aircraft: AircraftInput }) {
  const route = [plan.departure, ...plan.route, plan.destination].filter(Boolean).join(' → ');
  const when = Number.isNaN(Date.parse(plan.departureTime)) ? null : plan.departureTime;
  return (
    <p className="flight-line">
      <b className="flight-route">{route}</b>
      {when && (
        <span className="muted">
          departs {localClock(when)} · {hhmmZ(when)}
        </span>
      )}
      {plan.alternate ? <span className="muted">alternate {plan.alternate}</span> : null}
      <span className="muted">
        {aircraft.type} at {plan.cruise.tas} kt, {plan.cruise.altitude.toLocaleString('en')} ft
      </span>
    </p>
  );
}
