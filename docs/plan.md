# Build plan

The spec (`docs/spec.md`) says *what* and *why*; onboarding says *how work is
done*. This file is the *sequence*: the decisions taken up front, the concrete
shape of each step, and what "done" means for each. It is a living document —
update it when a decision changes.

Dates are absolute. Written 2026-09-07.

---

## 0. Decisions taken up front

### 0.1 Form factor: a web app, served by our own Node process

**Decision: responsive web app. No native mobile app.** Revisit only after the
minimum credible version exists.

Why:

- The thesis is the *reasoning layer*. Every hour on a second UI platform is an
  hour not spent on the reasoning layer, and buys nothing the thesis needs.
- The product is explicitly **not** for in-flight or real-time use. Pre-flight
  briefing happens at a desk, a kitchen table, or an FBO — a laptop or a tablet
  browser is the natural surface. A phone-sized layout should *work*, but it is
  not the primary design target.
- A server is required regardless: the FAA NOTAM API key must never ship in a
  client, fetched data must be cached and content-addressed in Postgres, and
  the LLM policy ("never call a model in the request path") implies a
  server-side worker that assesses NOTAMs at fetch time. Once there is a server,
  a browser client is the cheapest client.
- "Add to home screen" via a PWA manifest gets most of the mobile ergonomics
  later for roughly an afternoon of work, if it ever matters.

What this means concretely:

| Layer | Choice |
| --- | --- |
| Core library | TypeScript, zero runtime deps for decoders/rules. Lives in `src/` today, becomes `packages/core` at step 5. |
| API | Fastify, schema-first. Serves the JSON briefing API **and** the built SPA as static files — one process, one port. |
| Web | React + Vite SPA. The briefing view is the product surface. |
| First UI | A **CLI** (`holdshort brief ...`) that prints the briefing JSON and a terminal rendering. Arrives at step 5 *before* the React view and stays forever as the smoke test and the demo for "no model involved". |
| Deploy | `docker compose up` — `db` + `api`. Local-first; a VPS is optional and identical. |

### 0.2 Repository layout

Single npm package **through step 4**. Nothing before the UI needs a second
package, and workspaces now would be ceremony without payoff.

```
src/
  domain/          units, time, shared value types (no I/O)
  decode/          tokenizer + group parsers shared by METAR/TAF
    metar/         METAR state machine, remarks, derived values
    taf/           TAF state machine, period model
    pirep/         (later)
  fetch/           one module per upstream source; caching; rate limiting
  store/           Postgres: raw reports, decoded reports, briefings
  resolve/         route + time: ETA per waypoint, TAF period selection
  rules/           personal minimums, 91.155, crosswind, currency
  brief/           assembly of a Briefing from resolved inputs + rules
  notam/           parse → dedupe → LLM relevance → citation check
  llm/             LLMProvider interface; Fixture, Ollama, hosted
  cli/             the terminal entry point
test/
  fixtures/        real upstream data, pasted or recorded; never fabricated
  <mirrors src/>
```

At step 5 this becomes npm workspaces: `packages/core` (everything above
except `cli`), `apps/api`, `apps/web`. That is a directory move plus import
rewrites; the layering above is chosen so the move is mechanical.

### 0.3 Conventions that every module obeys

- **Explicit `null`, not optional keys**, in domain and decoded types. Output
  JSON must be shape-stable so the briefing diff (step 9) and the
  content-addressed store compare like with like. `exactOptionalPropertyTypes`
  is on precisely to make this painful to violate.
- **Branded unit types** (`StatuteMiles`, `NauticalMiles`, `FeetAgl`,
  `FeetMsl`, `Knots`, `DegreesTrue`, `DegreesMagnetic`, ...). Zero runtime
  cost; a wrong-unit assignment is a type error.
- **Decoders transcribe; they do not interpret.** `decodeMetar` produces a
  literal, span-annotated transcription. Derived values (ceiling, flight
  category, resolved observation instant) live in a separate `derive` module so
  the transcription stays exactly one-to-one with the report.
- **Total functions over untrusted text.** Decoders never throw on input.
  Anything not recognised lands in `unparsed` with its span.
