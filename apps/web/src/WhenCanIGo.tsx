import { useEffect, useState } from 'react';
import { TOPIC_LABEL, topicOf, type Topic } from './summary.js';
import { hhmmZ, localClock } from './time.js';
import type { DepartureSlot, FlightCategory, WindowPoint } from './types.js';

/**
 * When can I go: every hour you could leave, at both ends of the flight.
 *
 * A strip rather than a table of words, because the first question is a
 * glance — where does it turn green, where do the marks stop — and the
 * answer to "why that hour" is one tap away underneath it. Each cell is
 * what the briefing would say had that hour been asked for: the forecast
 * category, and a mark where a limit of yours is crossed. It does not say
 * when to go. It shows how each hour would be judged, and briefs the one
 * you pick.
 */

const LETTER: Readonly<Record<FlightCategory, string>> = { VFR: 'V', MVFR: 'M', IFR: 'I', LIFR: 'L' };

/** The hour as the clock on the wall reads it, on twenty-four hours so twelve of them fit across a phone. */
const hourOf = (iso: string): string => new Date(iso).toLocaleTimeString(undefined, { hour: '2-digit', hourCycle: 'h23' });

/** This device's zone at that instant, as a clock prints it: EDT, PST. */
const zoneOf = (iso: string): string =>
  new Intl.DateTimeFormat(undefined, { timeZoneName: 'short' }).formatToParts(new Date(iso)).find((p) => p.type === 'timeZoneName')?.value ?? '';

/** Arrival time without the weekday when it is the same day as leaving. */
const timeOf = (iso: string): string => new Date(iso).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });

/** What each mark means, kept together so a key never breaks from its words on a narrow screen. */
const LEGEND: readonly (readonly [string, string, string])[] = [
  ['vfr', 'V', 'VFR'],
  ['mvfr', 'M', 'MVFR'],
  ['ifr', 'I', 'IFR'],
  ['lifr', 'L', 'LIFR'],
  ['none', '–', 'no forecast'],
  ['none alert', '', 'crosses your limits'],
  ['none caution', '', 'could, in a TEMPO or PROB'],
];

type Mark = 'alert' | 'caution' | null;

function markOf(p: WindowPoint): Mark {
  if (p.findings.some((f) => f.attention === 'alert')) return 'alert';
  return p.findings.some((f) => f.attention === 'caution') ? 'caution' : null;
}

/** The topics a set of findings is about, in the order the briefing reads them, each once. */
function topics(findings: WindowPoint['findings']): string[] {
  const order: readonly Topic[] = ['weather', 'wind', 'cloud', 'visibility', 'hazard', 'daylight', 'cruise', 'other'];
  const seen = new Set(findings.map((f) => topicOf(f.rule)));
  return order.filter((t) => seen.has(t)).map((t) => TOPIC_LABEL[t].toLowerCase());
}

/** One end of the flight at one hour, in a sentence: the category, whose forecast, and what crossed. */
function sentence(p: WindowPoint): string {
  if (!p.covered) return 'No forecast covers this time.';
  const whose = p.forecastStation && p.forecastStation !== p.waypoint ? `, from the ${p.forecastStation} TAF` : '';
  const head = `${p.category ?? 'No category'}${whose}${p.night ? ', at night' : ''}.`;
  const alerts = topics(p.findings.filter((f) => f.attention === 'alert'));
  const cautions = topics(p.findings.filter((f) => f.attention === 'caution')).filter((t) => !alerts.includes(t));
  const overlay = p.findings.some((f) => f.attention === 'caution' && f.basisKind === 'overlay');
  const parts = [head];
  if (alerts.length > 0) parts.push(`Crosses your limits: ${alerts.join(', ')}.`);
  if (cautions.length > 0) parts.push(`${overlay ? 'Could cross them in a TEMPO or PROB' : 'Worth a look'}: ${cautions.join(', ')}.`);
  if (alerts.length === 0 && cautions.length === 0) parts.push('Nothing crosses your limits.');
  return parts.join(' ');
}

function cellLabel(slot: DepartureSlot, p: WindowPoint): string {
  const mark = markOf(p);
  const what = !p.covered ? 'no forecast' : (p.category ?? 'no category');
  return `Leave ${hourOf(slot.departAt)}:00, ${p.waypoint} ${what}${mark === 'alert' ? ', crosses your limits' : mark === 'caution' ? ', could cross them' : ''}`;
}

export function WhenCanIGo({ slots, departure, onPick }: { slots: readonly DepartureSlot[]; departure: string; onPick: (departAt: string) => void }) {
  const current = slots.findIndex((s) => Date.parse(s.departAt) === Date.parse(departure));
  const [selected, setSelected] = useState<number>(current);
  // A different flight, or a new hour briefed, starts from the hour being briefed.
  useEffect(() => setSelected(current), [current, slots]);

  if (slots.length === 0) return null;
  const rows = slots[0]!.points.map((_, i) => i);
  const slot = selected >= 0 ? slots[selected] : undefined;

  return (
    <section className="window" aria-labelledby="window-title">
      <h3 id="window-title">When can I go?</h3>
      <p className="explain">
        The same checks for each hour you could leave in the next {slots.length}, with the destination at the time you would get there. Pick an hour to see
        what it says.
      </p>
      <div className="window-scroll">
        <table className="window-table">
          <caption className="sr-only">Forecast category at each end of the flight, by the hour you leave</caption>
          <thead>
            <tr>
              <th scope="col" className="window-zone">
                {zoneOf(slots[0]!.departAt)}
              </th>
              {slots.map((s, i) => (
                <th scope="col" key={s.departAt} className={i === current ? 'window-current' : undefined} title={hhmmZ(s.departAt)}>
                  {hourOf(s.departAt)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r}>
                <th scope="row">{slots[0]!.points[r]!.waypoint}</th>
                {slots.map((s, i) => {
                  const p = s.points[r]!;
                  const mark = markOf(p);
                  const category = p.covered && p.category ? p.category.toLowerCase() : 'none';
                  return (
                    <td key={s.departAt}>
                      <button
                        type="button"
                        className={`window-cell ${category}${mark ? ` ${mark}` : ''}`}
                        aria-pressed={i === selected}
                        aria-label={cellLabel(s, p)}
                        onClick={() => setSelected(i)}
                      >
                        {p.covered && p.category ? LETTER[p.category] : '–'}
                      </button>
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="window-legend">
        {LEGEND.map(([key, letter, words]) => (
          <span key={key} className="window-legend-item">
            <span className={`window-key ${key}`}>{letter}</span> {words}
          </span>
        ))}
      </p>

      <div className="window-detail" aria-live="polite">
        {slot ? (
          <>
            <p className="window-when">
              <b>Leave {localClock(slot.departAt)}</b> · {hhmmZ(slot.departAt)}
            </p>
            <ul>
              {slot.points.map((p, i) => (
                <li key={i}>
                  <b>{p.waypoint}</b>
                  {i > 0 && <span className="muted"> at {timeOf(p.at)}</span>}: {sentence(p)}
                </li>
              ))}
            </ul>
            {selected === current ? (
              <p className="field-note">This is the time this briefing is for.</p>
            ) : (
              <button type="button" onClick={() => onPick(slot.departAt)}>
                Brief this time
              </button>
            )}
          </>
        ) : (
          <p className="field-note">The time this briefing is for is not on the hour; pick one to compare it.</p>
        )}
      </div>
    </section>
  );
}
