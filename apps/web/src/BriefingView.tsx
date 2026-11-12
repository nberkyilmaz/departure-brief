import { lazy, Suspense, useState, type ReactNode } from 'react';
import { MapBoundary } from './MapBoundary.js';
import { NotamPanel } from './NotamPanel.js';
import { alongRowId } from './picture.js';
import { aerodromeHref } from './router.js';
import { SideView } from './SideView.js';
import { alongTheWay, concernsOf, fieldCards, runwayEnds, TOPIC_LABEL, type AlongLeg, type AlongStation, type Concern, type FieldCard, type RunwayEnd } from './summary.js';
import { hhmmZ, local, localClock, zulu } from './time.js';
import type { Citation, Finding, RoutePicture, StoredBriefing } from './types.js';

// The map library is only worth downloading once there is a flight to draw.
const RouteMap = lazy(() => import('./RouteMap.js'));

/** The time as a pilot says it; the date rides in the local time beside it, and the full stamp is a hover away. */
function Zulu({ iso }: { iso: string }) {
  return (
    <span className="time" title={zulu(iso)}>
      <b>{hhmmZ(iso)}</b> <small>({local(iso)} local)</small>
    </span>
  );
}

/** The raw report with the cited span highlighted. This is the grounding; it is never hidden. */
function Source({ c }: { c: Citation }) {
  if (!c.raw) return null;
  /*
   * A hazard advisory is stored as the record the service sent, and the
   * bulletin is a field inside it. The bulletin is the artefact a pilot
   * reads, so that is what is shown — quoted from the record, not instead
   * of it.
   */
  if (c.kind === 'sigmet' && c.text) return <pre className="raw">{c.text}</pre>;
  if (!c.span) return <pre className="raw">{c.raw}</pre>;
  return (
    <pre className="raw">
      {c.raw.slice(0, c.span.start)}
      <mark>{c.raw.slice(c.span.start, c.span.end)}</mark>
      {c.raw.slice(c.span.end)}
    </pre>
  );
}

/**
 * How old the reading is, in colour.
 *
 * A METAR carries its own time and nothing else: a pilot reading
 * `CYSN 122100Z` at four in the morning has no way to see from the text
 * that it is seven hours stale. The band says it at a glance, and the
 * minutes say it exactly.
 */
function AgeBadge({ f }: { f: Finding }) {
  const band = f.values['band'];
  if (typeof band !== 'string') return null;
  return <span className={`age ${band}`}>{band}</span>;
}

/** How far either side of the track a station counts as on the way, and how far off it a station is still on the line: the core's `CORRIDOR_NM` and `ON_TRACK_NM`. */
const CORRIDOR_NM = 25;
const ON_TRACK_NM = 10;

/** Under this, a leg with nothing reporting between its ends is the ends' weather, and not worth a line. */
const QUIET_LEG_NM = 30;

function FindingRow({ f, where = false }: { f: Finding; where?: boolean }) {
  const [open, setOpen] = useState(false);
  const sources = f.citations.filter((c) => c.raw);
  const others = f.citations.filter((c) => !c.raw && c.text);
  return (
    <li className={`finding ${f.attention}`}>
      <button className="row" onClick={() => setOpen(!open)} aria-expanded={open}>
        {f.rule === 'observation.age' ? <AgeBadge f={f} /> : <span className={`badge ${f.attention}`}>{f.attention}</span>}
        <span className="basis">
          {where && <b>{f.waypoint} </b>}
          {f.basis}
        </span>
        <span className="summary">{f.summary}</span>
      </button>
      {open && (
        <div className="detail">
          {sources.map((c, i) => (
            <div key={i}>
              <div className="source-label">
                {c.kind.toUpperCase()} {c.station ?? ''} {c.sha256 && <code title="content hash of the raw report">{c.sha256.slice(0, 12)}</code>}
              </div>
              <Source c={c} />
            </div>
          ))}
          {others.length > 0 && <div className="also">Also from: {others.map((c) => `${c.kind} ${c.text}`).join(' · ')}</div>}
          {sources.length === 0 && others.length === 0 && <div className="also">No report behind this line — it is about the inputs, not the weather.</div>}
        </div>
      )}
    </li>
  );
}