- **Zulu internally.** `Date` objects and ISO strings with `Z` only. No local
  time until the display edge in `apps/web`.
- **Versioned outputs.** Every stored decoded/derived/assessed row carries the
  version of the code that produced it (`decoderVersion`, `rulesVersion`,
  `promptVersion`). Re-running with a newer version writes new rows; nothing is
  updated in place.

### 0.4 Things to kick off now because they have lead time

- [ ] **Register for the FAA NOTAM API** (external.faa.gov/notamapi). Approval
      is not instant; step 2 needs it.
- [ ] **Download one NASR 28-day cycle** (current cycle) into `data/raw/` so
      step 2 can be built against a real file.
- [ ] **Pick the seeded demo flight**: your home field, a destination you
      actually fly to, your aircraft, your real personal minimums. Every step
      from 3 onward is tested end-to-end on that one flight.

---

## 1. Step-by-step

Order is exactly the onboarding table. Each step lists: goal, what gets built,
interfaces it exposes to the next step, tests, and definition of done.

### Step 1 — METAR / TAF decoders (M2) — **done 2026-09-07**

Outcome against the definition of done below: METAR US 0.13 % / worldwide
0.46 % unparsed body tokens; TAF US 0.16 % / worldwide 0.26 %; 379 tests
including corpus-wide invariants over 5,060 METARs and 2,957 TAFs. The
hand-decoded set is smaller than the ≥100/≥40 target (about 20 full reports
each, plus several hundred group- and remark-level cases); grow it whenever a
bug is found rather than as a separate exercise.

**Goal.** Deterministic, total, span-annotated decoders for METAR and TAF, with
a corpus of real reports.

**Build.**

1. `src/decode/span.ts`, `tokenizer.ts` — offsets-preserving whitespace
   tokenizer. Every downstream field references a `Span` into the raw string.
2. `src/decode/groups/*` — one pure parser per group type, shared by METAR and
   TAF: wind, visibility, RVR, present weather, sky, temperature, pressure,
   day/time.
3. `src/decode/metar/` — state machine over the group order in FMH-1 / Annex 3;
   remarks parsers for the AO2 / SLP / T-group / peak wind / precipitation /
   temperature-extreme / pressure-tendency / weather-timing / lightning /
   sensor-status family; `derive.ts` for ceiling and flight category.
4. `src/decode/conditions.ts` — the forecast-conditions parser shared by TAF
   periods and METAR `TEMPO`/`BECMG` trends.
5. `src/decode/taf/` — validity period, `FM`, `BECMG`, `TEMPO`, `INTER`,
   `PROB30/40` (standalone or qualifying `TEMPO`/`INTER`), `AMD`/`COR`/
   `NIL`/`CNL`, `WS` groups, `NSW`, `TX/TN`, military icing/turbulence/`QNH`,
   US and military trailer notices, `RMK`. Output is a list of periods each
   carrying its own kind, probability, validity window, and span, **not** a
   pre-resolved timeline — resolution is step 3's job and it needs the raw
   structure.
6. Fixtures: `test/fixtures/metar/awc-cache-2026-09-07.txt` (4,861 real
   reports from the AWC bulk cache, worldwide), `awc-sample-1.txt` (199 US
   reports), and `test/fixtures/taf/awc-cache-2026-09-07.txt` (2,957 TAFs
   from `tafs.cache.xml.gz`; the CSV variant does not exist for TAFs).

**Tests.**

- Table-driven per group parser.
- Hand-decoded full reports (`test/decode/metar/decode.test.ts`) — the
  highest-value tests in the repo. Grow this every time a bug is found.
- **Invariants over the whole corpus**: never throws; decoding twice gives
  deep-equal output; every span is in bounds and non-empty; every token of the
  raw report is claimed by exactly one field or by `unparsed`; the output is
  JSON round-trippable.
- A coverage report of *which* tokens land in `unparsed` across the corpus, so
  the long tail is worked down from the most frequent unknown first.

**Done when.** Both decoders pass the invariant suite over the whole corpus,
the US subset has under 0.5 % of body tokens unparsed, and a hand-decoded
corpus of ≥100 METARs and ≥40 TAFs passes.

