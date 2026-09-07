import type { AirspaceClass, FlightPlanInput } from './types.js';

const CLASSES: AirspaceClass[] = ['control-zone', 'controlled', 'uncontrolled', 'B', 'C', 'D', 'E', 'G'];

function nextHourZ(): string {
  const d = new Date();
  d.setUTCMinutes(0, 0, 0);
  d.setUTCHours(d.getUTCHours() + 2);
  return d.toISOString().slice(0, 16);
}

export const defaultPlan: FlightPlanInput = {
  departure: 'CYSN',
  destination: 'CYKF',
  alternate: 'CYHM',
  route: [],
  departureTime: `${nextHourZ()}:00Z`,
  cruise: { tas: 105, altitude: 3500 },
  airspace: { CYSN: 'control-zone', CYKF: 'control-zone', CYHM: 'control-zone' },
};

export function FlightForm({ plan, onChange }: { plan: FlightPlanInput; onChange: (p: FlightPlanInput) => void }) {
  const set = (patch: Partial<FlightPlanInput>) => onChange({ ...plan, ...patch });
  const ids = [plan.departure, ...plan.route, plan.destination, plan.alternate].filter((s): s is string => !!s && /^[A-Z0-9]{3,4}$/i.test(s)).map((s) => s.toUpperCase());
  const setClass = (id: string, cls: string) => set({ airspace: { ...(plan.airspace ?? {}), [id]: cls as AirspaceClass } });

  return (
    <fieldset>
      <legend>Flight</legend>
      <div className="grid">
        <label>
          Departure
          <input value={plan.departure} onChange={(e) => set({ departure: e.target.value.toUpperCase() })} />
        </label>
        <label>
          Route (ids or lat,lon; space-separated)
          <input value={plan.route.join(' ')} onChange={(e) => set({ route: e.target.value.split(/\s+/).filter(Boolean) })} />
        </label>
        <label>
          Destination
          <input value={plan.destination} onChange={(e) => set({ destination: e.target.value.toUpperCase() })} />
        </label>
        <label>
          Alternate
          <input value={plan.alternate ?? ''} onChange={(e) => set({ alternate: e.target.value.toUpperCase() || null })} />
        </label>
        <label>
          Departure (Zulu)
          <input type="datetime-local" value={plan.departureTime.slice(0, 16)} onChange={(e) => set({ departureTime: `${e.target.value}:00Z` })} />
        </label>
        <label>
          TAS (kt)
          <input type="number" value={plan.cruise.tas} onChange={(e) => set({ cruise: { ...plan.cruise, tas: Number(e.target.value) } })} />
        </label>
        <label>
          Cruise altitude (ft MSL)
          <input type="number" step={500} value={plan.cruise.altitude} onChange={(e) => set({ cruise: { ...plan.cruise, altitude: Number(e.target.value) } })} />
        </label>
      </div>
      <div className="airspace">
        <span className="hint">Airspace class at each field (until the airspace layer can derive it):</span>
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
    </fieldset>
  );
}
