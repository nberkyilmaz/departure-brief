import { useState } from 'react';
import { NotamPanel } from './NotamPanel.js';
import { RouteStrip } from './RouteStrip.js';
import { hhmmZ, local, zulu } from './time.js';
import type { Attention, Citation, FlightCategory, Finding, PointReview, StoredBriefing } from './types.js';

function Zulu({ iso }: { iso: string }) {
  return (
    <span className="time">
      <b>{zulu(iso)}</b> <small>({local(iso)} local)</small>
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

function FindingRow({ f, waypoint = null }: { f: Finding; waypoint?: string | null }) {
  const [open, setOpen] = useState(false);
  const sources = f.citations.filter((c) => c.raw);
  const others = f.citations.filter((c) => !c.raw && c.text);
  return (
    <li className={`finding ${f.attention}`}>
      <button className="row" onClick={() => setOpen(!open)} aria-expanded={open}>
        {f.rule === 'observation.age' ? <AgeBadge f={f} /> : <span className={`badge ${f.attention}`}>{f.attention}</span>}
        <span className="basis">
          {waypoint ? <b>{waypoint}</b> : null} {f.basis}
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

const WEIGHT: Record<string, number> = { 'alert': 0, marginal: 1, advisory: 2, ok: 3 };

/** A waypoint, and what to call it when it is the alternate rather than a leg. */
interface LabelledPoint {
  readonly point: PointReview;
  readonly label: string | null;
}

/**
 * The reasons the verdict is what it is, and nothing else.
 *
 * A briefing produces dozens of lines and most of them say a limit was met.
 * Leading with all of them buries the two worth reading. This shows what
 * asked for attention, most first, with the detail one tap away — the rest
 * is still below, in full.
 *
 * It does not say what to do. It says what to look at.
 */
function Why({ points }: { points: readonly LabelledPoint[] }) {
  const driving = points
    .flatMap(({ point, label }) => point.findings.filter((f) => f.attention === 'alert' || f.attention === 'caution').map((f) => ({ f, where: `${label ? `${label} ` : ''}${point.waypoint}` })))
    .sort((a, b) => WEIGHT[a.f.attention]! - WEIGHT[b.f.attention]!);

  if (driving.length === 0) {
    return <p className="why-none">Nothing crossed your limits. Every check below is shown in full, each with the report it was read from.</p>;
  }
  return (
    <div className="why">
      <h3>Worth a look</h3>
      <ul className="findings">
        {driving.map(({ f, where }, i) => (
          <FindingRow key={i} f={f} waypoint={where} />
        ))}
      </ul>
    </div>
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

  const items = [...missing, ...fetchErrors, ...notamNotes];
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

function Point({ p, label }: { p: PointReview; label: string | null }) {
  const driving = p.findings.filter((f) => f.attention === 'alert' || f.attention === 'caution');
  const rest = p.findings.filter((f) => f.attention !== 'alert' && f.attention !== 'caution');
  return (
    <section className={`point ${(p.category ?? 'unknown').toLowerCase()}`}>
      <h3>
        {p.category && <span className={`category ${p.category.toLowerCase()}`}>{p.category}</span>}
        {p.forecastCategory && p.forecastCategory !== p.category && (
          <span className={`category forecast ${p.forecastCategory.toLowerCase()}`} title="the prevailing forecast at your ETA">
            {p.forecastCategory} forecast
          </span>
        )}
        {label ? `${label} ` : ''}
        {p.waypoint} <span className="at">at</span> <Zulu iso={p.at} /> {p.night && <span className="night">night</span>}
      </h3>
      {driving.length > 0 && (
        <ul className="findings">
          {driving.map((f, i) => (
            <FindingRow key={i} f={f} />
          ))}
        </ul>
      )}
      {rest.length > 0 && (
        <details className="met">
          <summary>
            {rest.length} check{rest.length === 1 ? '' : 's'} that met your limits
          </summary>
          <ul className="findings">
            {rest.map((f, i) => (
              <FindingRow key={i} f={f} />
            ))}
          </ul>
        </details>
      )}
    </section>
  );
}

export function BriefingView({ stored }: { stored: StoredBriefing }) {
  const b = stored.document.briefing;
  const points: LabelledPoint[] = [
    ...b.points.map((point) => ({ point, label: null })),
    ...(b.alternate ? [{ point: b.alternate, label: 'alternate' }] : []),
  ];
  return (
    <section className="briefing" id="verdict">
      <h2>
        <span className="briefing-title">Your briefing</span>
        <span className="meta">
          as of <Zulu iso={b.asOf} /> · profile {b.profile.name} v{b.profile.version}
          {b.aircraft ? ` · ${b.aircraft}` : ''} · rules v{b.rulesVersion} · briefing <code title="content hash">{stored.sha256.slice(0, 12)}</code>
        </span>
      </h2>

      <RouteStrip stored={stored} />

      <Why points={points} />
      <Gaps stored={stored} />

      <p className="explain">
        <b>This does not decide whether to fly.</b> It reports what the products say and compares them against the limits you set. A limit crossed in the
        prevailing forecast or a current observation reads as an <b>alert</b>; the same crossed inside a TEMPO, PROB or an in-progress BECMG reads as a{' '}
        <b>caution</b>, because the product is less certain. VFR, MVFR, IFR and LIFR are the standard classification of ceiling and visibility — a fact about
        the sky, not a judgement about your flight. Every line opens to the report text it was read from. Nothing is hidden: collapsing changes what you see
        first, never what exists.
      </p>

      {points.map(({ point, label }) => (
        <Point key={point.waypoint + point.at} p={point} label={label} />
      ))}
      {stored.document.notams && <NotamPanel doc={stored.document.notams} />}
      <details className="inputs-used">
        <summary>Reports this briefing was made from ({stored.document.inputs.reports.length})</summary>
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
