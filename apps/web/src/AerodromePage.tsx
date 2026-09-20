import { useEffect, useState } from 'react';
import type { AerodromeReport, LocalEngine } from './engine.js';
import { FindingList } from './BriefingView.js';
import { aerodromeHref } from './router.js';
import { hhmmZ, local } from './time.js';

/**
 * One field, and everything about it.
 *
 * Modelled on how a pilot actually looks something up: they want to know
 * about a place, and they usually do not have a flight plan yet. So this
 * needs none — it takes an identifier and an instant and reports.
 *
 * The dominant case is a field that does not report at all. Of the 1,667
 * aerodromes this page carries, a few hundred have an observation of their
 * own; the rest borrow one, and the page has to be as useful for those as
 * for CYYZ.
 */

function Missing({ id, kind, aerodromes }: { id: string; kind: 'malformed' | 'unknown'; aerodromes: readonly { id: string; name: string }[] }) {
  return (
    <section className="aerodrome-page">
      <h2>{id || 'No aerodrome given'}</h2>
      {kind === 'malformed' ? (
        <p className="error">“{id}” is not an aerodrome identifier. They are three or four letters or digits — CYSN, CYKF, KIAG.</p>
      ) : (
        <>
          <p className="error">{id} is not among the {aerodromes.length.toLocaleString('en')} aerodromes this page carries.</p>
          <p className="explain">
            The published build carries Canada, plus the fields across the border that report — because a field with no observation of its own borrows from
            the nearest that has one. A live instance with the airport data loaded knows every field in Canada and the United States.
          </p>
        </>
      )}
    </section>
  );
}

/**
 * The wind on each runway end, most into wind first.
 *
 * The first thing a pilot works out about a field they are going to, and
 * until now the one thing this page made them work out themselves: it
 * printed the runway headings and the METAR and left the trigonometry as an
 * exercise. The components come from the same function a briefing uses, so
 * a runway cannot read one way here and another way inside a flight.
 *
 * Whose wind it is matters as much as the number. A field that is not
 * reporting borrows one, and a crosswind computed from a neighbour eleven
 * miles away is a real figure about this runway from a reading taken
 * somewhere else — said plainly rather than implied.
 */
