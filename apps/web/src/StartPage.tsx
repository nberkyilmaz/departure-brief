import { Component, lazy, Suspense, useMemo, useState, type ReactNode } from 'react';
import type { LocalEngine, WeatherSource } from './engine.js';
import { aerodromeHref, hrefFor } from './router.js';
import { aerodromeSearch } from './search.js';
import { recordedWhen, weatherAge } from './WeatherNote.js';

// The map library is only worth downloading on the page that shows a map.
const WeatherMap = lazy(() => import('./WeatherMap.js'));

const CATEGORIES = ['VFR', 'MVFR', 'IFR', 'LIFR'] as const;

/** If the map's code cannot be downloaded — offline, or a deploy mid-flight — the page carries on without it. */
class MapBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  override state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  override render() {
    return this.state.failed ? <div className="wx-map wx-map-loading">The map could not be loaded. Every station is still one search away.</div> : this.props.children;
  }
}

/**
 * What a visitor meets.
 *
 * Not a form. Most arrivals want one of two things — to look up a field, or
 * to see what this is — and being handed a flight plan to fill in before
 * either is possible is the reason people leave. So it opens on the weather
 * itself: every station reporting, coloured the way every weather service
 * colours them, each one a link to its own page.
 */
export function StartPage({ engine, weather, home }: { engine: LocalEngine | null; weather: WeatherSource | null; home: string }) {
  const [id, setId] = useState('');
  const code = id.trim().toUpperCase();
  const stations = useMemo(() => engine?.stations() ?? [], [engine]);
  const search = useMemo(() => aerodromeSearch(engine?.aerodromes ?? [], new Set(stations.map((s) => s.id))), [engine, stations]);
  const known = search(code);
  const counts = useMemo(() => {
    const c = new Map<string, number>();
    for (const s of stations) c.set(s.category ?? 'unclassified', (c.get(s.category ?? 'unclassified') ?? 0) + 1);
    return c;
  }, [stations]);
  const homeStation = engine?.stations().find((s) => s.id === home) ?? null;
  const centre = useMemo(() => {
    const a = engine?.aerodromes.find((x) => x.id === home);
    return a ? { lat: a.lat, lon: a.lon } : null;
  }, [engine, home]);

  return (
    <section className="start">
      <div className="start-intro">
        <p className="lede">
          Every METAR, TAF and NOTAM you would read before a flight — decoded, placed on your route at the time you will be there, and checked against your
          own minimums. Every line cites the report it came from. It does not decide whether to fly; that stays with you.
        </p>

        <form
          className="start-search"
          onSubmit={(e) => {
            e.preventDefault();
            if (code !== '') window.location.hash = aerodromeHref(code);
          }}
        >
          <label>
            Look up an aerodrome
            <input
              value={id}
              onChange={(e) => setId(e.target.value.replace(/[^A-Za-z0-9 ]/g, ''))}
              placeholder="CYSN, Toronto, KMIA…"
              autoCapitalize="characters"
              autoCorrect="off"
              spellCheck={false}
            />
          </label>
          <button type="submit" disabled={code === ''}>
            Go
          </button>
        </form>

        {code !== '' && known.length > 0 && (
          <ul className="start-matches">
            {known.map((a) => (
              <li key={a.id}>
                <a href={aerodromeHref(a.id)}>{a.id}</a> <span className="muted">{a.name}</span>
                {a.faaId && <span className="muted"> · {a.faaId}</span>}
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* The three ways on, above the map so they are on screen without scrolling; briefing a flight is the main one. */}
      <div className="start-links">
        <a className="start-card primary" href={hrefFor({ name: 'brief' })}>
          <b>Brief a flight</b>
          <span className="muted">route, times, your minimums</span>
        </a>
        <a className="start-card" href={aerodromeHref(home)}>
          <b>{home}</b>
          <span className="muted">your home field</span>
        </a>
        <a className="start-card" href={hrefFor({ name: 'about' })}>
          <b>How this works</b>
          <span className="muted">and how far to trust it</span>
        </a>
      </div>

      <div className="wx-card">
        <div className="wx-head">
          <h2>
            {weather?.mode === 'live' ? 'Reporting now' : 'Reporting when recorded'}
            <span className="meta">
              {stations.length > 0 && ` · ${stations.length} stations`}
              {weather && (weather.mode === 'live' ? ` · ${weatherAge(weather.at)}` : ` · ${recordedWhen(weather.at)}`)}
            </span>
          </h2>
          <ul className="legend" aria-label="Flight categories">
            {CATEGORIES.map((c) => (
              <li key={c}>
                <span className={`dot ${c.toLowerCase()}`} aria-hidden="true" />
                {c} <span className="muted">{counts.get(c) ?? 0}</span>
              </li>
            ))}
          </ul>
        </div>
        {engine ? (
          <MapBoundary>
            <Suspense fallback={<div className="wx-map wx-map-loading">Loading the map…</div>}>
              <WeatherMap stations={stations} centre={centre} />
            </Suspense>
          </MapBoundary>
        ) : (
          <div className="wx-map wx-map-loading">{weather === null ? 'Fetching the reports…' : ''}</div>
        )}
        <p className="field-note wx-foot">
          Tap a station for its report, read back line by line.
          {homeStation && (
            <>
              {' '}
              Your home field <a href={aerodromeHref(home)}>{home}</a> is {homeStation.category ?? 'unclassified'} at{' '}
              {homeStation.issuedAt ? homeStation.issuedAt.slice(11, 16) + 'Z' : 'its last report'}.
            </>
          )}
        </p>
      </div>

      {weather?.mode === 'recorded' && (
        <p className="field-note">
          These reports were recorded on {recordedWhen(weather.at)} and are frozen
          {weather.problem ? `, because live weather could not be had: ${weather.problem}` : ': this page fetches nothing'}. Everything else is live — the
          whole pipeline runs in your browser.
        </p>
      )}
    </section>
  );
}
