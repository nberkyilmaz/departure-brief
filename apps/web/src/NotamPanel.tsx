import { useState } from 'react';
import type { NotamDocument, NotamItem, NotamRank } from './types.js';

const ORDER: NotamRank[] = ['critical', 'advisory', 'unverified', 'not-assessed', 'irrelevant', 'out-of-scope'];
const TITLE: Record<NotamRank, string> = {
  critical: 'Critical for this flight',
  advisory: 'Advisory',
  unverified: 'Model answer could not be verified',
  'not-assessed': 'In scope, not ranked (no model configured)',
  irrelevant: 'Judged irrelevant to this flight',
  'out-of-scope': 'Outside the flight window or area',
};
const OPEN_BY_DEFAULT = new Set<NotamRank>(['critical', 'advisory', 'unverified', 'not-assessed']);

/** The NOTAM text with the model's cited span highlighted — the grounding for the ranking. */
function Cited({ text, span }: { text: string; span: string | null }) {
  if (!span) return <pre className="raw">{text}</pre>;
  const i = text.indexOf(span);
  if (i < 0) {
    const norm = (s: string) => s.replace(/\s+/g, ' ').trim().toUpperCase();
    const j = norm(text).indexOf(norm(span));
    if (j < 0) return <pre className="raw">{text}</pre>;
  }
  return (
    <pre className="raw">
      {i < 0 ? text : text.slice(0, i)}
      {i >= 0 && <mark>{span}</mark>}
      {i >= 0 ? text.slice(i + span.length) : ''}
    </pre>
  );
}

function Item({ n }: { n: NotamItem }) {
  const [open, setOpen] = useState(n.rank === 'critical' || n.rank === 'unverified');
  const meaning = n.qcodeMeaning ? [n.qcodeMeaning.subject, n.qcodeMeaning.condition].filter(Boolean).join(' — ') : n.qcode;
  return (
    <li className={`notam ${n.rank}`}>
      <button className="row notam-row" onClick={() => setOpen(!open)} aria-expanded={open}>
        <span className="notam-id">{n.id ?? '—'}</span>
        <span className="notam-meaning">{meaning ?? ''}</span>
        <span className="notam-summary">{n.assessment ? n.assessment.result.plain_text : (n.text ?? '').replace(/\s+/g, ' ').slice(0, 140)}</span>
      </button>
      {open && (
        <div className="detail">
          {n.assessment && (
            <p className="model">
              <b>{n.assessment.result.relevance}</b> · {n.assessment.result.category} · {n.assessment.result.affects.join(', ') || 'no phase'} — {n.assessment.result.rationale}
              <br />
              <small>
                {n.assessment.model}, prompt v{n.assessment.promptVersion}
                {n.assessment.cached ? ', cached' : ''} · citation {n.assessment.citation === 'none' ? <b className="bad">not found in the NOTAM</b> : 'verified'}
              </small>
            </p>
          )}
          {n.assessmentError && <p className="bad">{n.assessmentError}</p>}
          <p className="reasons">
            {n.classification.reasons.join(' · ')}
            {n.sites.length > 1 ? ` · fetched for ${n.sites.join(', ')}` : ''}
            {n.supersededBy ? ` · superseded by ${n.supersededBy}` : ''}
          </p>
          <Cited text={n.raw} span={n.assessment?.result.cited_span ?? null} />
        </div>
      )}
    </li>
  );
}

export function NotamPanel({ doc }: { doc: NotamDocument }) {
  const groups = ORDER.map((rank) => ({ rank, items: doc.items.filter((i) => i.rank === rank) })).filter((g) => g.items.length > 0);
  return (
    <section className="notams">
      <h2>
        NOTAMs <span className="meta">{doc.sites.join(', ')} · {doc.items.length} total · {doc.model ? `ranked by ${doc.model}` : 'not ranked — no model configured'}</span>
      </h2>
      <p className="explain">
        Every NOTAM the sources returned is here. Ranking and grouping change the order and what is expanded, never what is shown. A model
        answer is only trusted when the text it cites is really in the NOTAM.
      </p>
      {doc.fetchErrors.map((e) => (
        <p key={e.site} className="error">
          {e.site}: NOTAM fetch failed — {e.error}
        </p>
      ))}
      {groups.map((g) => (
        <details key={g.rank} open={OPEN_BY_DEFAULT.has(g.rank)} className={`notam-group ${g.rank}`}>
          <summary>
            <span className={`badge ${g.rank === 'critical' ? 'no-go' : g.rank === 'advisory' ? 'marginal' : g.rank === 'unverified' ? 'marginal' : 'advisory'}`}>{g.items.length}</span> {TITLE[g.rank]}
          </summary>
          <ul className="findings">
            {g.items.map((n) => (
              <Item key={n.sha256} n={n} />
            ))}
          </ul>
        </details>
      ))}
    </section>
  );
}
