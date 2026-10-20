import { hhmmZ, local } from './time.js';
import type { AircraftInput, FlightPlanInput } from './types.js';

/**
 * The flight in one line, the way a pilot would say it out loud.
 *
 * The form below it holds the same facts spread over a dozen fields, which
 * is right for entering them and wrong for checking them. This is the
 * check: one glance to see that the briefing underneath belongs to the
 * flight you meant.
 */
export function FlightLine({ plan, aircraft }: { plan: FlightPlanInput; aircraft: AircraftInput }) {
  const route = [plan.departure, ...plan.route, plan.destination].filter(Boolean).join(' → ');
  const when = Number.isNaN(Date.parse(plan.departureTime)) ? null : plan.departureTime;
  return (
    <p className="flight-line">
      <b>{route}</b>
      {plan.alternate ? <span className="muted"> alternate {plan.alternate}</span> : null}
      {when && (
        <span className="muted">
          {' · '}
          {hhmmZ(when)} <small>({local(when)} local)</small>
        </span>
      )}
      <span className="muted">
        {' · '}
        {aircraft.type} at {plan.cruise.tas} kt, {plan.cruise.altitude.toLocaleString('en')} ft
      </span>
    </p>
  );
}