/**
 * What the briefing could not see. A confident verdict built on less than it
 * should have been is the most dangerous thing this tool could produce, so
 * the gaps are stated beside the verdict rather than left to be inferred.
 */
function Gaps({ stored }: { stored: StoredBriefing }) {
  const b = stored.document.briefing;
  const all = [...b.points, ...(b.alternate ? [b.alternate] : [])];
  const missing = all.flatMap((p) => p.findings.filter((f) => f.rule === 'forecast.coverage' || f.rule === 'forecast.borrowed').map((f) => `${p.waypoint}: ${f.summary}`));
  const notams = stored.document.notams;
  const fetchErrors = (notams?.fetchErrors ?? []).map((e) => `NOTAMs for ${e.site} could not be fetched — ${e.error}`);
  const unverified = notams?.counts.unverified ?? 0;
  const notAssessed = notams?.counts['not-assessed'] ?? 0;
  const notamNotes = [
    unverified > 0 ? `${unverified} NOTAM${unverified === 1 ? '' : 's'} had a model answer whose quote was not in the NOTAM, so ${unverified === 1 ? 'it is' : 'they are'} shown unranked rather than trusted` : null,
    notAssessed > 0 ? `${notAssessed} NOTAM${notAssessed === 1 ? ' was' : 's were'} not ranked at all, because no model was configured` : null,
    notams === null ? 'NOTAMs were not part of this briefing' : null,
  ].filter((x): x is string => x !== null);

  // A leg with no wind has no time, and the card's wind at cruise is blank; said once here, with the leg.
  const navlog = stored.document.navlog;
  const noWind = [...navlog.legs, ...(navlog.alternate ? [navlog.alternate] : [])].flatMap((leg) =>
    leg.gaps.filter((g) => g.startsWith('no upper wind forecast')).map((g) => `${leg.from} → ${leg.to}: ${g}`),
  );

  // A long leg with nothing reporting near it has had only its ends read.
  const unread = alongTheWay(stored)
    .filter((leg) => leg.stations.length === 0 && leg.distanceNm > QUIET_LEG_NM)
    .map((leg) => `${leg.from} → ${leg.to}: nothing reports within ${CORRIDOR_NM} nm of the track, so the weather between the two ends was not read`);

  const items = [...missing, ...unread, ...noWind, ...fetchErrors, ...notamNotes];
  if (items.length === 0) return null;
  return (
    <div className="gaps" role="note">
      <h3>What this briefing could not see</h3>
      <ul>
        {items.map((t, i) => (
          <li key={i}>{t}</li>
        ))}
      </ul>
    </div>
  );
}

/**
 * The same line from two products — "airspace class not given" read once
 * from the forecast and again from the observation — said once, with both
 * products behind it.
 */
function sayOnce(findings: readonly Finding[]): Finding[] {
  const out = new Map<string, Finding>();
  for (const f of findings) {
    const key = `${f.waypoint}|${f.rule}|${f.attention}|${f.summary}`;
    const seen = out.get(key);
    out.set(key, seen ? { ...seen, basis: seen.basis.split(' · ').includes(f.basis) ? seen.basis : `${seen.basis} · ${f.basis}`, citations: [...seen.citations, ...f.citations] } : f);
  }
  return [...out.values()];
}

/**
 * A list of findings, most wanting of attention first, each opening to the
 * report it was read from. Shared with the aerodrome page so a field looked
 * up on its own reads exactly as it does inside a briefing.
 *
 * The checks that came out within your limits are folded under one line:
 * on a quiet day they are most of the list, and a page of "meets your
 * minimum" hides the one line that does not. Folded is not hidden — the
 * count is on the line and every one is a tap away.
 */
