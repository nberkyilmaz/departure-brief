import { useState } from 'react';
import { NotamPanel } from './NotamPanel.js';
import { hhmmZ, local, zulu } from './time.js';
import type { Citation, Finding, PointVerdict, StoredBriefing } from './types.js';

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

function FindingRow({ f }: { f: Finding }) {
  const [open, setOpen] = useState(f.severity === 'no-go' || f.severity === 'marginal');
  const sources = f.citations.filter((c) => c.raw);
  const others = f.citations.filter((c) => !c.raw && c.text);
  return (
    <li className={`finding ${f.severity}`}>
      <button className="row" onClick={() => setOpen(!open)} aria-expanded={open}>
        <span className={`badge ${f.severity}`}>{f.severity}</span>
        <span className="basis">{f.basis}</span>
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

function Point({ p, label }: { p: PointVerdict; label?: string }) {
  return (
    <section className={`point ${p.verdict}`}>
      <h3>
        <span className={`verdict ${p.verdict}`}>{p.verdict.toUpperCase()}</span> {label ? `${label} ` : ''}
        {p.waypoint} <span className="at">at</span> <Zulu iso={p.at} /> {p.night && <span className="night">night</span>}
      </h3>
      <ul className="findings">
        {p.findings.map((f, i) => (
          <FindingRow key={i} f={f} />
        ))}
      </ul>
    </section>
  );
}

export function BriefingView({ stored }: { stored: StoredBriefing }) {
  const b = stored.document.briefing;
  return (
    <section className="briefing">
      <h2>
        <span className={`verdict big ${b.verdict}`}>{b.verdict.toUpperCase()}</span>
        <span className="meta">
          as of <Zulu iso={b.asOf} /> · profile {b.profile.name} v{b.profile.version}
          {b.aircraft ? ` · ${b.aircraft}` : ''} · rules v{b.rulesVersion} · briefing <code title="content hash">{stored.sha256.slice(0, 12)}</code>
        </span>
      </h2>
      <p className="explain">
        Every line below shows the report text it was judged on. A violation in the prevailing forecast or a current observation is <b>no-go</b>;
        the same violation inside a TEMPO, PROB or in-progress BECMG is <b>marginal</b>. Nothing is hidden.
      </p>
      {b.points.map((p) => (
        <Point key={p.waypoint + p.at} p={p} />
      ))}
      {b.alternate && <Point p={b.alternate} label="alternate" />}
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
