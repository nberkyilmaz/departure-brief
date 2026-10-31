import { useMemo } from 'react';
import { AerodromeField, lookupViaApi, type AirportLookup } from './AerodromeField.js';
import type { Aerodrome } from './engine.js';
import { aerodromeSearch } from './search.js';
import { hhmmZ } from './time.js';
import type { AirspaceClass, FlightPlanInput } from './types.js';

const CLASSES: AirspaceClass[] = ['control-zone', 'controlled', 'uncontrolled', 'B', 'C', 'D', 'E', 'G'];

/** The next whole hour, two hours out — far enough ahead that a forecast covers it. */
export function defaultDeparture(): string {
  const d = new Date();
  d.setUTCMinutes(0, 0, 0);
  d.setUTCHours(d.getUTCHours() + 2);
  return `${d.toISOString().slice(0, 16)}:00Z`;
}

/** Nothing chosen yet: the page asks where you are going before it says anything about it. */
export const defaultPlan: FlightPlanInput = {
  departure: '',
  destination: '',
  alternate: null,
  route: [],
  departureTime: defaultDeparture(),
  cruise: { tas: 105, altitude: 3500 },
  fuelAboardGal: null,
  airspace: {},
};

/** What the plan is missing before it can be briefed, in the order a reader meets it. */
export function planProblems(plan: FlightPlanInput): string[] {
  const out: string[] = [];
  const looksLikeId = (s: string) => /^[A-Z0-9]{3,4}$/.test(s);
  if (!looksLikeId(plan.departure)) out.push('where you are leaving from');
  if (!looksLikeId(plan.destination)) out.push('where you are going');
  if (Number.isNaN(Date.parse(plan.departureTime))) out.push('a departure time');
  if (!(plan.cruise.tas > 0)) out.push('a cruising speed');
  if (!(plan.cruise.altitude > 0)) out.push('a cruising altitude');
  return out;
}

/** How far ahead a TAF reaches, give or take: past this, the briefing will say no forecast covers the time. */
const FORECAST_REACH_HOURS = 24;

/**
 * Whether the departure time can be briefed against live weather. A flight
 * that has already left answers no question anybody is asking; one beyond
 * the forecasts can be briefed, but should be warned about before it is.
 */
export function departureTimeNote(iso: string, now: number = Date.now()): { blocks: boolean; text: string } | null {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return null;
  if (t < now - 30 * 60_000) return { blocks: true, text: 'that time has passed — pick a departure still to come' };
  if (t > now + FORECAST_REACH_HOURS * 3_600_000) return { blocks: false, text: 'forecasts do not reach that far yet, so much of the briefing will be blank' };
  return null;
}

/** "2026-10-29T17:00" in this device's time zone, for a datetime-local control. */
export function localForInput(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** The control's local time back to the plan's Zulu. A value with no offset is read as local, which is what the control means. */
export function zuluFromInput(value: string): string | null {
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : `${d.toISOString().slice(0, 16)}:00Z`;
}

/**
 * The flight, asked the way you would say it: from, to, when.
 *
 * Those three are all a briefing needs; everything else has a sensible
 * default and waits under "more". Times are entered in this device's own
 * time zone, because that is the clock a flight is planned by, and the Zulu
 * equivalent is shown beside it, because that is the clock the forecasts
 * are written in.
 */
export function FlightForm({
  plan,
  onChange,
  lookup,
  aerodromes = [],
  live = false,
}: {
  plan: FlightPlanInput;
  onChange: (p: FlightPlanInput) => void;
  /** Where identifiers are checked; null means ask the API. */
  lookup?: AirportLookup | null;
  /** The aerodromes there is data for, searched as a field is typed in. */
  aerodromes?: readonly Aerodrome[];
  /** Live weather: the departure is checked against the clock. */
  live?: boolean;
}) {
  const set = (patch: Partial<FlightPlanInput>) => onChange({ ...plan, ...patch });
  const ask = lookup ?? lookupViaApi;
  const search = useMemo(() => (aerodromes.length > 0 ? aerodromeSearch(aerodromes) : undefined), [aerodromes]);
  const ids = [plan.departure, ...plan.route, plan.destination, plan.alternate]
    .filter((s): s is string => !!s && /^[A-Z0-9]{3,4}$/i.test(s))
    .map((s) => s.toUpperCase());
  const setClass = (id: string, cls: string) => set({ airspace: { ...(plan.airspace ?? {}), [id]: cls as AirspaceClass } });
  const timeNote = live ? departureTimeNote(plan.departureTime) : null;
  const valid = !Number.isNaN(Date.parse(plan.departureTime));

  return (
    <div className="plan-form">
      <div className="plan-route">
        <AerodromeField label="From" value={plan.departure} onChange={(v) => set({ departure: v })} lookup={ask} search={search} />
        <button
          type="button"
          className="swap"
          aria-label="Swap from and to"
          title="Swap from and to"
          disabled={!plan.departure && !plan.destination}
          onClick={() => set({ departure: plan.destination, destination: plan.departure })}
        >
          ⇄
        </button>
        <AerodromeField label="To" value={plan.destination} onChange={(v) => set({ destination: v })} lookup={ask} search={search} />
      </div>

      <label className="plan-when">
        Departing
        <input
          type="datetime-local"
          value={localForInput(plan.departureTime)}
          aria-invalid={timeNote?.blocks ?? false}
          onChange={(e) => {
            const z = zuluFromInput(e.target.value);
            if (z) set({ departureTime: z });
          }}
        />
        <span className="field-note-line">
          {timeNote ? (
            <span className={timeNote.blocks ? 'field-bad' : 'field-note'}>{timeNote.text}</span>
          ) : (
            <span className="field-note">{valid ? `your time · ${hhmmZ(plan.departureTime)}` : 'when you plan to take off'}</span>
          )}
        </span>
      </label>

      <details className="plan-more">
        <summary>Alternate, route, speed, altitude and fuel</summary>
        <div className="grid">
          <AerodromeField
            label="Alternate"
            value={plan.alternate ?? ''}
            optional
            hint="optional, and judged like the destination"
            lookup={ask}
            search={search}
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
          <label>
            Fuel aboard
            <input
              type="number"
              min={0}
              step={0.5}
              inputMode="decimal"
              value={plan.fuelAboardGal ?? ''}
              placeholder="not given"
              onChange={(e) => set({ fuelAboardGal: e.target.value === '' ? null : Number(e.target.value) })}
            />
            <span className="field-note-line">
              <span className="field-note">US gallons at departure — checked against the VFR reserve, CARs 602.88 or FAR 91.151</span>
            </span>
          </label>
        </div>

        {ids.length > 0 && (
          <div className="airspace">
            <span className="hint">
              Airspace at each field, which decides the legal VFR minimums. This page cannot work it out yet, so until you say, those are not checked; your
              own minimums always are.
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
      </details>
    </div>
  );
}