export function FindingList({ findings, where = false }: { findings: readonly Finding[]; where?: boolean }) {
  const order: Record<string, number> = { alert: 0, caution: 1, note: 2, routine: 3 };
  const sorted = sayOnce(findings).sort((a, b) => (order[a.attention] ?? 9) - (order[b.attention] ?? 9));
  if (sorted.length === 0) return <p className="field-note">Nothing to report.</p>;
  const worth = sorted.filter((f) => f.attention !== 'routine');
  const routine = sorted.filter((f) => f.attention === 'routine');
  const list = (fs: readonly Finding[]) => (
    <ul className="findings">
      {fs.map((f, i) => (
        <FindingRow key={`${f.rule}-${i}`} f={f} where={where} />
      ))}
    </ul>
  );
  return (
    <>
      {worth.length > 0 ? list(worth) : <p className="field-note">Nothing here crosses your limits.</p>}
      {routine.length > 0 && (
        <details className="routine-checks">
          <summary>
            {routine.length} {routine.length === 1 ? 'check' : 'checks'} within your limits
          </summary>
          {list(routine)}
        </details>
      )}
    </>
  );
}


const ftText = (n: number): string => `${Math.round(n).toLocaleString('en')} ft`;
const capitalised = (t: string): string => t.charAt(0).toUpperCase() + t.slice(1);

/** The wind along one end in words: what it adds, and how much of it is across. */
function alongWords(r: RunwayEnd): { text: string; note: string | null } {
  if (r.alongKt === null) return { text: 'not given', note: 'read for still air' };
  const along = Math.round(Math.abs(r.alongKt));
  const across = r.crosswindKt === null ? null : `${Math.round(r.crosswindKt)} kt across`;
  if (along === 0) return { text: r.crosswindKt ? 'none along' : 'calm', note: r.crosswindKt ? across : null };
  if (r.alongKt > 0) return { text: `${along} kt head`, note: ['no credit', across].filter(Boolean).join(', ') };
  return { text: `${along} kt tail`, note: [r.windPercent ? `+${r.windPercent}%` : null, across].filter(Boolean).join(', ') };
}

const VERDICT: Readonly<Record<RunwayEnd['reasons'][number], string>> = { short: 'too short', margin: 'short of margin', crosswind: 'too much crosswind' };

/**
 * Every runway end, read for this takeoff or landing on the same forecast
 * or observation as the card. Open when no runway fits, or rain puts the
 * figures in doubt, so the reason is on the page rather than behind a tap.
 */
