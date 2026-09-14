import { AerodromeField, lookupViaApi, type AirportLookup } from './AerodromeField.js';
import type { Aerodrome } from './engine.js';
import type { AirspaceClass, FlightPlanInput } from './types.js';

const CLASSES: AirspaceClass[] = ['control-zone', 'controlled', 'uncontrolled', 'B', 'C', 'D', 'E', 'G'];

/** The next whole hour, two hours out — far enough ahead that a forecast covers it. */
function defaultDeparture(): string {
  const d = new Date();
  d.setUTCMinutes(0, 0, 0);
  d.setUTCHours(d.getUTCHours() + 2);
  return `${d.toISOString().slice(0, 16)}:00Z`;
}

export const defaultPlan: FlightPlanInput = {
  departure: 'CYSN',
  destination: 'CYKF',
  alternate: 'CYHM',
  route: [],
  departureTime: defaultDeparture(),
  cruise: { tas: 105, altitude: 3500 },
  airspace: { CYSN: 'control-zone', CYKF: 'control-zone', CYHM: 'control-zone' },
};

/** What the plan is missing before it can be briefed, in the order a reader meets it. */
export function planProblems(plan: FlightPlanInput): string[] {
  const out: string[] = [];
  const looksLikeId = (s: string) => /^[A-Z0-9]{3,4}$/.test(s);
  if (!looksLikeId(plan.departure)) out.push('a departure aerodrome');
  if (!looksLikeId(plan.destination)) out.push('a destination aerodrome');
  if (Number.isNaN(Date.parse(plan.departureTime))) out.push('a departure time');
  if (!(plan.cruise.tas > 0)) out.push('a cruising speed');
  if (!(plan.cruise.altitude > 0)) out.push('a cruising altitude');
  return out;
}

export function FlightForm({
  plan,
  onChange,
  lookup,
  aerodromes = [],
}: {
  plan: FlightPlanInput;
  onChange: (p: FlightPlanInput) => void;
  /** Where identifiers are checked; null means ask the API. */
  lookup?: AirportLookup | null;
  /** The aerodromes there is data for, offered as suggestions when the set is known. */
  aerodromes?: readonly Aerodrome[];
}) {
  const set = (patch: Partial<FlightPlanInput>) => onChange({ ...plan, ...patch });
  const ask = lookup ?? lookupViaApi;
  const listId = aerodromes.length > 0 ? 'aerodromes-with-data' : undefined;
  const ids = [plan.departure, ...plan.route, plan.destination, plan.alternate]
    .filter((s): s is string => !!s && /^[A-Z0-9]{3,4}$/i.test(s))
    .map((s) => s.toUpperCase());
  const setClass = (id: string, cls: string) => set({ airspace: { ...(plan.airspace ?? {}), [id]: cls as AirspaceClass } });

  // The control expects local-ish "YYYY-MM-DDTHH:mm"; the plan is always Zulu.
  const zuluForInput = plan.departureTime.slice(0, 16);

  return (
    <fieldset>
      <legend>The flight</legend>
      {listId && (
        <datalist id={listId}>
          {aerodromes.map((a) => (
            <option key={a.id} value={a.id}>
              {a.name}
            </option>
          ))}
        </datalist>
      )}
      <div className="grid">
        <AerodromeField label="Departure" value={plan.departure} onChange={(v) => set({ departure: v })} lookup={ask} listId={listId} />
        <AerodromeField label="Destination" value={plan.destination} onChange={(v) => set({ destination: v })} lookup={ask} listId={listId} />
        <AerodromeField
          label="Alternate"
          value={plan.alternate ?? ''}
          optional
          hint="optional, but it is judged too"
          lookup={ask}
          listId={listId}
          onChange={(v) => set({ alternate: v || null })}
        />
        <label>
          Via
          <input
            value={plan.route.join(' ')}
            placeholder="CYHM 43.2,-79.8"
            autoCapitalize="characters"
            spellCheck={false}
            onChange={(e) => set({ route: e.target.value.toUpperCase().split(/\s+/).filter(Boolean) })}
          />
          <span className="field-note-line">
            <span className="field-note">waypoints between the two — identifiers or lat,lon, separated by spaces</span>
          </span>
        </label>
        <label>
          Departure, Zulu
          <input type="datetime-local" value={zuluForInput} onChange={(e) => set({ departureTime: `${e.target.value}:00Z` })} />
          <span className="field-note-line">
            <span className="field-note">everything is judged at the time you will actually be there</span>
          </span>
        </label>
        <label>
          True airspeed
          <input type="number" min={1} inputMode="numeric" value={plan.cruise.tas} onChange={(e) => set({ cruise: { ...plan.cruise, tas: Number(e.target.value) } })} />
          <span className="field-note-line">
            <span className="field-note">knots — sets the time at each waypoint</span>
          </span>
        </label>
        <label>
          Cruise altitude
          <input
            type="number"
            step={500}
            min={0}
            inputMode="numeric"
            value={plan.cruise.altitude}
            onChange={(e) => set({ cruise: { ...plan.cruise, altitude: Number(e.target.value) } })}
          />
          <span className="field-note-line">
            <span className="field-note">feet above sea level</span>
          </span>
        </label>
      </div>

      {ids.length > 0 && (
        <div className="airspace">
          <span className="hint">
            Airspace at each field, which decides the regulatory minima. Until the airspace layer can work this out from geometry, it is yours to state.
          </span>
          {ids.map((id) => (
            <label key={id} className="inline">
              {id}
              <select value={plan.airspace?.[id] ?? ''} onChange={(e) => setClass(id, e.target.value)}>
                <option value="">unknown</option>
                {CLASSES.map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </select>
            </label>
          ))}
        </div>
      )}
    </fieldset>
  );
}
