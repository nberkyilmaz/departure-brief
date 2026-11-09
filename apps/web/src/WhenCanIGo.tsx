import { useEffect, useState } from 'react';
import { CATEGORY_LETTER, TOPIC_LABEL, topicOf, type Topic } from './summary.js';
import { hhmmZ, localClock, zoneOf } from './time.js';
import type { DepartureSlot, Finding, FlightCategory, WindowAlong, WindowPoint } from './types.js';

/**
 * When can I go: every hour you could leave, at both ends of the flight and
 * along the way between them.
 *
 * A strip rather than a table of words, because the first question is a
 * glance — where does it turn green, where do the marks stop — and the
 * answer to "why that hour" is one tap away underneath it. Each cell is
 * what the briefing would say had that hour been asked for: the forecast
 * category, and a mark where a limit of yours is crossed. It does not say
 * when to go. It shows how each hour would be judged, and briefs the one
 * you pick.
 */

/** The hour as the clock on the wall reads it, on twenty-four hours so twelve of them fit across a phone. */
const hourOf = (iso: string): string => new Date(iso).toLocaleTimeString(undefined, { hour: '2-digit', hourCycle: 'h23' });

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

function markOf(p: { findings: readonly Finding[] }): Mark {
  if (p.findings.some((f) => f.attention === 'alert')) return 'alert';
  return p.findings.some((f) => f.attention === 'caution') ? 'caution' : null;
}

const TOPIC_ORDER: readonly Topic[] = ['weather', 'unread', 'wind', 'cloud', 'visibility', 'hazard', 'daylight', 'cruise', 'other'];

/** The topics a set of findings is about, in the order the briefing reads them, each once. */
function topics(findings: readonly Finding[]): string[] {
  const seen = new Set(findings.map((f) => topicOf(f.rule)));
  return TOPIC_ORDER.filter((t) => seen.has(t)).map((t) => TOPIC_LABEL[t].toLowerCase());
}

/** Along the way, each topic with the stations that say it: "cloud at KMPV, K6B0". */
function topicsAt(findings: readonly Finding[]): string[] {
  return TOPIC_ORDER.flatMap((t) => {
    const at = [...new Set(findings.filter((f) => topicOf(f.rule) === t).map((f) => f.waypoint))];
    return at.length > 0 ? [`${TOPIC_LABEL[t].toLowerCase()} at ${at.join(', ')}`] : [];
  });
}

/** The stations along the way at one hour, in a sentence: the worst forecast, where, and what crossed where. */
function alongSentence(a: WindowAlong): string {
  const head =
    a.covered === 0
      ? 'No station along the way has a forecast for the time you would pass it.'
      : `${a.category ?? 'No category'} at worst${a.station ? `, at ${a.station}` : ''} (${a.covered} station${a.covered === 1 ? '' : 's'} forecast the time you pass).`;
  const alerts = a.findings.filter((f) => f.attention === 'alert');
  const cautions = a.findings.filter((f) => f.attention === 'caution' && !alerts.some((x) => x.waypoint === f.waypoint && topicOf(x.rule) === topicOf(f.rule)));
  const parts = [head];
  if (alerts.length > 0) parts.push(`Crosses your limits: ${topicsAt(alerts).join('; ')}.`);
  if (cautions.length > 0) parts.push(`Worth a look: ${topicsAt(cautions).join('; ')}.`);
  if (a.covered > 0 && alerts.length === 0 && cautions.length === 0) parts.push('Nothing crosses your limits.');
  return parts.join(' ');
}

/** What one cell of the strip shows: a category, whether any forecast is behind it, and the marks. */
interface Cell {
  readonly covered: boolean;
  readonly category: FlightCategory | null;
  readonly findings: readonly Finding[];
}

interface Row {
  readonly key: string;
  /** In the row's header: a field's identifier, or "Along". */
  readonly label: string;
  /** Said to a screen reader, and on hover. */
  readonly name: string;
  readonly cell: (s: DepartureSlot) => Cell;
}

const alongCell = (s: DepartureSlot): Cell => ({ covered: s.along.covered > 0, category: s.along.category, findings: s.along.findings });

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

function cellLabel(slot: DepartureSlot, row: Row, c: Cell): string {
  const mark = markOf(c);
  const what = !c.covered ? 'no forecast' : (c.category ?? 'no category');
  return `Leave ${hourOf(slot.departAt)}:00, ${row.name} ${what}${mark === 'alert' ? ', crosses your limits' : mark === 'caution' ? ', could cross them' : ''}`;
}

export function WhenCanIGo({ slots, departure, onPick }: { slots: readonly DepartureSlot[]; departure: string; onPick: (departAt: string) => void }) {
  const current = slots.findIndex((s) => Date.parse(s.departAt) === Date.parse(departure));
  const [selected, setSelected] = useState<number>(current);
  // A different flight, or a new hour briefed, starts from the hour being briefed.
  useEffect(() => setSelected(current), [current, slots]);

  if (slots.length === 0) return null;
  const ends: Row[] = slots[0]!.points.map((p, i) => ({ key: `point-${i}`, label: p.waypoint, name: p.waypoint, cell: (s) => s.points[i]! }));
  // Shown only when there is something along the way to show: a flight with no station beside it has two rows, as it always had.
  const along = slots.some((s) => s.along.covered > 0 || s.along.findings.length > 0);
  const rows: Row[] = along ? [ends[0]!, { key: 'along', label: 'Along', name: 'along the way', cell: alongCell }, ...ends.slice(1)] : ends;
  const slot = selected >= 0 ? slots[selected] : undefined;

  return (
    <section className="window" aria-labelledby="window-title">
      <h3 id="window-title">When can I go?</h3>
      <p className="explain">
        Each hour you could leave in the next {slots.length}, judged the same way: the destination when you would arrive
        {along ? ', the way between when you would pass it' : ''}. Tap an hour for why.
      </p>
      <div className="window-scroll">
        <table className="window-table">
          <caption className="sr-only">Forecast category at each end of the flight{along ? ' and along the way' : ''}, by the hour you leave</caption>
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
              <tr key={r.key} className={r.key === 'along' ? 'window-along' : undefined}>
                <th scope="row" title={r.key === 'along' ? 'The worst forecast along the way' : undefined}>
                  {r.label}
                </th>
                {slots.map((s, i) => {
                  const c = r.cell(s);
                  const mark = markOf(c);
                  const category = c.covered && c.category ? c.category.toLowerCase() : 'none';
                  return (
                    <td key={s.departAt}>
                      <button
                        type="button"
                        className={`window-cell ${category}${mark ? ` ${mark}` : ''}`}
                        aria-pressed={i === selected}
                        aria-label={cellLabel(s, r, c)}
                        onClick={() => setSelected(i)}
                      >
                        {c.covered && c.category ? CATEGORY_LETTER[c.category] : '–'}
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
              {slot.points.flatMap((p, i) => [
                // In the order they are flown: the departure, what lies between, the destination.
                ...(i === 1 && along
                  ? [
                      <li key="along">
                        <b>Along the way</b>: {alongSentence(slot.along)}
                      </li>,
                    ]
                  : []),
                <li key={i}>
                  <b>{p.waypoint}</b>
                  {i > 0 && <span className="muted"> at {timeOf(p.at)}</span>}: {sentence(p)}
                </li>,
              ])}
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