function RunwayTable({ f }: { f: Finding }) {
  const ends = runwayEnds(f);
  const margin = typeof f.values['marginPercent'] === 'number' ? f.values['marginPercent'] : 0;
  const what = f.values['what'] === 'landing' ? 'landing' : 'takeoff';
  const cell = f.values['cell'] as { pressureAltitudeFt: number; columnC: number } | null;
  const pa = typeof f.values['pressureAltitudeFt'] === 'number' ? f.values['pressureAltitudeFt'] : null;
  const temp = typeof f.values['tempC'] === 'number' ? f.values['tempC'] : null;
  const from = f.values['tempFrom'] as { station: string; at: string | null } | null;
  return (
    <details className="runway-reading" open={f.attention === 'alert' || f.attention === 'caution'}>
      <summary>
        Each runway for the {what} ({ends.length} {ends.length === 1 ? 'end' : 'ends'})
      </summary>
      <p className="runway-reading-at">
        {pa !== null && `${ftText(pa)} pressure altitude, ${temp !== null ? `${temp} °C` : 'no temperature reported'}${from ? ` (${from.station}${from.at ? ` ${hhmmZ(from.at)}` : ''})` : ''}. `}
        {cell && `Read from the handbook's chart at ${cell.pressureAltitudeFt === 0 ? 'sea level' : ftText(cell.pressureAltitudeFt)} and ${cell.columnC} °C, 2,300 lb. `}
        Wind from the {f.basisKind === 'observed' ? 'observation' : 'forecast for your time'}.
      </p>
      <table className="runway-table">
        <thead>
          <tr>
            <th scope="col">Runway</th>
            <th scope="col">Wind</th>
            <th scope="col" className="num">
              Needs
            </th>
            <th scope="col" className="num">
              Has
            </th>
          </tr>
        </thead>
        <tbody>
          {ends.map((r) => {
            const wind = alongWords(r);
            const read = r.status === 'fits' || r.status === 'over';
            return (
              <tr key={`${r.runway}-${r.end}`} className={r.status}>
                <th scope="row">
                  {r.end}
                  <small>{r.kind ?? r.surface ?? 'surface not recorded'}</small>
                </th>
                {read ? (
                  <>
                    <td>
                      {wind.text}
                      {wind.note && <small>{wind.note}</small>}
                    </td>
                    <td className="num">
                      {ftText(r.neededFt!)}
                      <small>{margin > 0 ? `${r.totalFt!.toLocaleString('en')} + ${margin}%` : 'handbook'}</small>
                    </td>
                    <td className="num">
                      {ftText(r.availableFt!)}
                      <small className="verdict">{r.status === 'fits' ? 'fits' : r.reasons.map((x) => VERDICT[x]).join(', ')}</small>
                    </td>
                  </>
                ) : (
                  <td colSpan={3} className="runway-problem">
                    {capitalised(r.problem ?? 'no figure')}
                  </td>
                )}
              </tr>
            );
          })}
        </tbody>
      </table>
    </details>
  );
}

/**
 * One field at the time you are there, in the numbers a pilot asks for
 * first. The checks behind them are under the card, each with its report.
 */
function FieldCardView({ c, name }: { c: FieldCard; name: string | null }) {
  const p = c.point;
  const category = (c.category ?? 'unknown').toLowerCase();
  return (
    <article className={`field-card ${category}`} aria-label={`${c.role} ${p.waypoint}`}>
      <div className="field-card-top">
        <span className="field-role">
          {c.role}
          {c.leg && (
            <span className="muted">
              {' · '}
              {Math.round(c.leg.distanceNm)} nm{c.leg.minutes !== null ? `, ${Math.round(c.leg.minutes)} min` : ''}
            </span>
          )}
        </span>
        <span className={`category ${category}`} title="Flight category at your time">
          {c.category ?? '—'}
        </span>
      </div>
      <h3 className="field-id">
        <a href={aerodromeHref(p.waypoint)} title={`Everything about ${p.waypoint}`}>
          {p.waypoint}
        </a>
        {name && <span className="field-name">{name}</span>}
      </h3>
      <p className="field-time">
        <b>{localClock(p.at)}</b> · {hhmmZ(p.at)}
        {p.night && <span className="night">night</span>}
      </p>
      {c.missing ? (
        <p className="field-missing">{c.missing}</p>
      ) : (
        <dl className="field-lines">
          {c.lines.map((l) => (
            <div key={l.label} className={l.over ? 'over' : undefined}>
              <dt>{l.label}</dt>
              <dd>{l.text}</dd>
            </div>
          ))}
        </dl>
      )}
      {c.source && <p className="field-source">{c.source}</p>}
      {c.now && <p className="field-source">{c.now}</p>}
      {c.runways && <RunwayTable f={c.runways} />}
      <details className="met">
        <summary>Every check here, with its report ({p.findings.length})</summary>
        <FindingList findings={p.findings} />
      </details>
    </article>
  );
}

function ConcernRow({ c }: { c: Concern }) {
  const [open, setOpen] = useState(false);
  return (
    <li className={`concern ${c.attention}`}>
      <button className="row" onClick={() => setOpen(!open)} aria-expanded={open}>
        <span className={`badge ${c.attention}`}>{c.attention}</span>
        <span className="concern-where">
          {c.role === 'Along the way' ? 'Along the way' : `${c.role === 'Alternate' ? 'Alternate ' : ''}${c.waypoint}`} · {TOPIC_LABEL[c.topic]}
        </span>
        <span className="concern-text">
          {c.headline}
          {c.when.length > 0 && <span className="concern-when">{c.when.join(' · ')}</span>}
        </span>
      </button>
      {open && (
        <div className="concern-detail">
          <FindingList findings={c.findings} where={c.role === 'Along the way'} />
        </div>
      )}
    </li>
  );
}

