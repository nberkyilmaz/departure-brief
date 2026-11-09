import { useMemo, useState } from 'react';
import type { HeldReport } from './engine.js';
import { hhmmZ, local } from './time.js';
import type { StoredBriefing } from './types.js';

/**
 * Everything the briefing could see, exactly as it arrived.
 *
 * A verdict is only worth what the reports behind it are worth, so they get
 * a page of their own rather than living only inside the findings that
 * happened to cite them. Nothing here is summarised or reformatted: a METAR
 * is the string the weather service sent, a NOTAM is the text a pilot would
 * be handed, and each is named by the hash of its own bytes.
 */

const KINDS: Readonly<Record<string, string>> = {
  metar: 'METAR',
  taf: 'TAF',
  notam: 'NOTAM',
  upperwind: 'Upper wind',
  pirep: 'Pilot report',
};

/** The reports a briefing cited, for builds where the page did not fetch them itself. */
function fromBriefing(briefing: StoredBriefing | null): HeldReport[] {
  if (!briefing) return [];
  const seen = new Map<string, HeldReport>();
  const points = [...briefing.document.briefing.points, ...(briefing.document.briefing.alternate ? [briefing.document.briefing.alternate] : [])];
  for (const point of points) {
    for (const finding of point.findings) {
      for (const c of finding.citations) {
        if (!c.sha256 || !c.raw || seen.has(c.sha256)) continue;
        seen.set(c.sha256, { sha256: c.sha256, kind: c.kind, station: c.station, issuedAt: null, body: c.raw, fetchedFor: [] });
      }
    }
  }
  for (const n of briefing.document.notams?.items ?? []) {
    if (!seen.has(n.sha256)) seen.set(n.sha256, { sha256: n.sha256, kind: 'notam', station: n.locations[0] ?? null, issuedAt: n.from, body: n.raw, fetchedFor: n.sites });
  }
  return [...seen.values()];
}

function Report({ r }: { r: HeldReport }) {
  const [open, setOpen] = useState(false);
  const where = r.station ?? (r.fetchedFor.length > 0 ? `for ${r.fetchedFor.join(', ')}` : '—');
  return (
    <li className="held">
      <button className="row held-row" onClick={() => setOpen(!open)} aria-expanded={open}>
        <span className="badge kind">{KINDS[r.kind] ?? r.kind}</span>
        <span className="held-station">{where}</span>
        <span className="held-time">{r.issuedAt ? `${hhmmZ(r.issuedAt)} · ${local(r.issuedAt)} local` : ''}</span>
      </button>
      {open && (
        <>
          <pre className="raw">{r.body}</pre>
          <p className="field-note held-hash">
            Named by the hash of its bytes, <code>{r.sha256.slice(0, 12)}</code>, which is how the findings cite it.
          </p>
        </>
      )}
    </li>
  );
}

/** How many rows go on the page at once. Thousands of them is a page a phone cannot scroll. */
const PAGE = 200;

/**
 * Opens on the reports the briefing was judged on, because that is what
 * somebody arriving here from a briefing came to check. Everything else
 * the page holds — the whole continent's — is one choice away.
 */
export function ReportsPage({ held, briefing, when }: { held: readonly HeldReport[]; briefing: StoredBriefing | null; when: string | null }) {
  const all = held.length > 0 ? held : fromBriefing(briefing);
  const cited = useMemo(() => new Set(briefing?.document.inputs.reports.map((r) => r.sha256) ?? []), [briefing]);
  const flight = useMemo(() => all.filter((r) => cited.has(r.sha256)), [all, cited]);
  const [scope, setScope] = useState<'flight' | 'all'>('flight');
  const [kind, setKind] = useState<string>('all');
  const [station, setStation] = useState('');
  const [limit, setLimit] = useState(PAGE);

  const showing = scope === 'flight' && flight.length > 0 ? 'flight' : 'all';
  const base = showing === 'flight' ? flight : all;
  const kinds = useMemo(() => [...new Set(base.map((r) => r.kind))].sort(), [base]);
  const wanted = station.trim().toUpperCase();

  const shown = base
    .filter((r) => kind === 'all' || r.kind === kind)
    .filter((r) => wanted === '' || r.station === wanted || r.fetchedFor.includes(wanted))
    .sort((a, b) => (b.issuedAt ?? '').localeCompare(a.issuedAt ?? '') || a.kind.localeCompare(b.kind));

  return (
    <section className="reports-page">
      <h2>The reports</h2>
      <p className="explain">
        {showing === 'flight' ? 'The reports your briefing was judged on' : `Every report this page holds, ${all.length.toLocaleString('en')} of them`},
        exactly as the services sent them{when ? `, ${when}` : ''}. Tap one to read it.
      </p>

      {all.length === 0 ? (
        <p className="field-note">Nothing yet. Brief a flight and the reports it was judged on will be here.</p>
      ) : (
        <>
          <div className="filters">
            {flight.length > 0 && (
              <label className="inline">
                Show
                <select
                  value={showing}
                  onChange={(e) => {
                    setScope(e.target.value as 'flight' | 'all');
                    setLimit(PAGE);
                  }}
                >
                  <option value="flight">your flight ({flight.length})</option>
                  <option value="all">everything held ({all.length.toLocaleString('en')})</option>
                </select>
              </label>
            )}
            <label className="inline">
              Kind
              <select value={kind} onChange={(e) => setKind(e.target.value)}>
                <option value="all">all</option>
                {kinds.map((k) => (
                  <option key={k} value={k}>
                    {KINDS[k] ?? k} ({base.filter((r) => r.kind === k).length})
                  </option>
                ))}
              </select>
            </label>
            <label className="inline">
              Station
              <input
                className="held-search"
                value={station}
                onChange={(e) => {
                  setStation(e.target.value.replace(/[^A-Za-z0-9]/g, ''));
                  setLimit(PAGE);
                }}
                placeholder="CYSN"
                autoCapitalize="characters"
                autoCorrect="off"
                spellCheck={false}
              />
            </label>
            <span className="field-note">
              {shown.length.toLocaleString('en')} shown{shown.length !== base.length ? ` of ${base.length.toLocaleString('en')}` : ''}
            </span>
          </div>

          <ul className="findings held-list">
            {shown.slice(0, limit).map((r) => (
              <Report key={r.sha256} r={r} />
            ))}
          </ul>
          {shown.length > limit && (
            <button type="button" className="quiet held-more" onClick={() => setLimit(limit + PAGE)}>
              Show {Math.min(PAGE, shown.length - limit)} more of {(shown.length - limit).toLocaleString('en')}
            </button>
          )}
        </>
      )}
    </section>
  );
}