### Step 2 — Fetch layer (M1) — **done 2026-09-07**

Outcome: `holdshort fetch KJFK KTEB KHPN` against the Compose Postgres stores
raw + decoded METAR/TAF rows and logs every fetch; a second run writes no
rows. `holdshort nasr <dir>` loads a full cycle (19,411 sites) in ~2 s and
re-loads as a no-op; `holdshort airport KHPN` returns runways with true
headings. 420 tests; the Postgres contract runs in a dedicated
`holdshort_test` database when Docker is up and skips otherwise.

Two things deliberately left open:

- **FAA NOTAM API.** The client is written to the published v1 request
  shape, but no credentials existed, so its response handling is unverified
  and untested against real data (fixtures are never fabricated). Register,
  record one real response into `test/fixtures/fetch/notam/`, and tighten
  the parsing. Until then `holdshort fetch` skips NOTAMs and says so.
- **Logging** is `console` in the CLI only; pino is deferred until there is a
  server process worth structuring logs for (step 5).

Facts learned about the upstreams, recorded in the source comments too:
AWC `format=json` returns records in arbitrary order and `204 No Content`
for an unknown station; the NASR server answers `HEAD` with 503 but `GET`
works, and a NASR site number is only unique together with its site type
(`23747.31` is both an airport and a heliport).

**Goal.** One interface per upstream source, cached and rate-limited, feeding
verbatim bytes into a content-addressed store.

**Build.**

- `src/store/`: schema + migrations. `raw_reports(sha256 pk, source, station,
  fetched_at, issued_at, bytes)`, `decoded_reports(raw_sha256, kind,
  decoder_version, json)`, plus `stations` from NASR. Append-only.
- `src/fetch/awc.ts` — METAR/TAF/PIREP/AIRMET/SIGMET via
  `aviationweather.gov/api/data/*`. Verify endpoint shapes against the live
  API first; the sample file in fixtures was pulled from exactly this API.
- `src/fetch/notam.ts` — FAA NOTAM API. Key from `.env`. Raw JSON stored
  verbatim.
- `src/fetch/nasr.ts` — parse the NASR `APT` and `RWY` fixed-width files into
  `stations` and `runways` (true and magnetic headings, variation).
- Cross-cutting: real `User-Agent`, per-source rate limiter, on-disk cache
  keyed by URL + time bucket for dev, retries with backoff.

**Tests.** Recorded responses in `test/fixtures/fetch/` replayed through the
same code path; no network in CI. A "fixture drift" test that is skipped
without network and, when run manually, diffs live response shape against the
recorded one.

**Done when.** `holdshort fetch KXYZ` stores raw and decoded METAR/TAF/NOTAM
rows for a station and re-running is a no-op on unchanged content.

### Step 3 — Route and time resolution (M3) — **done 2026-09-07**

Outcome: `holdshort resolve flights/demo-kteb-khpn.json --as-of <ISO>` prints,
per waypoint, the ETA and the governing conditions with the TAF period each
came from quoted verbatim; a field without a TAF (N07) borrows the nearest one
within 60 NM and is labelled as interpolated. 448 tests, including an
enumerated TAF-selection suite (base, FM succession and timing, BECMG
before/during/after, TEMPO/INTER/PROB overlays, half-open windows, element
inheritance, NSW, validity edges, cancelled, unplaceable periods) run on real
corpus TAFs.

Decisions taken:

- **Prevailing vs overlay.** Prevailing = base, replaced wholesale by each
  `FM` at or before *t*, amended element-wise by each `BECMG` whose window
  has *ended*. A `BECMG` still in its window, and every `TEMPO`/`INTER`/
  `PROB` covering *t*, is an overlay merged onto the prevailing state but
  returned separately. The rules engine treats overlays conservatively.
- **Merge rule.** A given element replaces, an absent one inherits, `NSW`
  clears weather, any sky group replaces the whole sky. Every element keeps
  its span into the TAF.
- **Time anchoring.** TAF `ddhh` groups resolve to the instant nearest the
  issue time (`resolveNearestDayTime`), so validities straddling a month end
  work.
- **"Known as of."** Only reports issued at or before `asOf` are used, so a
  briefing can be reproduced for any earlier instant — the basis of the
  diff feature.