function RunwayWinds({ report, limitKt }: { report: AerodromeReport; limitKt: number | null }) {
  const cw = report.crosswind;
  const o = report.observation;
  if (!cw) {
    return (
      <p className="field-note">
        {o ? 'That observation reports no wind direction, so there is nothing to resolve onto a runway. A missing direction is not a calm wind.' : 'No observation, so no wind to put on a runway.'}
      </p>
    );
  }
  if (cw.calm) return <p className="field-note">Calm. Every runway is the same runway.</p>;

  const borrowed = o?.source === 'nearby';
  const over = (kt: number) => limitKt !== null && kt > limitKt;

  return (
    <>
      {cw.variable && (
        <p className="field-note">
          The wind is variable in direction, so each runway is shown with the full speed across it — the worst it could be, which is the only honest way to
          resolve a direction that has not been given.
        </p>
      )}
      <div className="table-scroll">
        <table className="wb-table runway-wind">
          <thead>
            <tr>
              <th>Runway</th>
              <th>Down the runway</th>
              <th>Across it</th>
              {cw.gust !== null && <th>Across, in gusts</th>}
            </tr>
          </thead>
          <tbody>
            {cw.runways.map((r, i) => (
              <tr key={`${r.runway}-${r.end}`} className={i === 0 ? 'best' : undefined}>
                <td className="leg-name">
                  {r.end}
                  {i === 0 && <span className="pill">most into wind</span>}
                </td>
                <td>
                  {Math.abs(r.headwind) < 0.5 ? '—' : `${Math.round(Math.abs(r.headwind))} kt ${r.headwind > 0 ? 'head' : 'tail'}`}
                  {r.headwind < -0.5 && <span className="pill warn">tailwind</span>}
                </td>
                <td className={over(r.crosswind) ? 'over' : undefined}>{Math.round(r.crosswind)} kt</td>
                {cw.gust !== null && <td className={over(r.crosswindGust) ? 'over' : undefined}>{Math.round(r.crosswindGust)} kt</td>}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="field-note">
        {borrowed ? (
          <>
            Computed from <b>{o!.station}</b>&apos;s wind, {Math.round(o!.distance)} nm away — {report.airport.icaoId ?? report.airport.faaId} is not reporting
            one of its own. The runway is this field&apos;s; the wind is not.
          </>
        ) : (
          <>Computed from this field&apos;s own observation.</>
        )}{' '}
        Headings are true and so is the reported wind, so no variation is applied. {limitKt !== null && <>Anything over your {limitKt} kt limit is marked.</>}
        {cw.unknownHeading.length > 0 && <> No published heading for {cw.unknownHeading.join(', ')}, so {cw.unknownHeading.length === 1 ? 'it is' : 'they are'} left out rather than guessed.</>}
      </p>
    </>
  );
}

/**
 * The observation read back in words, against the report it came from.
 *
 * The raw METAR stays exactly where it was — it is the grounding, and the
 * one thing that must never be replaced by a paraphrase. What is new is
 * that the paraphrase points at it: hover or focus a line and the
 * characters it was read from light up in the report above. A pilot
 * learning to read a METAR can follow one into the other, and a pilot who
 * already can check that this page read it correctly.
 *
 * Rows are the decoder's own output in the report's own order, so the list
 * is complete: anything the decoder could not account for appears as "Not
 * decoded" rather than being quietly left out.
 */
function DecodedReport({ report }: { report: AerodromeReport }) {
  const [active, setActive] = useState<number | null>(null);
  const o = report.observation;
  if (!o) return null;

  const raw = o.report.body;
  const span = active === null ? null : report.explained[active]?.span ?? null;

  return (
    <>
      <pre className="raw">
        {span ? (
          <>
            {raw.slice(0, span.start)}
            <mark>{raw.slice(span.start, span.end)}</mark>
            {raw.slice(span.end)}
          </>
        ) : (
          raw
        )}
      </pre>

      {report.explained.length > 0 && (
        <dl className="decoded" onMouseLeave={() => setActive(null)}>
          {report.explained.map((line, i) => (
            <div
              key={`${line.label}-${i}`}
              className={`decoded-row${active === i ? ' active' : ''}${line.indeterminate ? ' indeterminate' : ''}`}
              tabIndex={line.span ? 0 : -1}
              onMouseEnter={() => setActive(i)}
              onFocus={() => setActive(i)}
              onBlur={() => setActive(null)}
            >
              <dt>{line.label}</dt>
              <dd>
                {line.text}
                {line.span && <code>{raw.slice(line.span.start, line.span.end)}</code>}
              </dd>
            </div>
          ))}
        </dl>
      )}
      <p className="field-note">
        The report is the source; the lines under it are this page reading it. Hover or tab through one and it lights up in the report above, so you can check
        the reading against the text rather than taking it on trust.
      </p>
    </>
  );
}

function Runways({ report }: { report: AerodromeReport }) {
  const runways = report.airport.runways;
  if (runways.length === 0) return <p className="field-note">No runway data published for this field.</p>;
  return (
    <div className="table-scroll">
      <table className="wb-table">
        <thead>
          <tr>
            <th>Runway</th>
            <th>Length</th>
            <th>Width</th>
            <th>Surface</th>
            <th>Heading</th>
          </tr>
        </thead>
        <tbody>
          {runways.map((r) => (
            <tr key={r.id}>
              <td className="leg-name">{r.id}</td>
              <td>{r.length === null ? '—' : `${r.length.toLocaleString('en')} ft`}</td>
              <td>{r.width === null ? '—' : `${r.width} ft`}</td>
              <td>{r.surface ?? '—'}</td>
              <td>{r.ends.map((e) => (e.trueHeading === null ? `${e.id} —` : `${e.id} ${String(Math.round(e.trueHeading)).padStart(3, '0')}°T`)).join(' · ')}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="field-note">
        Headings are true. The airport data carries no magnetic variation for Canadian fields, so there is no magnetic column rather than a guessed one.
        Declared distances are not published here either — these are the physical lengths.
      </p>
    </div>
  );
}

export function AerodromePage({ id, engine, crosswindLimitKt }: { id: string; engine: LocalEngine | null; crosswindLimitKt: number | null }) {
  const [report, setReport] = useState<AerodromeReport | null | 'missing'>(null);

  useEffect(() => {
    if (!engine) return;
    let live = true;
    setReport(null);
    engine
      .aerodrome(id)
      .then((r) => live && setReport(r ?? 'missing'))
      .catch(() => live && setReport('missing'));
    return () => {
      live = false;
    };
  }, [id, engine]);

  if (!/^[A-Z0-9]{3,4}$/.test(id)) return <Missing id={id} kind="malformed" aerodromes={engine?.aerodromes ?? []} />;
  if (!engine || report === null) return <p className="explain">Looking up {id}…</p>;
  if (report === 'missing') return <Missing id={id} kind="unknown" aerodromes={engine.aerodromes} />;

  const a = report.airport;
  const o = report.observation;
  const dusk = report.daylight.civilDusk;
  const dawn = report.daylight.civilDawn;

  return (
    <section className="aerodrome-page">
      <h2>
        {report.category && <span className={`category ${report.category.toLowerCase()}`}>{report.category}</span>}
        {report.forecastCategory && report.forecastCategory !== report.category && (
          <span className={`category forecast ${report.forecastCategory.toLowerCase()}`}>{report.forecastCategory} forecast</span>
        )}
        {a.icaoId ?? a.faaId} <span className="meta">{a.name}</span>
      </h2>
      <p className="explain">
        {[a.city, a.state, a.country].filter(Boolean).join(', ')}
        {a.elevation !== null ? ` · ${a.elevation.toLocaleString('en')} ft` : ''} · {a.lat.toFixed(3)}, {a.lon.toFixed(3)} · as of <b>{hhmmZ(report.at)}</b>{' '}
        <small>({local(report.at)} local)</small>
        {report.night ? ' · night' : ''}
      </p>

      {o ? (
        <>
          <h3>{o.source === 'nearby' ? `Nearest observation — ${o.station}, ${Math.round(o.distance)} nm` : 'Observation'}</h3>
          <DecodedReport report={report} />
        </>
      ) : (
        <p className="field-note">No observation within {60} nm of this field.</p>
      )}

      {report.forecast && (
        <>
          <h3>
            Forecast{report.forecast.source === 'nearby' ? ` — ${report.forecast.station}, ${Math.round(report.forecast.distance)} nm` : ''}
          </h3>
          <pre className="raw">{report.forecast.resolved.raw}</pre>
        </>
      )}

      <h3>What that means against your minimums</h3>
      <FindingList findings={report.findings} />

      <h3>Daylight</h3>
      <p className="explain">
        {dawn ? `First light ${hhmmZ(dawn)}` : 'No first light today'} · {dusk ? `last light ${hhmmZ(dusk)}` : 'no last light today'}
        {report.daylight.sunrise ? ` · sunrise ${hhmmZ(report.daylight.sunrise)}` : ''}
        {report.daylight.sunset ? ` · sunset ${hhmmZ(report.daylight.sunset)}` : ''}
      </p>

      <h3>Wind on the runways</h3>
      <RunwayWinds report={report} limitKt={crosswindLimitKt} />

      <h3>Runways</h3>
      <Runways report={report} />

      <h3>Nearby fields</h3>
      <ul className="nearby">
        {report.nearby.map((n) => (
          <li key={n.id}>
            <a href={aerodromeHref(n.id)}>{n.id}</a> <span className="muted">{n.name}</span>{' '}
            <span className="muted">
              {n.distanceNm} nm, {String(n.bearingTrue).padStart(3, '0')}°T
            </span>{' '}
            {n.ageMinutes === null ? <span className="field-note">no observation</span> : <span className="field-note">observation {n.ageMinutes} min old</span>}
          </li>
        ))}
      </ul>
    </section>
  );
}
