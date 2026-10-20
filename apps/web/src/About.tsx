/**
 * What a first-time reader arrives at. Shown only on the public build,
 * where there is no server behind the page — so it has to say what it is,
 * where its weather comes from, and what it is not.
 */
import type { Aerodrome, WeatherSource } from './engine.js';
import { recordedWhen, weatherAge } from './WeatherNote.js';

export function About({ weather, aerodromes }: { weather: WeatherSource | null; aerodromes: readonly Aerodrome[] }) {
  const live = weather?.mode === 'live';
  return (
    <section className="about" id="about">
      <h2>What this is</h2>
      <p className="lede">
        Departure Brief puts in front of a pilot everything they would look at before a flight, in one place, with the report behind every line. It decodes the raw
        products, resolves them to each point along the route at the time the aircraft will actually be there, and compares them against that pilot's own
        personal minimums. <b>It does not decide whether to fly.</b> That is the pilot's, and this exists to make sure nothing they needed was missed.
      </p>

      <p>
        Existing tools are excellent at fetching and displaying, and leave the reader to hold a dozen products in their head at once. The gap is not more data:
        it is the work of relating it — this forecast, at the time you will be there, against the limits you set, with the line it came from still attached.
      </p>

      <div className="about-grid">
        <div>
          <h3>What is on this page</h3>
          {live ? (
            <p>
              A real flight — St. Catharines to Waterloo in a Cessna 172, alternate Hamilton — over the weather being reported right now: every METAR and TAF
              in the country, taken from the weather services at {weatherAge(weather!.at)}, and the NOTAMs for whichever aerodromes you brief. Every report
              came off NAV CANADA or the US weather service and is held here verbatim.
            </p>
          ) : (
            <p>
              A real flight — St. Catharines to Waterloo in a Cessna 172, alternate Hamilton — over the reports those aerodromes were actually publishing
              {weather ? ` on ${recordedWhen(weather.at)}` : ''}. Every METAR, TAF and NOTAM below came off NAV CANADA and the US weather service and is
              stored here verbatim.
            </p>
          )}
          <p>
            <b>The briefing is built in your browser.</b> The page holds the reports, not a result: decoding, resolution and the rules all run here, so
            changing a personal minimum or the departure time rebuilds the verdict in front of you from the same code the server runs. It produces the same
            briefing, down to the content hash — there is a test that fails if it ever does not.
          </p>
          {live ? (
            <p className="hint">
              Neither weather service allows a page to call it directly, so a small relay does the asking: every few minutes it takes the whole country's
              reports and keeps the latest copy, and this page reads that copy. However many people open it, the services are asked once per product per
              window. The relay does not read the reports — the page does, with the same code the server uses. {aerodromes.length.toLocaleString('en')}{' '}
              aerodromes are carried; NOTAMs are ranked by deterministic rules only, since no model runs in a browser.
            </p>
          ) : (
            <p className="hint">
              Neither weather service allows a page to call it directly, so these reports are frozen at the moment they were recorded
              {weather?.problem ? ` — this page tried for live weather and could not have it (${weather.problem})` : ''}. The flight departs at a time the
              recorded forecasts cover; everything else is exactly as it was.
            </p>
          )}
        </div>

        <div>
          <h3>Five rules the code actually obeys</h3>
          <ol className="rules">
            <li>
              <b>No model anywhere near the decoders.</b> A METAR has exactly one correct parse. Non-determinism there is a defect, not a trade-off.
            </li>
            <li>
              <b>Nothing is ever hidden.</b> Ranking changes order and what is collapsed, never what exists. A model error must degrade to noise, never to a
              missing item.
            </li>
            <li>
              <b>Every line cites its source.</b> Not the report — the span within it. A statement without the text it came from is worse than silence.
            </li>
            <li>
              <b>Zulu internally, always.</b> Local time exists only at the display edge.
            </li>
            <li>
              <b>Raw reports are stored verbatim</b>, content-addressed and append-only, so what was known at any moment can be reconstructed exactly.
            </li>
          </ol>
        </div>
      </div>

      <h3>Where a model is used, and how far it is trusted</h3>
      <p>
        Two places, both optional and both running locally on a laptop GPU: ranking NOTAMs by relevance to this flight, and reading weight-and-balance figures
        out of a scanned handbook. Everything else — decoders, rules engine, the arithmetic — is deterministic.
      </p>
      <p>
        Neither is trusted on its word. A NOTAM assessment must quote the NOTAM verbatim or it is demoted to <i>unverified</i> and ranked below assessments that
        did. A figure read out of the handbook is used only if the quoted line is on that page, the number is in that line, and the line names the field — and
        the handbook prints its normal and utility weight limits in the same layout, so that last check caught the model reading one as the other.
      </p>
      <p>
        The decisions a small model should not be making were taken away from it. A closed runway at the departure aerodrome is settled from the ICAO Q code,
        not asked about. That change took relevance agreement from 61.5% to 85.7% — but more to the point, it is why a runway closure can no longer be missed
        at all.
      </p>

      <h3>Measured, not asserted</h3>
      <div className="numbers">
        <div>
          <span className="n">&lt;0.3%</span>
          <span className="l">of tokens unparsed across 8,000 real METARs and TAFs</span>
        </div>
        <div>
          <span className="n">85.7%</span>
          <span className="l">NOTAM relevance agreement with a reviewed labelled set, on a local 7B model</span>
        </div>
        <div>
          <span className="n">100%</span>
          <span className="l">recall on critical NOTAMs — none that mattered was missed</span>
        </div>
        <div>
          <span className="n">6 of 6</span>
          <span className="l">handbook figures that passed verification were correct; 22 more went to a review queue</span>
        </div>
        <div>
          <span className="n">653</span>
          <span className="l">tests, run on every push against a real PostGIS database</span>
        </div>
      </div>
      <p className="hint">
        Each of those is produced by a test in the repository, not an estimate. The two numbers a reader should be most suspicious of — the model ones — are the
        ones with a gate: extraction precision is a hard failure if it slips, and recall is deliberately not gated, because a figure the model misses waits in a
        review queue and a figure it invents does not.
      </p>

      <p className="repo">
        Source: <a href="https://github.com/nberkyilmaz/departure-brief">github.com/nberkyilmaz/departure-brief</a>
      </p>
    </section>
  );
}