const timeOf = (iso: string): string => new Date(iso).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });

/** Off the track, as a chart reads it: "18 nm left", or on it. */
function offTrack(offsetNm: number): string {
  const off = Math.round(Math.abs(offsetNm));
  return off === 0 ? 'on the track' : `${off} nm ${offsetNm > 0 ? 'right' : 'left'}`;
}

/** One station beside the track: where it is, when you pass it, what it says then, and every check behind that. */
function AlongRow({ s, name }: { s: AlongStation; name: string | null }) {
  const r = s.review;
  const category = (s.category ?? 'unknown').toLowerCase();
  return (
    <li id={alongRowId(r.station)} className={`along-row${s.attention ? ` ${s.attention}` : ''}`}>
      <details>
        <summary>
          <span className="along-nm">{Math.round(r.alongNm)} nm</span>
          <span className={`category ${category}`} title={s.from === 'now' ? 'From the observation now: no forecast covers the time you pass' : 'Forecast for the time you pass'}>
            {s.category ?? '—'}
          </span>
          <span className="along-what">
            <b>{r.station}</b>
            {name && <span className="along-name"> {name}</span>}
            <span className="along-meta">
              {offTrack(r.offsetNm)} · {timeOf(r.at)}
              {s.from === 'now' && ' · observed now, no forecast'}
              {r.night && ' · night'}
            </span>
            {s.crossed.length > 0 && (
              <span className="along-crossed">
                {s.attention === 'alert' ? 'Crosses your limits' : 'Worth a look'}: {s.crossed.join(', ')}
              </span>
            )}
          </span>
        </summary>
        <div className="along-detail">
          <FindingList findings={r.findings} />
          <p className="field-source">
            <a href={aerodromeHref(r.station)}>Everything about {r.station}</a>
          </p>
        </div>
      </details>
    </li>
  );
}

/** "9 VFR, 2 MVFR": a quiet stretch of the route, said as the categories it is made of. */
function categoryCounts(stations: readonly AlongStation[]): string {
  const counts = new Map<string, number>();
  for (const s of stations) counts.set(s.category ?? 'unclassified', (counts.get(s.category ?? 'unclassified') ?? 0) + 1);
  return ['VFR', 'MVFR', 'IFR', 'LIFR', 'unclassified']
    .filter((c) => counts.has(c))
    .map((c) => `${counts.get(c)} ${c}`)
    .join(', ');
}

/**
 * The stations beside the track, in the order you pass them. The ones that
 * cross a limit are listed; the rest are a tap away, said first as the
 * categories they are, so a quiet stretch reads as quiet without hiding
 * which stations made it so.
 */
function AlongTheWay({ legs, nameOf }: { legs: readonly AlongLeg[]; nameOf: ((id: string) => string | null) | undefined }) {
  const shown = legs.filter((l) => l.stations.length > 0);
  if (shown.length === 0) return null;
  const total = shown.reduce((n, l) => n + l.stations.length, 0);
  return (
    <section className="along" aria-labelledby="along-title">
      <h3 id="along-title">Along the way</h3>
      <p className="explain">
        {total} reporting station{total === 1 ? '' : 's'} within {CORRIDOR_NM} nm of your track, each at the time you pass it. More than {ON_TRACK_NM} nm off
        the line, a crossed limit is a caution rather than an alert.
      </p>
      {shown.map((leg) => {
        const asks = leg.stations.filter((s) => s.attention !== null);
        const quiet = leg.stations.filter((s) => s.attention === null);
        return (
          <div className="along-leg" key={leg.leg}>
            {legs.length > 1 && (
              <h4 className="along-leg-title">
                {leg.from} → {leg.to}
              </h4>
            )}
            {asks.length > 0 && (
              <ol className="along-list">
                {asks.map((s) => (
                  <AlongRow key={s.review.station} s={s} name={nameOf?.(s.review.station) ?? null} />
                ))}
              </ol>
            )}
            {quiet.length > 0 && (
              <details className="along-more">
                <summary>
                  {quiet.length} {asks.length > 0 ? 'more ' : ''}within your limits: {categoryCounts(quiet)}
                </summary>
                <ol className="along-list">
                  {quiet.map((s) => (
                    <AlongRow key={s.review.station} s={s} name={nameOf?.(s.review.station) ?? null} />
                  ))}
                </ol>
              </details>
            )}
          </div>
        );
      })}
    </section>
  );
}

