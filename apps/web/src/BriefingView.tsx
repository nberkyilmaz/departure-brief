import { useState } from 'react';
import { NotamPanel } from './NotamPanel.js';
import { aerodromeHref } from './router.js';
import { concernsOf, fieldCards, TOPIC_LABEL, type Concern, type FieldCard } from './summary.js';
import { hhmmZ, local, localClock, zulu } from './time.js';
import type { Citation, Finding, StoredBriefing } from './types.js';

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

function FindingRow({ f }: { f: Finding }) {
  const [open, setOpen] = useState(false);
  const sources = f.citations.filter((c) => c.raw);
  const others = f.citations.filter((c) => !c.raw && c.text);
  return (
    <li className={`finding ${f.attention}`}>
      <button className="row" onClick={() => setOpen(!open)} aria-expanded={open}>
        {f.rule === 'observation.age' ? <AgeBadge f={f} /> : <span className={`badge ${f.attention}`}>{f.attention}</span>}
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

  const items = [...missing, ...noWind, ...fetchErrors, ...notamNotes];
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
 * A list of findings, most wanting of attention first, each opening to the
 * report it was read from. Shared with the aerodrome page so a field looked
 * up on its own reads exactly as it does inside a briefing.
 */
export function FindingList({ findings }: { findings: readonly Finding[] }) {
  const order: Record<string, number> = { alert: 0, caution: 1, note: 2, routine: 3 };
  const sorted = [...findings].sort((a, b) => (order[a.attention] ?? 9) - (order[b.attention] ?? 9));
  if (sorted.length === 0) return <p className="field-note">Nothing to report.</p>;
  return (
    <ul className="findings">
      {sorted.map((f, i) => (
        <FindingRow key={`${f.rule}-${i}`} f={f} />
      ))}
    </ul>
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
          {c.role === 'Alternate' ? 'Alternate ' : ''}
          {c.waypoint} · {TOPIC_LABEL[c.topic]}
        </span>
        <span className="concern-text">
          {c.headline}
          {c.when.length > 0 && <span className="concern-when">{c.when.join(' · ')}</span>}
        </span>
      </button>
      {open && (
        <div className="concern-detail">
          <FindingList findings={c.findings} />
        </div>
      )}
    </li>
  );
}

/**
 * What crossed a limit, one line per field and topic, worst first. It does
 * not say what to do; it says what to look at, and each line opens to the
 * findings and reports behind it.
 */
function WorthALook({ concerns }: { concerns: readonly Concern[] }) {
  if (concerns.length === 0) {
    return <p className="why-none">Nothing crossed your limits at any field. Each card below has every check, with the report it came from.</p>;
  }
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

export function BriefingView({ stored, nameOf }: { stored: StoredBriefing; nameOf?: (id: string) => string | null }) {
  const b = stored.document.briefing;
  const cards = fieldCards(stored);
  return (
    <section className="briefing" id="verdict">
      <h2>
        <span className="briefing-title">Your briefing</span>
        <span className="meta">
          weather as of <Zulu iso={b.asOf} />
        </span>
      </h2>
      <p className="explain briefing-lede">It compares the forecasts and reports with your minimums. It does not decide whether you go; that stays with you.</p>

      {/* Adverse conditions first, as a standard briefing gives them; then each field; then what it could not see. */}
      <WorthALook concerns={concernsOf(stored)} />

      <div className="field-cards">
        {cards.map((c) => (
          <FieldCardView key={`${c.role}-${c.point.waypoint}-${c.point.at}`} c={c} name={nameOf?.(c.point.waypoint) ?? null} />
        ))}
      </div>

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