- **No winds aloft.** ETAs are distance over planned TAS. This is the
  optional scope the spec allows cutting; add later behind the same
  `resolveRoute` interface.
- **Nearby is nearest-station, not interpolation.** The label says so. True
  interpolation between stations is not worth the false precision.

Demo flights: `flights/demo-cysn-cykf.json` is the owner's real flight
(CYSN → CYKF at 15:00Z, alternate CYHM, C172 at 105 kt TAS / 3,500 ft);
`flights/demo-kteb-khpn.json` (KTEB → N07 → KHPN, alternate KJFK) stays as
the US test fixture because all four fields are in the recorded AWC
responses and N07 has no TAF.

**Jurisdiction (decided 2026-09-07).** The owner flies in Canada, so the
primary case is Canadian and the US is second, even though the spec is
written US-first. Consequences already applied: Canadian airports come from
**OurAirports** (public domain; `src/fetch/ourairports.ts`; true runway
headings, no magnetic variation) with NASR preferred only for US fields —
NASR lists 147 foreign border-area fields with no runway alignments, which
would otherwise shadow the good data. Consequence for step 4: the
regulatory VFR minima table must exist in two versions, CARs 602.114/602.115
(Canada) and FAR 91.155 (US), selected by the airspace's country. Personal
minimums are jurisdiction-free.

**Goal.** For every point on the route, the governing forecast at the time the
aircraft will be there.

**Build.**

- `src/resolve/route.ts` — route as ordered waypoints (ICAO ids resolved via
  NASR, or lat/long), great-circle legs, distances in NM.
- `src/resolve/eta.ts` — ETA per waypoint from departure time + planned TAS.
  Winds-aloft interpolation is optional scope (spec §7); ship without it first.
- `src/resolve/taf.ts` — **the hard part.** Given a decoded TAF and an instant:
  select the base period (`FM` / `BECMG` semantics), collect active overlays
  (`TEMPO`, `PROB`), and return `{ prevailing, overlays[] }` with spans.
  `TEMPO` never replaces prevailing; it is surfaced as an overlay for the rules
  engine to treat conservatively.
- `src/resolve/nearby.ts` — for fields with no TAF, choose nearby reporting
  stations by distance, and label the result as interpolated with a confidence
  marker. Honesty in the output is the requirement here.

**Tests.** TAF period selection has a finite, enumerable set of cases; write
them all. Use the seeded demo flight as the end-to-end fixture.

**Done when.** `holdshort resolve <flight>` prints, per waypoint, the ETA and
the governing conditions with the TAF line each came from.

### Step 4 — Rules engine (M4) — **done 2026-09-07** (airport-only; currency and 91.169 deferred)

Outcome: `holdshort brief flights/demo-cysn-cykf.json --fetch` prints a
go/marginal/no-go per point and overall, with every finding — passes
included — quoting the report text it was judged on. 513 tests, including
one per row of the CARs 602.114/602.115 and FAR 91.155 tables.

Decisions taken:

- **Severity ladder.** A violation in the prevailing forecast or in a METAR
  within 90 minutes of the ETA is `no-go`; the same violation in an overlay
  (`TEMPO`/`INTER`/`PROB`/in-window `BECMG`) or an older METAR is
  `marginal`; `advisory` never moves the verdict; passes are `ok` findings
  with citations. Verdict = worst finding; the alternate is reported but
  does not ground the flight.