/**
 * What crossed a limit, one line per field and topic, worst first. It does
 * not say what to do; it says what to look at, and each line opens to the
 * findings and reports behind it.
 */
function WorthALook({ concerns }: { concerns: readonly Concern[] }) {
  // When nothing crossed a limit, the answer above says so.
  if (concerns.length === 0) return null;
  return (
    <div className="why">
      <h3>Worth a look</h3>
      <ul className="concerns">
        {concerns.map((c) => (
          <ConcernRow key={c.key} c={c} />
        ))}
      </ul>
    </div>
  );
}

const COUNT_WORDS = ['Nothing', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine'];

/** On a screen this wide the answer sits on the map; narrower, it follows it. The stylesheet changes the layout at the same width. */
const BESIDE_MAP = '(min-width: 47.5rem)';
/** How much of the map the card covers there, and room for a field's name beside it, so the route is framed in the rest. */
const CARD_PX = 470;

/**
 * The answer first, on a chart of the flight: how many things want a look,
 * if any, over the map of where you are going. The map is the picture and
 * the card is the words, which are what a screen reader and a printed page
 * get, and what is left when the map cannot be drawn.
 */
function Hero({
  stored,
  picture,
  concerns,
  nameOf,
  aerodromes,
}: {
  stored: StoredBriefing;
  picture: RoutePicture | null;
  concerns: readonly Concern[];
  nameOf: ((id: string) => string | null) | undefined;
  aerodromes: readonly { id: string; lat: number; lon: number }[] | undefined;
}) {
  const b = stored.document.briefing;
  const plan = stored.document.plan;
  const log = stored.document.navlog;
  const departs = b.points[0]?.at ?? null;
  const n = concerns.length;
  const title = n === 0 ? 'Nothing crosses your limits.' : `${COUNT_WORDS[n] ?? n} ${n === 1 ? 'thing' : 'things'} to look at.`;
  const minutes = log.totalMinutes;
  const altitude = plan.cruise?.altitude;
  const lede = `${plan.departure} to ${plan.destination}${b.aircraft ? ` in the ${b.aircraft}` : ''}: ${Math.round(log.totalDistanceNm)} nm${minutes !== null ? `, ${minutes} minutes` : ''}${
    altitude ? ` at ${altitude.toLocaleString('en')} ft` : ''
  }${plan.alternate ? `, with ${plan.alternate} as the alternate` : ''}.`;
  const beside = window.matchMedia?.(BESIDE_MAP).matches ?? false;
  return (
    <section className={`hero${picture ? '' : ' no-map'}`} aria-labelledby="hero-title">
      {picture && (
        <MapBoundary message="The map could not be loaded. The side view and the list below have every station.">
          <Suspense fallback={<div className="wx-map wx-map-loading route-map-canvas">Loading the map…</div>}>
            <RouteMap stored={stored} picture={picture} nameOf={nameOf} aerodromes={aerodromes} leaveLeft={beside ? CARD_PX : 0} />
          </Suspense>
        </MapBoundary>
      )}
      <div className="hero-card">
        {departs && (
          <p className="hero-kicker">
            Departs {localClock(departs)} · {hhmmZ(departs)}
          </p>
        )}
        <h2 id="hero-title" className="hero-title">
          {title}
        </h2>
        <p className="hero-lede">{lede}</p>
        <ul className="hero-fields" aria-label="Flight category at each field at your time">
          {fieldCards(stored).map((c) => (
            <li key={`${c.role}-${c.point.waypoint}`} title={c.role}>
              <b>{c.point.waypoint}</b>
              <span className={`category ${(c.category ?? 'unknown').toLowerCase()}`}>{c.category ?? '—'}</span>
            </li>
          ))}
        </ul>
        <p className="hero-meta">
          Checked against your minimums; whether to go stays with you. Weather as of <Zulu iso={b.asOf} />.
        </p>
      </div>
      {picture && (
        <p className="hero-key">
          Your route in magenta, dashed on to the alternate, and the {CORRIDOR_NM} nm either side of it searched for reports. Each letter is a station at the time
          you would pass it: filled is forecast for then, hollow is observed now. Tap one for its line in Along the way, or a field for its page.
        </p>
      )}
    </section>
  );
}

export function BriefingView({
  stored,
  picture,
  nameOf,
  aerodromes,
  whenCanIGo,
}: {
  stored: StoredBriefing;
  picture?: RoutePicture | null;
  nameOf?: (id: string) => string | null;
  /** Every aerodrome the page knows, so the map can show the ones around the route. */
  aerodromes?: readonly { id: string; lat: number; lon: number }[] | undefined;
  whenCanIGo?: ReactNode;
}) {
  const b = stored.document.briefing;
  const cards = fieldCards(stored);
  const concerns = concernsOf(stored);
  return (
    <section className="briefing" id="verdict">
      <Hero stored={stored} picture={picture ?? null} concerns={concerns} nameOf={nameOf} aerodromes={aerodromes} />

      {/* Adverse conditions first, as a standard briefing gives them; then the hours either side; then each field; then what it could not see. */}
      <WorthALook concerns={concerns} />
      {whenCanIGo}

      <div className="field-cards">
        {cards.map((c) => (
          <FieldCardView key={`${c.role}-${c.point.waypoint}-${c.point.at}`} c={c} name={nameOf?.(c.point.waypoint) ?? null} />
        ))}
      </div>

      {picture && <SideView stored={stored} picture={picture} />}
      <AlongTheWay legs={alongTheWay(stored)} nameOf={nameOf} />

      <Gaps stored={stored} />
      {stored.document.notams && <NotamPanel doc={stored.document.notams} />}

      <details className="inputs-used">
        <summary>How to read this briefing</summary>
        <p>
          A limit crossed in the prevailing forecast or a current observation reads as an <b>alert</b>; the same crossed inside a TEMPO, PROB or an
          in-progress BECMG reads as a <b>caution</b>, because the product is less certain. VFR, MVFR, IFR and LIFR are the standard classification of ceiling
          and visibility, a fact about the sky and not a judgement about your flight. Winds and runway headings are true. Every line opens to the report text
          it was read from, and nothing is hidden: collapsing changes what you see first, never what exists.
        </p>
      </details>
      <details className="inputs-used">
        <summary>Reports this briefing was made from ({stored.document.inputs.reports.length})</summary>
        <p>
          Judged against your minimums ({b.profile.name} v{b.profile.version}){b.aircraft ? ` and the ${b.aircraft}` : ''}, rules version {b.rulesVersion}.
          Briefing <code title="content hash">{stored.sha256.slice(0, 12)}</code>.
        </p>
        <ul>
          {stored.document.inputs.reports.map((r) => (
            <li key={r.sha256}>
              {r.kind.toUpperCase()} {r.station} {r.issuedAt ? hhmmZ(r.issuedAt) : ''} <code>{r.sha256.slice(0, 12)}</code>
            </li>
          ))}
        </ul>
      </details>
    </section>
  );
}
