import { computeLoading, IncompleteSpecError, type Loading, type WeightBalanceSpec as CoreSpec } from '@depbrief/core/judge';
import { useEffect, useState } from 'react';
import type { DocumentCitation, LoadingResult, WeightBalanceSpec } from './types.js';

/** A page region from the POH, served by the API as a crop with the cited words boxed. */
function Crop({ c, crops }: { c: DocumentCitation; crops: boolean }) {
  if (!c.box || !crops) {
    return (
      <span className="source-label">
        {c.filename} p.{c.page}: "{c.citedText}"
      </span>
    );
  }
  const q = new URLSearchParams({ x: String(c.box.x), y: String(c.box.y), w: String(c.box.w), h: String(c.box.h) });
  return (
    <figure className="crop">
      <img src={`/api/documents/${c.documentSha256}/pages/${c.page}/crop?${q}`} alt={`${c.filename} page ${c.page}: ${c.citedText}`} loading="lazy" />
      <figcaption>
        {c.filename} p.{c.page} — "{c.citedText}"
      </figcaption>
    </figure>
  );
}

interface Entry {
  value: string;
  /** Prefilled from the POH's sample airplane and not yet replaced by the owner's own figure. */
  fromSample: boolean;
}

const entry = (value: string, fromSample = false): Entry => ({ value, fromSample });

/**
 * Weight and balance for the aircraft type: the limits as the POH prints
 * them (each one a crop of the page it came from), a loading form built
 * from the stations that data actually carries, and the computed CG.
 *
 * The form is built from `spec.stations` rather than from a fixed list of
 * seats and lockers, because a station whose arm did not survive
 * verification is not in the spec — and a weight typed against a station
 * the computation does not know would simply not be counted.
 */
