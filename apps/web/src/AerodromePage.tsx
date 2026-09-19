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

export function AerodromePage({ id, engine }: { id: string; engine: LocalEngine | null }) {
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
          <pre className="raw">{o.report.body}</pre>
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