- **Crosswind** is true wind on true runway heading (no magnetic variation
  needed). `VRB` counts as the full speed across every runway; calm is zero;
  a missing direction is an advisory, not a zero. The profile decides
  whether gusts count (the owner's does). Best runway = lowest gust
  crosswind, ties broken on headwind. The POH demonstrated figure gets its
  own finding when known.
- **Regulatory minima** need an airspace class the data does not yet
  provide (plan step 8), so the flight plan carries an `airspace` map for
  now; unknown class → an `advisory` that says the check was not evaluated.
  Jurisdiction from the airport's country. Cloud clearance is checked as
  cruise altitude against each BKN/OVC base (base AGL + field elevation).
- **Day/night** from solar elevation (`src/domain/sun.ts`, civil twilight
  −6°), so CARs night rows apply without an input.
- **Deferred:** 91.169 / CARs alternate rules (need approach data), fuel
  reserves, currency, W&B — the last two wait on the POH and pilot record.

**Goal.** Pure functions from resolved conditions + pilot profile → findings
with citations.

**Build.**

- `src/rules/profile.ts` — personal minimums schema (ceiling, visibility,
  crosswind, gust factor, night, type recency), versioned. The owner's
  profile is `profiles/default.json`: 2,500 ft AGL ceiling, 5 SM
  visibility, 15 kt crosswind *including* gust. Aircraft limits live in
  `aircraft/c172.json` (demonstrated crosswind pending the POH).
- `src/rules/vfrMinima.ts` — the VFR minima as a pure function of
  (jurisdiction, airspace class, altitude MSL, altitude AGL, day/night), with
  **both** tables: CARs 602.114/602.115 for Canada and FAR 91.155 for the
  US. One test per row of each. Airport-only at this step:
  departure/destination/alternate airspace class from the airport record.
- `src/rules/crosswind.ts` — per runway, true heading vs true wind, gust
  handling, compared against both POH demonstrated and personal limit.
- `src/rules/alternate.ts` — 91.169 1-2-3 rule.
- `src/rules/currency.ts` — optional scope; flight review, medical, passenger
  and night currency from a pilot record.
- `src/rules/evaluate.ts` — runs every rule over every leg, produces
  `Finding[]` and a per-leg `go | marginal | no-go` verdict. **Every finding
  carries the span and raw report it was derived from.**

**Done when.** The demo flight yields a verdict per leg with each finding
citing its source, and the 91.155 table is exhaustively tested.

### Step 5 — Briefing assembly and UI (M5) — first usable build — **done 2026-09-07**

Outcome: `npm start` serves the API and the built web app on
http://127.0.0.1:3000; entering the owner's flight in the browser yields
the same cited verdict the CLI gives, stored as an immutable
content-addressed briefing. Verified live against Postgres: `POST
/api/briefings` → 201 with the briefing hash, `GET /api/briefings/:sha`,
`GET /api/briefings?flightKey=`, SPA at `/`. 527 tests across workspaces.

What was built:

- `packages/core/src/brief/` — canonical JSON + SHA-256; `assembleBriefing`
  wraps the rules output with the plan, profile, aircraft, `asOf`, code
  versions, and every report hash it was judged on. `flightKey` (route,
  time, cruise) groups briefings of one flight for the diff.
  `BriefingStore` on both stores; migration 0005.
- npm workspaces: `packages/core`, `apps/api`, `apps/web`.
- `apps/api` — Fastify. `POST /api/briefings` (plan, profile?, aircraft?,
  asOf?, fetch?), `GET /api/briefings/:sha256`, `GET /api/briefings?flightKey`,
  `GET /api/airports/:id`, `GET /api/health`; serves `apps/web/dist` with SPA
  fallback. Tested with `fastify.inject` over a memory store and recorded
  responses; no network. No model is ever called in a request.
- `apps/web` — Vite + React. Flight form (defaults to the owner's flight),
  personal-minimums and aircraft form, briefing view: verdict, per-point
  cards, every finding expandable to the raw report with the cited span
  highlighted, Zulu with local beside it, the safety banner sticky at the
  top, and the list of report hashes the briefing was made from. The
  browser bundle keeps its own copy of the API types so it never imports
  the Node side of core.

Not done, deliberately: no Playwright smoke test yet (the view was
exercised through the API, not visually — the owner should open it); no
hosting decision (local-first; `HOST`/`PORT` env for anything else); no
briefing history UI (the data is there; that is step 9's surface).

**Goal.** Weather in, verdict out, no model involved, on a screen.

**Build.**

- `src/brief/` — `Briefing` type: immutable, content-addressed (SHA-256 of the
  canonical JSON), referencing raw report hashes. Stored append-only.
- Convert to workspaces: `packages/core`, `apps/api`, `apps/web`.
- `apps/api` — Fastify: `POST /flights`, `POST /flights/:id/brief`,
  `GET /briefings/:hash`. Serves `apps/web/dist`.
- `apps/web` — React: flight form (route, time, aircraft, minimums profile
  editor), briefing view with per-leg verdicts, each finding expandable to the
  raw report with the cited span highlighted. Safety banner at the top,
  always. Zulu with local time shown beside it, never instead of it.
- `src/cli` — `holdshort brief <flight.json>` prints the same briefing.

**Done when.** You can enter the demo flight in the browser and get a cited
verdict, and the same verdict from the CLI, with no LLM in the process.

### Step 6 — NOTAM relevance + eval harness (M6, M7) — **done 2026-09-12 except the model itself**

The blocker resolved better than expected: **NAV CANADA's CFPS endpoint**
(`plan.navcanada.ca/weather/api/alpha/?site=CYSN&alpha=notam`, the JSON its
own planning site calls) serves Canadian NOTAMs without a key. Unofficial,
so the client fails loudly on any shape change and every response is stored
verbatim. The FAA's own NOTAM search backend is behind Akamai (403) and the
official API still needs the credentials that have not arrived, so US
NOTAMs remain unbuilt — `src/fetch/notam.ts` is still the unverified
client. Nothing was fabricated to fill either gap.

Built:

- `src/notam/decode.ts` — ICAO NOTAM decoder. Fields are found by an
  order-aware scan (`A)` only after `Q)`), so free text containing `A)`
  cannot be mistaken for a field. Every field span-annotated; total.
- `src/notam/qcodes.ts` — 181 subject and 80 condition Q-codes, drafted
  twice independently, reconciled, and adversarially verified by three
  reviewers (0 refutations). Every code in the corpus decodes; unknown
  codes return null rather than a guess. Regenerate with
  `scratchpad/gen-qcodes.cjs` from the `icao-qcode-tables` workflow.
- `src/notam/filter.ts` — time and geography classification before any
  token is spent. Understands `DAILY hhmm-hhmm` and `MON dd dd hhmm-hhmm`
  schedules; an unreadable schedule or a missing position counts as
  active/near, never the reverse.
- `src/notam/dedupe.ts` — folds the FIR-wide NOTAMs that arrive once per
  site; flags what a later `NOTAMR`/`NOTAMC` supersedes, never removing it.
- `src/llm/` — `LLMProvider`, `FixtureProvider` (replay; tests and CI),
  `RecordingProvider`, `OllamaProvider` (schema-constrained, temperature 0),
  `BudgetedProvider` (the in-code spend cap), `llmFromEnv`.
- `src/notam/assess.ts` — the one place a model sees a NOTAM. Cached on
  (NOTAM hash, flight-context hash, prompt version, model). **Citation
  verification**: a `cited_span` that is not verbatim in the NOTAM demotes
  the answer to `unverified` rather than trusting it.
- `src/notam/flight.ts` — the whole pipeline per flight, ranked
  `critical → advisory → unverified → not-assessed → irrelevant →
  out-of-scope`. Everything fetched is in the output; rank sets order and
  collapse state only.
- `src/notam/eval.ts` + `scripts/notam-eval.ts` + `npm run eval:notam` —
  agreement, per-class precision and recall, confusion, disagreements.
- API (`notams` in the briefing document), web (`NotamPanel` with the
  cited span highlighted in the raw NOTAM), CLI (`notams`, `brief --notams`).

**A bug worth remembering.** `notamsForFlight` filtered by "known by the
briefing instant", but the fetch it performs lands *after* that instant, so
a live briefing discarded the NOTAMs it had just retrieved. The API test
only passed because an earlier run had already stored them. Fixed by
treating the fetch as part of what this briefing knows; reproducing an
older briefing without fetching still sees only what was stored by then,
and a test pins both halves.

**Not done: the model.** Ollama is not installed on this machine (the RTX
3060 is there; nothing listening on 11434). So the eval gate is *skipped*
with an explicit message rather than passed, and the pipeline reports
`not-assessed` for in-scope NOTAMs. To finish: install Ollama, `ollama pull
qwen2.5:7b`, then `HOLDSHORT_LLM=ollama npm run eval:notam -- --record`,
which records fixtures and prints agreement against the labelled set. The
test suite then replays those fixtures and the gate becomes live.

**The labelled set is provisional.** `test/fixtures/notam/labelled/` holds
31 labels from a three-perspective panel (instructor, safety-minded private
pilot, flight service specialist) with majority vote — 28 unanimous, 3 at
2/3. They are marked provisional and **need the owner's review**: they are
the yardstick the model is measured against, so a wrong label is worse than
a wrong answer.

- `src/llm/` — `LLMProvider` interface; **`FixtureProvider` first**, then
  `OllamaProvider` (Qwen 2.5 7B), then a hosted provider. Cache on
  `(content_hash, flight_context_hash, prompt_version, model_id)`.
- `src/notam/` — deterministic parse (location, effective window, category),
  time-window filter, fingerprint dedupe, then the LLM assessment with the
  `NotamAssessment` schema from the spec, then **citation verification**:
  `cited_span` must be a verbatim substring or the assessment is demoted.
- **Nothing is dropped.** Relevance orders and collapses; the UI shows all.
- Eval: a hand-labelled set in `test/fixtures/notam/labelled/`, a scorer, and
  a CI gate that fails on regression past a threshold.

### Step 7 — Aircraft document ingestion (M6b) — **next**

OCR word boxes → LLM extraction with token-id citations → alignment check →
review queue for low-confidence fields. Weight-and-balance from the POH is the
demo. Start with printed sources; measure and report the handwritten split.

### Step 8 — Airspace transit (M4b)

PostGIS polygons with floor/ceiling; route sampled every 0.5 NM;
point-in-polygon by altitude band; terrain AGL from USGS; civil twilight for
day/night; SUA × NOTAM activation join. Upgrades the 91.155 function from
airport-only to per-segment.

### Step 9 — Briefing diff (M8)

Falls out of content-addressed, immutable briefings. Diff at the **verdict and
finding level**, not raw text: new NOTAMs, verdict transitions, any value that
crossed a personal minimum.

### Step 10 — Forecast verification (M9)

For each briefing, record the TAF prediction at ETA; later pair it with the
actual METAR; accumulate per-station bias on ceiling and visibility.

### Step 11 — Polish (M10)

README, architecture diagram, seeded demo flight, demo recording.

---

## 2. Cross-cutting infrastructure, added when first needed

| When | What |
| --- | --- |
| Step 1 | GitHub Actions: `npm ci && npm run typecheck && npm test` on push. |
| Step 2 | `.env.example`; Postgres migrations (plain SQL files, applied in order by a tiny runner — no ORM). |
| Step 2 | Structured logging (pino) with request ids. |
| Step 5 | Workspaces; Vite; Playwright smoke test of the briefing page. |
| Step 6 | Token budget counter with a daily ceiling; eval gate in CI. |

---

## 3. Risks and how each is handled

| Risk | Handling |
| --- | --- |
| AWC API shape changes | Fixtures are recorded from the live API with the fetch date in the filename; a manual drift check compares live vs recorded. |
| FAA NOTAM API approval delay | Register now (§0.4). Until approved, step 6 develops against pasted NOTAM text in fixtures. |
| TAF period semantics wrong | Step 3's selection cases are enumerated and tested exhaustively; `TEMPO` handled conservatively by design rule. |
| Decoder long tail | Corpus-wide invariant tests plus the unparsed-frequency report make the tail visible and finite. |
| Scope creep into maps/charts | Out of scope by spec §12; the plan does not budget for them. |
| Safety framing eroded by UI polish | Banner and citation-beside-verdict are acceptance criteria for step 5, not styling choices. |

---

## 4. Open questions for the project owner

None block current work. Answer when convenient.

1. ~~Demo flight and personal minimums~~ — answered 2026-09-07: CYSN → CYKF
   15:00Z, alternate CYHM, C172; 2,500 ft AGL / 5 SM / 15 kt crosswind
   including gust. **Still needed: the C172 POH** (demonstrated crosswind,
   limitations, W&B) for the aircraft-limits rules and step 7.
2. Hosting: local-only for now, or is a small VPS deploy wanted by step 5?
3. Winds-aloft interpolation in step 3: in scope, or defer per the spec's
   "if you need it smaller" note?
