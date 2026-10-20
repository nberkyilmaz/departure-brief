import { zulu } from './time.js';
import type { BriefingDiff, FindingChange, PointDiff } from './types.js';

const LABEL: Record<FindingChange['kind'], string> = {
  worsened: 'worse',
  appeared: 'new',
  eased: 'better',
  resolved: 'gone',
  restated: 'same',
};

function Change({ c }: { c: FindingChange }) {
  const f = c.after ?? c.before!;
  const severity = c.kind === 'worsened' || (c.kind === 'appeared' && c.crossesLimit) ? 'alert' : c.kind === 'eased' || c.kind === 'resolved' ? 'ok' : 'note';
  return (
    <li className={`change ${c.crossesLimit ? 'crosses' : ''}`}>
      <span className={`badge ${severity}`}>{LABEL[c.kind]}</span>
      <span className="basis">{f.basis}</span>
      <span className="summary">
        {c.kind === 'worsened' || c.kind === 'eased' ? (
          <>
            <s>{c.before!.attention}</s> {c.after!.attention}: {c.after!.summary}
          </>
        ) : (
          f.summary
        )}
      </span>
    </li>
  );
}

function Point({ p, label }: { p: PointDiff; label?: string }) {
  const material = p.changes.filter((c) => c.kind !== 'restated');
  if (!p.category && material.length === 0) return null;
  return (
    <div className="diff-point">
      <h4>
        {label}
        {p.waypoint}
        {p.category && (
          <>
            {' '}
            <span className={`category ${(p.category.from ?? 'unknown').toLowerCase()}`}>{p.category.from ?? '—'}</span> →{' '}
            <span className={`category ${(p.category.to ?? 'unknown').toLowerCase()}`}>{p.category.to ?? '—'}</span>
          </>
        )}
      </h4>
      <ul className="findings">
        {material.map((c, i) => (
          <Change key={i} c={c} />
        ))}
      </ul>
    </div>
  );
}

/** What changed since the previous briefing of this flight. */
export function DiffPanel({ d }: { d: BriefingDiff }) {
  const newNotams = d.notams.filter((n) => n.kind === 'new');
  const rankChanged = d.notams.filter((n) => n.kind === 'rank-changed');
  return (
    <section className="diff">
      <h2>
        Since your last briefing <span className="meta">{zulu(d.from.asOf)} → {zulu(d.to.asOf)}</span>
      </h2>
      {d.warnings.map((w) => (
        <p key={w} className="error">
          {w}
        </p>
      ))}
      {d.quiet ? (
        <p className="explain">Nothing material changed. Values moved without crossing any of your limits.</p>
      ) : (
        <p className="explain">Highlighted lines crossed one of your limits — newly breached, or newly met.</p>
      )}
      {d.points.map((p) => (
        <Point key={p.waypoint} p={p} />
      ))}
      {d.alternate && <Point p={d.alternate} label="alternate " />}
      {(newNotams.length > 0 || rankChanged.length > 0) && (
        <div className="diff-point">
          <h4>NOTAMs</h4>
          <ul className="findings">
            {newNotams.map((n) => (
              <li key={n.sha256} className={`change ${n.notable ? 'crosses' : ''}`}>
                <span className={`badge ${n.notable ? 'alert' : 'note'}`}>new</span>
                <span className="basis">{n.id}</span>
                <span className="summary">{n.summary}</span>
              </li>
            ))}
            {rankChanged.map((n) => (
              <li key={n.sha256} className="change">
                <span className="badge advisory">changed</span>
                <span className="basis">{n.id}</span>
                <span className="summary">
                  {n.from} → {n.to}: {n.summary}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
