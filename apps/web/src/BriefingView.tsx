import { useState } from 'react';
import { NotamPanel } from './NotamPanel.js';
import { RouteStrip } from './RouteStrip.js';
import { hhmmZ, local, zulu } from './time.js';
import type { Citation, Finding, PointVerdict, StoredBriefing, Verdict } from './types.js';

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
  if (!c.span) return <pre className="raw">{c.raw}</pre>;
  return (
    <pre className="raw">
      {c.raw.slice(0, c.span.start)}
      <mark>{c.raw.slice(c.span.start, c.span.end)}</mark>
      {c.raw.slice(c.span.end)}
    </pre>
  );
}

function FindingRow({ f, waypoint = null }: { f: Finding; waypoint?: string | null }) {
  const [open, setOpen] = useState(false);
  const sources = f.citations.filter((c) => c.raw);
  const others = f.citations.filter((c) => !c.raw && c.text);
  return (
    <li className={`finding ${f.severity}`}>
      <button className="row" onClick={() => setOpen(!open)} aria-expanded={open}>
        <span className={`badge ${f.severity}`}>{f.severity}</span>
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

const WEIGHT: Record<string, number> = { 'no-go': 0, marginal: 1, advisory: 2, ok: 3 };

/** A waypoint, and what to call it when it is the alternate rather than a leg. */
interface LabelledPoint {
  readonly point: PointVerdict;
  readonly label: string | null;
}

/**
 * The reasons the verdict is what it is, and nothing else.
 *
 * A briefing produces dozens of findings and most of them say a limit was
 * met. Leading with all of them buries the two that matter. This shows only
 * what moved the verdict, worst first, with the detail one tap away — the
 * rest is still below, in full.
 */
function Why({ verdict, points }: { verdict: Verdict; points: readonly LabelledPoint[] }) {
  const driving = points
    .flatMap(({ point, label }) => point.findings.filter((f) => f.severity === 'no-go' || f.severity === 'marginal').map((f) => ({ f, where: `${label ? `${label} ` : ''}${point.waypoint}` })))
    .sort((a, b) => WEIGHT[a.f.severity]! - WEIGHT[b.f.severity]!);

  if (driving.length === 0) {
    return (
      <p className="why-none">
        Nothing crossed your limits. {verdict === 'go' ? 'Every check below met them' : 'The verdict comes from the checks below'}, and each one shows the
        report it was judged on.
      </p>
    );
  }
  return (
    <div className="why">
      <h3>Why</h3>
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

function Point({ p, label }: { p: PointVerdict; label: string | null }) {
  const driving = p.findings.filter((f) => f.severity === 'no-go' || f.severity === 'marginal');
  const rest = p.findings.filter((f) => f.severity !== 'no-go' && f.severity !== 'marginal');
  return (
    <section className={`point ${p.verdict}`}>
      <h3>
        <span className={`verdict ${p.verdict}`}>{p.verdict.toUpperCase()}</span> {label ? `${label} ` : ''}
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
        <span className={`verdict big ${b.verdict}`}>{b.verdict.toUpperCase()}</span>
        <span className="meta">
          as of <Zulu iso={b.asOf} /> · profile {b.profile.name} v{b.profile.version}
          {b.aircraft ? ` · ${b.aircraft}` : ''} · rules v{b.rulesVersion} · briefing <code title="content hash">{stored.sha256.slice(0, 12)}</code>
        </span>
      </h2>

      <RouteStrip stored={stored} />

      <Why verdict={b.verdict} points={points} />
      <Gaps stored={stored} />

      <p className="explain">
        A violation in the prevailing forecast or a current observation is <b>no-go</b>; the same violation inside a TEMPO, PROB or an in-progress BECMG is{' '}
        <b>marginal</b>. Every line opens to the report text it was judged on. Nothing is hidden — collapsing changes what you see first, never what exists.
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
