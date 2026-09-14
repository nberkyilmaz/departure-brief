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
        <code title="content hash of these bytes">{r.sha256.slice(0, 12)}</code>
      </button>
      {open && <pre className="raw">{r.body}</pre>}
    </li>
  );
}

export function ReportsPage({ held, briefing, recordedAt }: { held: readonly HeldReport[]; briefing: StoredBriefing | null; recordedAt: string | null }) {
  const all = held.length > 0 ? held : fromBriefing(briefing);
  const [kind, setKind] = useState<string>('all');
  const [station, setStation] = useState<string>('all');

  const stations = useMemo(() => [...new Set(all.flatMap((r) => (r.station ? [r.station] : r.fetchedFor)))].sort(), [all]);
  const kinds = useMemo(() => [...new Set(all.map((r) => r.kind))].sort(), [all]);

  const shown = all
    .filter((r) => kind === 'all' || r.kind === kind)
    .filter((r) => station === 'all' || r.station === station || r.fetchedFor.includes(station))
    .sort((a, b) => (b.issuedAt ?? '').localeCompare(a.issuedAt ?? '') || a.kind.localeCompare(b.kind));

  return (
    <section className="reports-page">
      <h2>The reports</h2>
      <p className="explain">
        Every report this page holds, exactly as the service sent it — {all.length} of them
        {recordedAt ? `, recorded on ${recordedAt}` : ''}. Each is named by the hash of its own bytes, which is the same name the findings cite. Open one to
        read it.
      </p>

      {all.length === 0 ? (
        <p className="field-note">Nothing yet. Brief a flight and the reports it was judged on will be here.</p>
      ) : (
        <>
          <div className="filters">
            <label className="inline">
              Kind
              <select value={kind} onChange={(e) => setKind(e.target.value)}>
                <option value="all">all ({all.length})</option>
                {kinds.map((k) => (
                  <option key={k} value={k}>
                    {KINDS[k] ?? k} ({all.filter((r) => r.kind === k).length})
                  </option>
                ))}
              </select>
            </label>
            <label className="inline">
              Aerodrome
              <select value={station} onChange={(e) => setStation(e.target.value)}>
                <option value="all">all</option>
                {stations.map((s) => (
                  <option key={s} value={s}>
                    {s}
                  </option>
                ))}
              </select>
            </label>
            <span className="field-note">
              {shown.length} shown{shown.length !== all.length ? ` of ${all.length}` : ''}
            </span>
          </div>

          <ul className="findings held-list">
            {shown.map((r) => (
              <Report key={r.sha256} r={r} />
            ))}
          </ul>
        </>
      )}
    </section>
  );
}