export function WbPanel({
  aircraftType,
  spec: given = null,
  crops = true,
}: {
  aircraftType: string;
  /** The handbook data, when the page already has it and there is no API to ask. */
  spec?: WeightBalanceSpec | null;
  /** Whether page crops can be fetched; they are served by the API. */
  crops?: boolean;
}) {
  const [spec, setSpec] = useState<WeightBalanceSpec | null | 'missing'>(null);
  const [empty, setEmpty] = useState<Entry>(entry(''));
  const [emptyMoment, setEmptyMoment] = useState<Entry>(entry(''));
  const [loads, setLoads] = useState<Record<string, string>>({});
  const [utility, setUtility] = useState(false);
  const [result, setResult] = useState<LoadingResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setSpec(null);
    setResult(null);
    setError(null);
    setEmpty(entry(''));
    setEmptyMoment(entry(''));
    setLoads({});
    let live = true;
    const arrive = (s: WeightBalanceSpec | 'missing') => {
      if (!live) return;
      setSpec(s);
      if (s === 'missing') return;
      if (s.sample) {
        setEmpty(entry(String(s.sample.emptyWeightLb.value), true));
        setEmptyMoment(entry(String(s.sample.emptyMomentPer1000.value), true));
      }
      setLoads(Object.fromEntries(s.stations.filter((st) => st.kind !== 'oil').map((st) => [st.id, '0'])));
    };
    if (given) arrive(given.aircraftType.toUpperCase() === aircraftType.toUpperCase() ? given : 'missing');
    else {
      fetch(`/api/aircraft/${encodeURIComponent(aircraftType)}/wb`)
        .then(async (r) => (r.ok ? ((await r.json()) as WeightBalanceSpec) : 'missing'))
        .then(arrive)
        .catch(() => live && setSpec('missing'));
    }
    return () => {
      live = false;
    };
  }, [aircraftType, given]);

  async function compute() {
    if (spec === null || spec === 'missing') return;
    setError(null);
    const num = (s: string) => (s.trim() === '' ? 0 : Number(s));
    const stations: Record<string, number> = {};
    const fuelGal: Record<string, number> = {};
    for (const st of spec.stations) {
      if (st.kind === 'oil') continue;
      (st.kind === 'fuel' ? fuelGal : stations)[st.id] = num(loads[st.id] ?? '0');
    }
    const loading: Loading = {
      emptyWeightLb: num(empty.value),
      emptyMomentPer1000: num(emptyMoment.value),
      stations,
      fuelGal,
      category: utility ? 'utility' : 'normal',
    };
    // The same computation either way; only where it runs differs.
    if (given) {
      try {
        setResult(JSON.parse(JSON.stringify(computeLoading(given as unknown as CoreSpec, loading))) as LoadingResult);
      } catch (e) {
        setResult(null);
        setError(e instanceof IncompleteSpecError ? e.message : (e as Error).message);
      }
      return;
    }
    const res = await fetch(`/api/aircraft/${encodeURIComponent(aircraftType)}/wb`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(loading),
    });
    const body = (await res.json()) as LoadingResult | { error: string };
    if (!res.ok || 'error' in body) {
      setResult(null);
      setError('error' in body ? body.error : `HTTP ${res.status}`);
      return;
    }
    setResult(body);
  }

  if (spec === null) return null;
  if (spec === 'missing') {
    return (
      <section className="wb">
        <h2>Weight and balance</h2>
        <p className="explain">
          No weight-and-balance data for {aircraftType} yet. Read it out of the handbook with <code>depbrief doc wb &lt;poh.pdf&gt; --type {aircraftType}</code>.
        </p>
      </section>
    );
  }

  const usable = spec.envelopes.length > 0 && spec.stations.length > 0;
  const stillSample = empty.fromSample || emptyMoment.fromSample;
  return (
    <section className="wb">
      <h2>
        Weight and balance{' '}
        <span className="meta">
          {spec.aircraftType} · from {spec.source?.filename ?? 'typed-in data'} · {spec.review.length} figures awaiting your review
        </span>
      </h2>
      <p className="explain">
        Every limit below was read out of the handbook by a model and then checked against the words on the page. A figure the page does not back is never
        used — it is listed at the bottom for you to confirm. Empty weight and moment are yours to supply, from the aircraft's own weight-and-balance record.
      </p>
      {!usable && (
        <p className="error">
          Not enough of the handbook was read to compute a loading yet: {spec.envelopes.length === 0 ? 'no centre-of-gravity envelope' : 'no stations'}. Confirm
          the figures below, or add them to <code>aircraft/{spec.aircraftType.toLowerCase()}.wb.json</code>.
        </p>
      )}
      {usable && (
        <>
          <div className="grid">
            <label>
              Empty weight (lb)
              <input type="number" value={empty.value} onChange={(e) => setEmpty(entry(e.target.value))} />
            </label>
            <label>
              Empty moment /1000
              <input type="number" value={emptyMoment.value} onChange={(e) => setEmptyMoment(entry(e.target.value))} />
            </label>
            {spec.stations
              .filter((st) => st.kind !== 'oil')
              .map((st) => (
                <label key={st.id}>
                  {st.label} ({st.kind === 'fuel' ? 'US gal' : 'lb'})
                  <input type="number" value={loads[st.id] ?? '0'} onChange={(e) => setLoads({ ...loads, [st.id]: e.target.value })} />
                </label>
              ))}
            {spec.envelopes.some((e) => e.category === 'utility') && (
              <label className="check">
                <input type="checkbox" checked={utility} onChange={(e) => setUtility(e.target.checked)} /> utility category
              </label>
            )}
          </div>
          {stillSample && (
            <p className="hint">
              The empty weight and moment above are the handbook's <b>sample airplane</b>, not yours. Replace them with the figures from your aircraft's
              weight-and-balance record before trusting anything below.
            </p>
          )}
          <div className="actions">
            <button onClick={compute}>Compute</button>
            {error && <p className="error">{error}</p>}
          </div>
        </>
      )}
      {result && (
        <div className={`point ${result.verdict === 'within-limits' ? 'vfr' : 'ifr'}`}>
          <h3>
            <span className={`category ${result.verdict === 'within-limits' ? 'vfr' : 'ifr'}`}>{result.verdict === 'within-limits' ? 'WITHIN LIMITS' : 'OUTSIDE LIMITS'}</span>
            <span className="at">
              {result.totalWeightLb} lb · CG {result.cgIn} in · {result.category} category (forward limit {result.limits.forwardArmIn} in at this weight, aft{' '}
              {result.limits.aftArmIn} in, max {result.limits.maxWeightLb} lb)
            </span>
          </h3>
          {stillSample && <p className="hint">Computed from the handbook's sample empty weight, not your aircraft's.</p>}
          <div className="table-scroll">
            <table className="wb-table">
              <thead>
                <tr>
                  <th>item</th>
                  <th>lb</th>
                  <th>arm in</th>
                  <th>moment /1000</th>
                </tr>
              </thead>
              <tbody>
                {result.rows.map((r) => (
                  <tr key={r.label}>
                    <td>{r.label}</td>
                    <td>{r.weightLb.toFixed(1)}</td>
                    <td>{r.armIn.toFixed(1)}</td>
                    <td>{r.momentPer1000.toFixed(1)}</td>
                  </tr>
                ))}
                <tr className="total">
                  <td>Total</td>
                  <td>{result.totalWeightLb.toFixed(1)}</td>
                  <td>{result.cgIn.toFixed(1)}</td>
                  <td>{result.totalMomentPer1000.toFixed(1)}</td>
                </tr>
              </tbody>
            </table>
          </div>
          <ul className="findings">
            {result.findings.map((f, i) => (
              <li key={`${f.rule}-${i}`} className="finding">
                <div className="row wb-row">
                  <span className={`badge ${f.severity === 'routine' ? 'routine' : 'alert'}`}>{f.severity}</span>
                  <span className="summary">{f.summary}</span>
                </div>
                <div className="detail">
                  {f.citations.map((c, j) => (
                    <Crop key={j} crops={crops} c={c} />
                  ))}
                </div>
              </li>
            ))}
          </ul>
          <p className="explain">Study aid only — not an official weight-and-balance computation. Verify against the aircraft's weight-and-balance record and the POH.</p>
        </div>
      )}
      {spec.review.length > 0 && (
        <details className="inputs-used">
          <summary>{spec.review.length} figures the page did not back — for your review, never used in the numbers above</summary>
          <ul>
            {spec.review.map((r, i) => (
              <li key={`${r.field}-${i}`}>
                <b>{r.field}</b> ({r.description}): the model proposed {typeof r.proposed === 'number' ? r.proposed : `${r.proposed.weightLb} lb @ ${r.proposed.armIn} in`} from page {r.page} — {r.problem}
              </li>
            ))}
          </ul>
        </details>
      )}
    </section>
  );
}
