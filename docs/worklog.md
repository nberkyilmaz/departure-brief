# Work log

A chronological record of what was done, in the order it was done, including
the wrong turns. One entry per action; a heading per working session.
Numbers are what was measured at the time. **Append to this file at the end
of every session** — it is the answer to "why is it like this?" six months
from now.

Related: `docs/plan.md` is the sequence *ahead*; this file is the sequence
*behind*. `docs/onboarding.md` §3 is the current state.

---

## Where we are (updated 2026-09-13, paused mid-website)

**Current step: the public website**, so this project can go on a resume.
Started, not finished — see "In progress" below for exactly where it stopped.

**Done:** steps 1-7, 9 and 10. Decoders, fetch layer, route and time
resolution, rules engine, briefings + API + web app, NOTAM relevance with a
local model and a passing eval gate, the briefing diff, aircraft document
ingestion, and forecast verification. 653 tests, typecheck clean, web builds.

**Step 8 (airspace transit) remains blocked on data, not effort.** Rechecked
2026-09-13: NAV CANADA publishes no airspace geometry, open.canada.ca has
nothing usable, OpenAIP needs a key. The FAA ArcGIS `Class_Airspace` layer
*is* queryable, so the US half could be built whenever it is wanted.

### In progress: the public website

**The decision taken.** The site will be **static, built from committed
fixture data** — not a live deployment of the API. Three reasons, and they
are worth keeping: NAV CANADA's CFPS endpoint is unofficial and a public
site hitting it for strangers would be discourteous and likely blocked; the
weather service asks for identified, reasonable use; and a public
"should I go?" tool invites exactly the operational use this project
disclaims on every screen. A static site also costs nothing and always
works, which is what a resume link needs.

**Hosting and domain, decided but not yet done.** Cloudflare Pages, free,
which gives `holdshort.pages.dev` at no cost. If a real domain is wanted,
Cloudflare Registrar sells at wholesale with no markup and no renewal
spike — roughly $10/year for `.dev` or `.com`. The free subdomain is
perfectly respectable on a resume. **Nothing has been registered or
deployed yet**, and neither can be done without the owner's accounts.

**Built so far (uncommitted at the pause):**

- `packages/core/scripts/build-demo.ts` — builds the demo payload from
  committed fixtures alone: no network, no database, no model at run time.
  With `HOLDSHORT_LLM=ollama` it records any model answer it lacks into the
  fixture directory, so the next build needs nothing again.
- `packages/core/test/fixtures/fetch/awc/demo-cysn-cykf-cyhm.json` — 78 real
  METARs and 3 TAFs for CYSN, CYKF and CYHM, recorded 12-13 September 2026,
  verbatim as the weather service returned them. The observations run past
  the briefing moment on purpose, so the same fixture can demonstrate
  forecast verification.
- `apps/web/public/demo/briefing.json` (136 KB) and `wb.json` (24 KB) — a
  real briefing of the owner's flight: verdict marginal, 34 reports cited,
  31 NOTAMs ranked by qwen2.5:7b (8 critical, 9 advisory, 9 irrelevant, 5
  out of scope), and the weight-and-balance data with 18 figures.
- 8 further recorded model answers, because the demo moves the departure to
  a time the recorded TAFs cover and the assessment cache is keyed on the
  flight context.

**One deliberate change in the demo data, which the site must state
plainly:** the flight departs 2026-09-12T22:00Z rather than the owner's
2026-09-14T15:00Z. Those TAFs were issued at 1940Z on the 12th and run only
to 0100Z on the 13th, so the real departure time sits outside them and the
demo would show nothing but "no forecast covers this". Route, aircraft,
personal minimums and every report are otherwise exactly as they are.

**Not started:**

1. Demo mode in the web app — `App.tsx` still only knows how to POST to the
   API. It needs to load `/demo/briefing.json` instead when there is no API,
   with a banner saying the data is recorded and frozen.
2. The landing content a reader arrives at: what the tool is, the
   reasoning-layer thesis, the measured numbers (NOTAM relevance 85.7 %
   agreement with 100 % critical recall; POH extraction 6 of 6 verified
   figures correct; decoder coverage under 0.3 % unparsed over 8,000
   reports), and a link to the source.
3. The Cloudflare Pages build configuration and the first deploy.

**Waiting on the owner, unchanged:**

1. **Your aircraft's empty weight and moment**, from its own
   weight-and-balance record. Until then the CLI and web panel use the
   handbook's *sample airplane* figures and say so in both places.
2. **Check the figures entered by hand** in `aircraft/c172.wb.json`. Six
   were verified against the ink; the rest were completed with
   `wb confirm`, and the note on each says how far the handbook backs it.
   The station arms (37, 73, 95, 123 in) and the fuel arm (48 in) carry
   **no citation** — this handbook prints them in a diagram that OCRs to
   noise. They match the standard 172M figures, but confirm them against
   your own copy before flying on them.
3. **The four open questions in the NOTAM labelled set**
   (`packages/core/test/fixtures/notam/labelled/…json`, `openQuestions`),
   chiefly whether CYSN's 06/24 is a practical alternative for a C172 once
   11/29 is closed — it decides whether two NOTAMs are critical or advisory.
4. **FAA NOTAM API credentials**, if US NOTAMs matter. Canadian ones need
   no key.
5. **A look at the web app.** Nobody has eyeballed it yet.

**Next steps, in order:**

1. Finish the website: demo mode, landing content, deploy.
2. Step 8, airspace transit — US half from FAA ArcGIS if the Canadian
   geometry stays unavailable.
3. Step 11, polish and demo.

**Environment notes that will bite whoever picks this up:**

- Ollama's CUDA runner crashes on this laptop (its bundled CUDA build is
  newer than the 546.92 driver). Start the server on Vulkan:
  `OLLAMA_VULKAN=1 CUDA_VISIBLE_DEVICES=-1 ollama serve`.
- The work depends on 146 MB that is deliberately **not** in git: the POH
  (7.9 MB) and the OCR cache (138 MB), plus a local Postgres and Ollama.
  **There is no git remote.** Nothing can continue on another machine, or
  unattended, until a remote exists and those assets are dealt with.

---

## Session 1 — 2026-09-07 — Plan, METAR decoder (step 1, part 1)

### Starting state

1. Read `docs/onboarding.md`, `docs/spec.md`, `README.md`. Repo was a bare
   scaffold: `package.json` (TypeScript, Vitest, no runtime deps),
   `tsconfig.json` (strict + `noUncheckedIndexedAccess` +
   `exactOptionalPropertyTypes`), `docker-compose.yml` (PostGIS on 5433),
   empty `src/decode/{metar,taf}`, `src/domain`, `src/fetch`,
   `test/fixtures`. `npm install` had not been run. One commit:
   "Scaffold the project".

### Environment and corpus

2. Ran `npm install`. Node v22.23.2, npm 10.9.8, Docker 27.0.3 confirmed.
3. Pulled 199 real US METARs from `aviationweather.gov/api/data/metar?ids=…&format=raw`
   into `test/fixtures/metar/awc-sample-1.txt`.
4. Downloaded AWC's worldwide bulk cache `data/cache/metars.cache.csv.gz`
   (4,861 reports). **Mishap:** a `cd` from an earlier command had persisted
   in the shell, a follow-up script ran in the wrong directory, and I deleted
   the CSV before extracting it. Re-downloaded and extracted the `raw_text`
   column with a Node one-liner into
   `test/fixtures/metar/awc-cache-2026-09-07.txt`. Lesson: absolute paths in
   shell commands from then on.

### Plan

5. Wrote `docs/plan.md`: decided **web app, not mobile** (responsive React
   SPA served by the Fastify API; reasoning-layer thesis, not-for-in-flight
   use, server required anyway for keys/cache/LLM policy); single npm package
   through step 4 then workspaces; conventions (explicit `null` not optional
   keys, branded unit types, decoders transcribe not interpret, total
   functions, Zulu internally, versioned outputs); a per-step plan with
   definition of done; risks; open questions for the owner (demo flight,
   hosting, winds-aloft scope); lead-time items (FAA NOTAM API registration,
   NASR download, demo flight choice).

### Foundation

6. `src/domain/units.ts` — branded numeric types (`StatuteMiles`,
   `NauticalMiles`, `FeetAgl`, `FeetMsl`, `Knots`, `DegreesTrue`,
   `DegreesMagnetic`, …) with constructors and conversions.
7. `src/domain/time.ts` — `DayTime`, `resolveDayTime` (report `ddhhmm` →
   full UTC instant against a reference, most-recent-month rule with a
   120-minute tolerance), `toZulu`.
8. `src/decode/span.ts` (`Span`, `Sourced<T>`, `joinSpans`, `isValidSpan`)
   and `src/decode/tokenizer.ts` (offset-preserving whitespace split; no
   case folding, no normalisation).

### Group parsers (shared by METAR and TAF)

9. `src/decode/groups/`: `match.ts` (the `GroupMatch` contract), `wind.ts`
   (`dddffGffKT|MPS|KMH`, `VRB`, `///`, following `dddVddd`),
   `visibility.ts` (statute incl. two-token `1 1/2SM`, `M`/`P` qualifiers,
   the space-dropped `21/2SM` feed glitch read as the only valid
   interpretation, metric with direction and minimum, `CAVOK`, `////`),
   `rvr.ts`, `weather.ts` (intensity/`VC`/descriptor/phenomena grammar,
   `decodeWeatherCode` reused by remarks), `sky.ts`, `temperature.ts`
   (`M00` → 0), `pressure.ts` (`A`, `Q`, `QNH…INS`), `time.ts`.

### METAR decoder

10. `src/decode/metar/types.ts` — `DecodedMetar`, every field `Sourced`.
11. `src/decode/metar/remarks.ts` — remark parsers: AO1/AO2, SLP, T-group,
    peak wind, wind shift, tower/surface visibility, variable visibility,
    variable ceiling, precipitation (P/6/7 groups), 6- and 24-hour
    temperature extremes, pressure tendency, PRESRR/PRESFR, weather timing
    chains (`RAB05E30SNB30`), lightning, sensor status, `$`, FIRST/LAST,
    snow depth, SNINCR, sunshine, water equivalent, DENSITY ALT, cloud
    types, VIRGA.
12. `src/decode/metar/decode.ts` — forward-only state machine over the FMH-1
    group order; weather and sky share a repeatable state; anything
    unrecognised lands in `unparsed` with a span and section.
13. `src/decode/metar/derive.ts` — `ceiling`, `visibilityStatuteMiles`,
    `flightCategory`, `windKnots`, `observationTime`; kept apart from the
    decoder so the transcription stays literal.
14. Installed `tsx` (dev) to run scripts; wrote
    `scripts/metar-corpus-report.ts` (unparsed tokens by frequency, digits
    collapsed to `#`, `--us`, `--section`).

### Tests, first run

15. `test/helpers/span.ts` (`at(raw, substring, nth)` — token-bounded span
    lookup so expectations read as text), `test/decode/tokenizer.test.ts`,
    `groups.test.ts` (table-driven per group), `metar/remarks.test.ts`,
    `metar/decode.test.ts` (hand-decoded full reports from the corpus,
    whole-object `toEqual`), `metar/derive.test.ts`, `domain/time.test.ts`,
    `metar/corpus.test.ts` (invariants over the whole corpus: never throws,
    deterministic, JSON round-trip, every span valid and on token
    boundaries, **every token claimed by exactly one field or `unparsed`**,
    US unparsed-body rate < 0.5 %).
16. First corpus report: US 0.13 % of body tokens unparsed, worldwide 1.46 %.
    Top of the tail: ICAO trend groups (`TEMPO`/`BECMG` + contents), runway
    state groups, second altimeter (`Q1010 A2983`), `X MISG`, variable sky
    (`BKN009 V SCT`), phenomenon location (`CB DSNT SW MOV NE`), obscuration
    (`FG FEW000`), `THRU` in lightning, `M` prefix in `VIS M1/4V2`,
    `T0240////`.

### Long-tail pass and fixes

17. Added: trend *sections* (indicator tokens recognised, contents marked
    `section: 'trend'` pending the TAF change-group parser), `runwayState.ts`
    (ICAO `R24/000062`, `CLRD`, `SNOCLO`), `altimeterAlternate`, remarks
    `elementMissing`, `variableSky`, `phenomenonLocation` (replaced the
    separate `virga`), `obscuration`, `altimeter`, `altimeterEstimated`,
    `secondSiteCeiling`, `THRU`/`MOV` in the shared location reader, `M`
    qualifier on variable visibility, `////` dew point in T groups; sky
    `///TCU`, `//////CB`, `//////` (missing) forms.
18. Test failures and their fixes: `-0` from `T1000…`/`58000` broke JSON
    round-trip → `negate()` helper; `METAR MHPR COR 071100Z` (modifier
    before time) → modifiers accepted anywhere before the wind group instead
    of being a fixed state; RMK-only span expectation off by one (test was
    wrong); `4000 BR` is IFR not MVFR (test was wrong; 4000 m ≈ 2.5 SM);
    bare `SH` must be rejected (only `VCSH` is valid; code was too lenient);
    `///015` misclassified as missing sky.
19. Deliberately left unparsed: `//` (weather placeholder), `/////`
    (positionally ambiguous: missing wind in one report, missing temperature
    in another), ASOS `M` markers, NATO colour states (`BLU`), sea-state
    groups (`W///S4`), QFE remarks.
20. Result: 352 tests green; METAR US 0.13 %, worldwide 0.49 % unparsed
    body tokens. Updated README status table, onboarding §3/§4/§5, added
    `npm run corpus:metar`. Nothing committed (not asked).

---

## Session 2 — 2026-09-07 — TAF decoder (step 1, part 2)

### Corpus

21. `data/cache/tafs.cache.csv.gz` does not exist (404); the XML variant
    `tafs.cache.xml.gz` does. Extracted `raw_text` (stripping CDATA on the
    second attempt) → `test/fixtures/taf/awc-cache-2026-09-07.txt`, 2,957
    TAFs, 757 US.
22. Surveyed forms with grep: all validity groups are `ddhh/ddhh`; `FM` is
    six-digit (one malformed five-digit); `PROB30/40` stands alone (US) or
    qualifies `TEMPO` (ICAO) / `INTER` (Australia); `TX/TN` including `TNM`;
    `WS020/24045KT`; `QNH2992INS`; military `6IhhhT`/`5BhhhT`; US `AMD NOT
    SKED` / `AMD LTD TO …`; Canadian `RMK NXT FCST BY …`.

### Shared conditions parser and TAF decoder

23. `src/decode/unparsed.ts` (shared `UnparsedToken`/`Section`);
    `decodeWindCode` split out of `parseWind`; `parseValidity` now returns
    `DayTime` (minute 0) so FM and window times compare directly.
24. `src/decode/conditions.ts` — one forward-only parser for forecast
    conditions (wind, visibility, weather/`NSW`, sky, low-level wind shear,
    icing, turbulence, `QNH`; `TX`/`TN` returned separately) used by TAF
    periods **and** METAR trends. A multi-token group may not run past the
    range end.
25. `src/decode/taf/types.ts`, `decode.ts` — header (`TAF`, `AMD`/`COR`,
    station, issue time, validity, `NIL`/`CNL`), periods with `kind`
    (`base`/`FM`/`BECMG`/`TEMPO`/`INTER`/`PROB`), `probability`, `indicator`
    span, own `validity` (`FM` has `to: null`), conditions, span. Not a
    resolved timeline by design. `TX/TN` hoisted to TAF level.
26. METAR trends upgraded from marked sections to decoded `MetarTrend`
    (`FM`/`TL`/`AT` bounds + conditions); `METAR_DECODER_VERSION` → 2.
    Trend-section unparsed tokens fell from 172 to 16.
27. `scripts/metar-corpus-report.ts` generalised to
    `scripts/corpus-report.ts --kind metar|taf`; `npm run corpus:taf`.

### Fixes found by the corpus

28. Rewrote a sloppy first draft of `taf/decode.ts` (a bogus `next.index`
    check and a module-level `currentRaw` hack) to thread `raw` through
    properly.
29. Seven Paraguayan TAFs carry an issue time with no `Z` (`070924`). Accepted
    only when a `ddhh/ddhh` validity group follows, which rules out the
    old-style six-digit validity — no guessing.
30. Military trailers (`LAST NO AMDS AFT 0702 NEXT 070800`, `AUTOMATED SENSOR
    METWATCH 0708 TIL 0718`, `COR 0712`, `FN00298`) with `TX/TN` interleaved
    → `notices: Sourced<TafNotice>[]` (`amendment`/`correction`/`metwatch`/
    `forecaster`), temperatures inside the trailer still hoisted.
31. Space-split `FM 071600` accepted as one two-token indicator.
32. Test helper typing loosened (`Partial<Conditions>` demanded branded
    numbers in plain-object expectations).
33. Result: 379 tests; TAF US 0.16 % / worldwide 0.26 % unparsed body
    tokens (residue is upstream typos: `BKT100`, `COVOK`, `TEMP0`,
    `FM80500`). Docs updated: README M2 done, onboarding §3/§4/§5 (next task
    → fetch layer), plan step 1 done with the outcome.

---

## Session 3 — 2026-09-07 — Fetch layer and store (step 2)

### Probes

34. `docker compose up` failed: Docker Desktop was not running.
35. AWC `format=json` shapes verified live: METAR records carry `rawOb`,
    `obsTime` (epoch s), `receiptTime`, `reportTime`; TAF records `rawTAF`,
    `issueTime`, `validTimeFrom/To`; unknown station → `204 No Content`.
36. FAA NASR subscription page returned 403 to scripted access; every
    `nfdc.faa.gov` download URL returned 503 on `HEAD`.
37. Recorded seven AWC responses into `test/fixtures/fetch/awc/` (three
    stations, six-hour history, the real 204, single-station TAF, raw forms).
    Installed `pg` and `@types/pg` — the first runtime dependency.

### Store

38. `src/store/types.ts` — `RawReport` (content-addressed by SHA-256 of the
    body), `FetchEvent` (every fetch logged, even for known content),
    `DecodedRow` keyed by `(sha256, decoderVersion)`, `ReportStore`.
39. `src/store/memory.ts` and `src/store/postgres.ts` (pool, plain-SQL
    migration runner with `schema_migrations`, transactions around
    raw+fetch insert). `migrations/0001_reports.sql`: `raw_reports`,
    `report_fetches`, `decoded_reports`; inserts only, `on conflict do
    nothing`.
40. `test/store/contract.ts` — one contract suite run against `MemoryStore`
    always and `PostgresStore` when reachable (skips otherwise so `npm test`
    passes without Docker).

### Fetch

41. `src/fetch/http.ts` — `HttpClient` interface; `createHttpClient`
    (User-Agent, serialised requests with a minimum interval, retries with
    exponential backoff on 429/5xx/network errors, optional disk cache of
    2xx). Tested with a fake `fetch`, virtual clock and recorded sleeps.
42. `src/fetch/awc.ts` — `AwcClient.metars/tafs` → `RawReport[]` with the
    request URL for the fetch log; errors on non-JSON / non-array / missing
    fields rather than returning empty data.
43. `src/fetch/notam.ts` — FAA NOTAM API v1 client written to the published
    request shape (`icaoLocation`, `responseFormat=geoJson`, paging,
    `client_id`/`client_secret` headers). **Unverified**: no credentials, so
    no recorded fixture; only URL/header construction and paging are tested.
44. `src/fetch/ingest.ts` — `storeAndDecode` (decode once per decoder
    version, ever) and `ingestStation`.
45. `src/cli/main.ts` — `fetch`, `decode`; `--memory`; reads `.env` via
    `process.loadEnvFile`. `.env.example` added. `npm run holdshort`.
46. Test run: two failures because AWC returns stations in a different order
    than requested — expectations made order-independent. CLI smoke test
    against the live API in `--memory` mode: KJFK/KTEB fetched and decoded,
    KZZZ empty.

### NASR

47. Retried NASR: `GET` on
    `nfdc.faa.gov/webContent/28DaySub/extra/03_Sep_2026_APT_CSV.zip` works
    (8 MB) although `HEAD` still says 503. Saved under `data/raw/nasr/`
    (gitignored). GNU `tar` in Git Bash cannot read zips; Windows'
    `C:\Windows\System32\tar.exe` (bsdtar) can.
48. Inspected `APT_BASE.csv` (90 columns: identity, `LAT_DECIMAL`/
    `LONG_DECIMAL`, `ELEV`, `MAG_VARN`+`MAG_HEMIS`, `ICAO_ID`), `APT_RWY.csv`
    (dimensions, surface, lighting), `APT_RWY_END.csv` (`TRUE_ALIGNMENT`,
    displaced threshold, TORA/TODA/ASDA/LDA, ILS, pattern side).
49. `src/fetch/csv.ts` (RFC 4180 reader), `src/domain/airport.ts`
    (`Airport`/`Runway`/`RunwayEnd`, `toMagnetic`/`toTrue`),
    `src/fetch/nasr.ts` (`readNasrDirectory`), `migrations/0002_airports.sql`,
    `AirportStore` on both stores, CLI `nasr <dir>` and `airport <id>`.
50. Fixture: a verbatim four-airport slice (KJFK, KTEB, KHPN, N07 — the last
    has no ICAO id) of the real cycle in `test/fixtures/fetch/nasr/2026-09-03/`.
    `test/fetch/nasr.test.ts` checks KJFK 04L: 031°T, 13W → 044°M.
51. Full cycle loaded into the memory store: 19,411 sites in ~2 s, but "19,410
    new" — site `23747.31` is both an airport (`A`) and a heliport (`H`).
    NASR's key is `(SITE_NO, SITE_TYPE_CODE)`; added `siteType` and made it
    part of the join and the primary key (migration edited in place — no
    database had applied it yet).

### Postgres verification

52. Launched Docker Desktop (engine up in ~10 s), `docker compose up -d`,
    container healthy on 5433.
53. **Mishap:** the shell's working directory was still the NASR data folder
    from step 48's `cd`; vitest found no tests and the CLI could not find
    itself. Re-ran from the repo root.
54. End to end against Postgres: `fetch KJFK KTEB KHPN` → 6 raw, 6 decoded,
    6 fetch events; `nasr` → 19,407 new (see next item); `nasr` again → 0;
    `airport khpn` → 16/34 at 150°T/330°T, variation −13; `fetch` again →
    0 new rows, 12 fetch events; 2 migrations applied. 420 tests, the
    Postgres contract included.
55. **Found and fixed a self-inflicted problem:** the Postgres contract test
    ran against the development database and left its synthetic rows (a
    fake "NEWER" 2026-10-01 KJFK, four "(OLD)" 2026-08-06 airports), which
    then won `getAirport('KJFK')` — that is why the first NASR load said
    19,407 not 19,411. Fix: the test now creates and uses a dedicated
    `holdshort_test` database and truncates after itself; deleted the five
    synthetic rows from the dev database and confirmed 19,411 real rows and
    the real KJFK remain. Verified afterwards: dev DB untouched by a test
    run, test DB empty after it.

### Docs

56. Updated `docs/plan.md` (step 2 done with outcome, open items: NOTAM
    verification, pino deferred; upstream facts learned), `docs/onboarding.md`
    (§3 current state, §4 table, §5 next task → route and time resolution
    with the commands to seed the store), README (status, dev commands).
57. Wrote this log.

### State at end of session 3 (superseded — see session 4)

- 420 tests, typecheck clean. Nothing committed yet — three sessions of work
  are uncommitted in the working tree.
- Docker Desktop and the Compose Postgres are running; the dev database holds
  the 2026-09-03 NASR cycle and six real reports.
- Open: FAA NOTAM API credentials (registration has lead time); demo flight
  choice for step 3's end-to-end fixture.

---

## Session 4 — 2026-09-07 — Route and time resolution (step 3)

### Design decisions, taken before writing code

58. TAF resolution semantics: prevailing = base, replaced wholesale by each
    `FM` at or before *t*, amended element-wise by each `BECMG` whose window
    has ended; an in-window `BECMG` and every `TEMPO`/`INTER`/`PROB` covering
    *t* are overlays merged onto the prevailing state but returned
    separately (the conservative reading the spec asks for). Merge rule: a
    given element replaces, an absent one inherits, `NSW` clears weather,
    any sky group replaces the whole sky; spans preserved.
59. TAF `ddhh` groups resolve to the instant *nearest* the issue time, not
    the most recent past (forecast times lie either side of issue).
60. Fields without a TAF borrow the nearest TAF within 60 NM, labelled
    `nearby` with the distance — nearest-station, not interpolation.
61. No winds aloft: ETA = distance / planned TAS (the spec's optional cut).
62. Placeholder demo flight KTEB → N07 → KHPN, alternate KJFK, chosen because
    all four are in the recorded fixtures and N07 has no TAF.

### Code

63. `src/domain/time.ts` `resolveNearestDayTime` (hour 24 = end of day);
    `src/domain/geo.ts` (haversine NM, initial course, `lat,lon` parsing);
    `src/domain/flight.ts` (`FlightPlan`, validating `parseFlightPlan`).
64. `AirportStore.listAirportsNear` on both stores (Postgres: bounding box
    in SQL, great-circle filter and ordering in code).
65. `src/resolve/taf.ts` (`periodWindows`, `mergeConditions`, `resolveTaf`),
    `route.ts` (`resolveRoute`: waypoints from the store or `lat,lon`, legs,
    cumulative distance, ETAs, alternate leg), `forecast.ts` (`latestTaf`
    issued ≤ asOf; `forecastAt` own-or-nearby), `flight.ts`
    (`resolveFlight`), `describe.ts` (text rendering built from spans so the
    output quotes the TAF verbatim), `index.ts`.
66. CLI `resolve <flight.json> [--fetch] [--as-of ISO] [--json]`;
    `flights/demo-kteb-khpn.json`.

### Tests and fixes

67. `test/resolve/taf.test.ts` — enumerated selection cases on real corpus
    TAFs (KAXN for US `FM`/`PROB30`, EFVA for `BECMG`/`TEMPO`/`PROB30
    TEMPO`/`NSW`); `test/resolve/flight.test.ts` — geo, nearest-time,
    plan parsing, route/ETA, end-to-end over a memory store seeded from the
    recorded AWC responses and the NASR slice, "known as of" behaviour,
    rendering.
68. Fixes on first run: a wrong relative import; `putAirports` arity in the
    test; `parseFlightPlan` validated `departureTime` before `departure` so
    the error named the wrong field (reordered); a degenerate nearest-time
    expectation (day 31 from 30 Sep is a month away either side — the
    function picks Aug 31, the test now says so); the render test expected
    `FM` sources at a 13:00Z departure when the base period was still in
    force (test now also checks a 16:00Z departure); `hh:mm` vs `hhmm` in a
    regex.
69. Verified against Postgres: `resolve flights/demo-kteb-khpn.json --as-of
    2026-09-07T12:30:00Z` prints ETAs, METARs, the governing TAF period per
    waypoint quoted verbatim, N07 borrowing KTEB's TAF at 13 NM; at a 16:00Z
    departure the `FM071400` period is cited instead. 448 tests.

### Docs

70. Plan step 3 done with decisions; step 4 marked next. Onboarding §3/§4/§5
    (next task → rules engine, with inputs ready). README status and
    commands. This log.

### State at end of session 4

- 448 tests, typecheck clean. Four sessions of work uncommitted.
- Docker Desktop and Postgres running; dev DB holds the NASR cycle and six
  real reports (KJFK/KTEB/KHPN METAR+TAF).
- Open: FAA NOTAM credentials; the owner's real demo flight and personal
  minimums (needed to make step 4's fixture real rather than placeholder).

---

## Session 5 — 2026-09-07 — The owner's flight; Canadian airport data

71. Owner supplied the demo flight and minimums: CYSN → CYKF at 15:00Z,
    alternate CYHM, C172; personal minimums 2,500 ft AGL ceiling, 5 SM
    visibility, 15 kt crosswind including gust; POH to follow. Saved as
    `flights/demo-cysn-cykf.json`, `profiles/default.json`,
    `aircraft/c172.json`. Recorded the jurisdiction implication in the plan
    and onboarding: Canada is the primary case; step 4 needs a CARs
    602.114/602.115 table beside FAR 91.155.
72. Probed the upstreams for the three fields: all have METAR and TAF on AWC
    (CYKF's TAF has `TEMPO`/`BECMG`/`FM`). AWC's `airport` endpoint is
    incomplete for Canada (null runway alignments at CYSN, no variation at
    CYKF, elevations in metres). OurAirports (public domain) has complete
    runways with true headings for all three.
73. Added `src/fetch/ourairports.ts` (airports.csv + runways.csv → the same
    `Airport` type; `source: 'ourairports'`, no magnetic variation, closed
    fields skipped, `--country` filter), `Airport.source`, migration 0003
    (table renamed to `airports`, `source` in the key), CLI `ourairports
    <dir> [--country XX]`, a verbatim five-airport fixture (CYSN, CYKF,
    CYHM, KJFK, CNC3), `test/fetch/ourairports.test.ts`, contract additions.
    Loaded 2,481 Canadian sites into the dev DB.
74. **Found a trap:** NASR contains 147 foreign border-area fields with no
    runway alignments; my "NASR wins" preference handed back that CYSN
    record over the complete OurAirports one. Fixed with
    `airportPreference`: NASR wins only for US fields, OurAirports elsewhere.
    Rows stored before `source` existed lacked it inside the JSON —
    migration 0004 backfills. CNC3 also exposed that Canadian idents are
    alphanumeric (ICAO fallback regex widened).
75. Verified: `airport CYSN` → OurAirports, three runways (06/24 at
    52.7°T/232.7°T); `airport KJFK` → still NASR with variation −13;
    `resolve flights/demo-cysn-cykf.json --fetch` → CYSN base period, CYKF
    prevailing from base + completed `BECMG 0713/0715 33005KT`, CYHM base.
    454 tests.
76. Docs: plan (step 3 demo flight, jurisdiction note, step 4 CARs table,
    open question 1 answered — POH still needed), onboarding §3/§5, README
    sources and commands. Memory note about the owner's context.

### State at end of session 5

- 454 tests, typecheck clean. Five sessions uncommitted.
- Dev DB: 19,411 NASR + 2,481 OurAirports (CA) airports; reports for
  KJFK/KTEB/KHPN/CYSN/CYKF/CYHM.
- Open: C172 POH (demonstrated crosswind, limitations, W&B); FAA NOTAM
  credentials; Canadian NOTAMs will need a source too (the FAA API covers
  US NOTAMs — note for step 6).

---

## Session 6 — 2026-09-07 — Rules engine (step 4)

77. Decisions before code: severity ladder (prevailing/near-ETA METAR
    violation → `no-go`; overlay or stale METAR → `marginal`; `advisory`
    never moves the verdict; passes are `ok` findings with citations);
    crosswind true-on-true with `VRB` as full speed, gusts per profile,
    POH demonstrated figure as a separate finding; regulatory minima as a
    pure function with both CARs and FAR tables, airspace class from an
    `airspace` map in the flight plan until step 8, unknown → advisory;
    day/night from solar elevation.
78. `src/domain/profile.ts` (`PilotProfile`, `AircraftLimits`, parsers),
    `src/domain/sun.ts` (NOAA solar elevation, civil twilight −6°),
    `FlightPlan.airspace`/`profile`/`aircraft` fields.
79. `src/rules/`: `types.ts` (`Finding`, `Citation`, `Verdict`, `Briefing`,
    `RULES_VERSION`), `vfrMinima.ts` (7 CARs rows, 9 FAR rows),
    `crosswind.ts` (components, per-end analysis, best runway),
    `checks.ts` (ceiling, visibility, crosswind + demonstrated + gust
    spread, regulatory incl. cloud clearance at cruise, night),
    `evaluate.ts` (per point: prevailing → overlays → METAR within 90 min
    hard else soft → night; verdict = worst; alternate reported, not
    grounding), `describe.ts`. CLI `brief`. Both demo flights gained
    `airspace` maps and profile/aircraft paths.
80. Tests: one per regulatory row; crosswind maths on CYSN's real runways;
    each check on synthetic conditions decoded from real syntax; end-to-end
    briefing over the seeded memory store (verdicts, citation spans slice
    back to their text, stricter profile → no-go, unknown-as-of → marginal,
    deterministic). Solar: CYSN sunrise/sunset within 1.5° and twilight.
81. Fixes on first run: reciprocal runway ends have equal crosswind up to
    floating point, so the best-runway sort now treats near-equal
    crosswinds as ties and prefers headwind; four wrong expectations of
    mine (sin 20°; `SKC` gives no cloud-clearance finding; 2 kt limit not
    tripped by 0.9 kt; the reciprocal legitimately ranks second).
82. Live: `holdshort brief flights/demo-cysn-cykf.json --fetch` → GO at
    CYSN, CYKF and CYHM, 8 cited findings per point (prevailing + observed
    14:00Z), CARs 602.114 control-zone row applied. 513 tests.
83. Docs: plan step 4 done with decisions and deferrals (alternate rules,
    fuel, currency, W&B); step 5 next; onboarding §3/§4/§5; README.

### State at end of session 6

- 513 tests, typecheck clean. Six sessions uncommitted.
- The deterministic pipeline is complete on the CLI: fetch → decode →
  resolve → evaluate → cited verdict, for the owner's real flight.
- Open: C172 POH; FAA NOTAM credentials and a Canadian NOTAM source;
  hosting decision before step 5's API.

---

## Session 7 — 2026-09-07 — Commits; briefing store, API and web app (step 5)

84. Committed six sessions of work as five step-ordered commits (decoders;
    store + fetch; resolution; rules; CLI + docs), each buildable, no
    attribution trailers, then the workspace conversion as a sixth.
85. `git mv` of `src/`, `test/`, `scripts/`, `tsconfig.json` into
    `packages/core`; root `package.json` became the workspace root with
    scripts delegating to `packages/*` and `apps/*`; `.gitattributes`
    normalises line endings. Two test paths and the corpus script's fixture
    path adjusted. 513 tests still green after the move.
86. `packages/core/src/brief/`: canonical JSON + SHA-256 (`contentHash`),
    `assembleBriefing` (rules output + plan + profile + aircraft + `asOf` +
    code versions + every report hash judged on → `StoredBriefing`),
    `flightKey`. `BriefingStore` on memory and Postgres, migration 0005,
    contract and assembly tests (hash stable across `createdAt`, differs by
    profile, round-trips).
87. `apps/api`: Fastify `buildServer` (health, airports, briefings POST/GET/
    list, static SPA with fallback; 400 on bad input, 422 on unknown
    waypoint); `main.ts` over Postgres with `.env`; tests via
    `fastify.inject` over a memory store and recorded responses.
88. `apps/web`: Vite + React — flight form defaulting to the owner's
    flight, minimums/aircraft form, briefing view with per-point cards,
    findings expandable to the raw report with the cited span highlighted
    (`<mark>`), Zulu with local beside it, sticky safety banner, report
    hash list. Local copy of the API types so the bundle never imports the
    Node side of core.
89. Fixes: a duplicated `vite` install made `vite.config.ts` fail
    `tsc` under `exactOptionalPropertyTypes` — excluded from the web
    tsconfig (Vite loads it itself); a fixture path slip in the API test.
90. Verified live: API on :3111 over the Compose Postgres — `POST
    /api/briefings` for the owner's flight → 201, hash, verdict GO, 6
    reports; GET and list; SPA served at `/`; migration 0005 applied. Web
    view exercised through the API and the build only — **not yet opened
    in a browser**. Stopped the server with a broad `taskkill` on node.exe
    with a filter — sloppier than it should have been; a PID file or
    `kill $!` next time.
91. Docs: plan step 5 done, step 6 next with its blockers (NOTAM
    credentials; a Canadian NOTAM source); onboarding §3 (workspace
    layout), §4, §5; README.

### State at end of session 7

- 527 tests across workspaces, typecheck clean. Committed through the
  workspace conversion; step 5 files pending commit.
- Open: C172 POH; FAA NOTAM credentials; Canadian NOTAM source; hosting;
  a visual check of the web app by the owner.

---

## Session 8 — 2026-09-12 — NOTAM pipeline and eval harness (step 6)

92. Probed the NOTAM sources before designing anything. **NAV CANADA CFPS**
    (`plan.navcanada.ca/weather/api/alpha/?site=CYSN&alpha=notam`, the JSON
    endpoint its own planning site calls) returns Canadian NOTAMs with no
    key — the blocker from session 7 dissolved. The FAA's NOTAM search
    backend is behind Akamai (403) and the official API still answers 401
    without credentials, so US NOTAMs stay unbuilt rather than faked.
    Ollama is not installed (RTX 3060 present, nothing on 11434).
93. Recorded 41 NOTAM records (31 distinct) for CYSN/CYKF/CYHM as fixtures.
94. Ran a workflow to produce the ICAO Q-code tables: two independent
    drafts, reconciled, then three adversarial reviewers with different
    lenses (wrong meanings / missing entries / real-world use). Zero
    refutations, zero problems, zero missing. 181 subjects, 80 conditions →
    `src/notam/qcodes.ts`, generated by `scratchpad/gen-qcodes.cjs`.
    Unknown codes decode to null, never a guess.
95. `src/notam/decode.ts` — ICAO NOTAM decoder. Fields located by an
    order-aware scan so `A)` inside free text is not mistaken for a field;
    every field span-annotated; total. `src/fetch/navcanada.ts` fails loudly
    on any shape change rather than returning empty data.
96. `filter.ts` (schedule expansion for `DAILY` and `MON dd dd hhmm-hhmm`,
    geography against the route, conservative on anything unreadable),
    `dedupe.ts` (folds FIR-wide repeats, flags superseded).
97. `src/llm/` — provider interface, `FixtureProvider` **first**,
    `RecordingProvider`, `OllamaProvider`, `BudgetedProvider`, `llmFromEnv`.
    `assess.ts` — the only place a model sees a NOTAM; cache key is (NOTAM
    hash, flight-context hash, prompt version, model); a `cited_span` not
    verbatim in the NOTAM demotes the answer to `unverified`.
98. `flight.ts` ranks `critical → advisory → unverified → not-assessed →
    irrelevant → out-of-scope`. Everything fetched is in the output.
99. **Store change:** a FIR-wide NOTAM is about no station, so a per-station
    listing missed it. Added `station` to `FetchEvent` (migration 0007) —
    the fetch records which site it was *for*, and `listRaw` matches either.
    Also `knownBy` on `listRaw`.
100. Labelled set: a three-perspective panel workflow (instructor,
     safety-minded private pilot, flight service specialist) labelled all
     31 NOTAMs; 28 unanimous, 3 at 2/3, none needing adjudication. Written
     as `test/fixtures/notam/labelled/` and **marked provisional pending the
     owner's review** — it is the yardstick, so a wrong label is worse than
     a wrong answer.
101. `eval.ts` + `scripts/notam-eval.ts` + `npm run eval:notam`. The gate in
     `test/notam/eval.test.ts` **skips with a message** when no recordings
     exist for the current prompt version — never silently passes.
102. **Bug found by the live smoke test.** The CLI printed "0 NOTAMs" while
     the API printed 31. Cause: `notamsForFlight` filtered by "known by the
     briefing instant", but the fetch it performs lands *after* that
     instant, so a live briefing discarded what it had just retrieved. The
     API test had only passed because an earlier CLI run had already stored
     them. Fixed by treating this call's fetch as part of what the briefing
     knows; a test now pins both halves (fetch-and-see, and reproduce-an-old-
     instant-and-see-nothing). My first version of that test asserted the
     wrong thing and was corrected rather than the code.
103. Also: CLI restructured to open the store once (`withFlight`); Postgres
     test truncate list missed `notam_assessments` (FK error).
104. Briefing document format 1 → 2: adds `notams` and the NOTAM decoder and
     prompt versions. Web gained `NotamPanel` — grouped by rank, each item
     expanding to the raw NOTAM with the model's cited span highlighted.
105. Verified live: `holdshort notams flights/demo-cysn-cykf.json --fetch`
     → 31 NOTAMs, Q-codes in English ("Runway · Closed"), classification
     reasons per item, FIR-wide ones folded across three sites, 3
     out-of-scope by schedule. 576 tests, 2 skipped (the eval gate).

### State at end of session 8

- 576 tests across workspaces, typecheck clean, web builds.
- Open: **install Ollama and record fixtures** to turn the relevance model
  on and make the eval gate live (onboarding §5a); **owner review of the
  provisional labelled set**; the C172 POH; FAA NOTAM credentials for US
  fields; a visual pass over the web app.

---

## Session 9 — 2026-09-12 — Fixes, then the briefing diff (step 9 / M8)

106. Picked up the two loose ends from session 8. The API's new NOTAM tests
     failed and the CLI's live run printed "0 NOTAMs" while the API printed
     31 — one cause: `notamsForFlight` filtered by "known by the briefing
     instant" while its own fetch lands *after* that instant, so a live
     briefing discarded what it had just retrieved. Fixed, with a test
     pinning both halves (fetch-and-see; reproduce-an-old-instant-and-see-
     nothing). My first version of that test asserted the wrong thing —
     re-briefing the *same* instant without fetching correctly sees nothing
     — and the test was corrected, not the code.
107. CLI restructured to open the store once (`withFlight`); the Postgres
     test truncate list was missing `notam_assessments`.
108. Chose step 9 over steps 7 and 8: the POH has not arrived (step 7) and
     airspace data is a separate fetch (step 8), while the diff was
     unblocked and is the feature the spec calls the differentiator.
109. The insight that made the diff small: the rules engine already encodes
     every threshold in a finding's severity, so "crossed a personal
     minimum" is exactly "severity moved across the ok boundary". No second
     copy of the limits anywhere.
110. `Finding` gained `basisKind` (`RULES_VERSION` → 2) so findings match
     across briefings when the readable basis differs (`observed 1051Z` vs
     `observed 1151Z`). The diff falls back to parsing `basis` for older
     briefings, with a test that deletes the field.
111. `src/brief/diff.ts` + `describeDiff.ts`; `holdshort diff`;
     `GET /api/briefings/:sha256/diff`; a web `DiffPanel`.
112. Tests built on the recorded six-hour KJFK history so the "weather
     changed" cases are real: 33005KT → 34007KT is 2.4 → 4.4 kt of
     crosswind. Against the owner's 15 kt limit that is `restated` and the
     diff is quiet; against a 3 kt limit the same move is `worsened` and
     flagged. Three of my expectations were wrong first time (the rules
     version, a report legitimately *removed* from the inputs, and instants
     that conflated "forecast arrived" with "wind changed") and were fixed
     in the tests.
113. **Bug the live run caught:** "the previous briefing" was "the newest
     that is not this one", which can be newer than the one just made — the
     demo read "Since your 20:01Z briefing (now 13:00Z)". Now the newest at
     or before, in CLI and API, with a test that stores a later briefing
     first.
114. Second live pass showed every new NOTAM flagged as crossing a limit,
     including an out-of-scope runway-surface report. Added `notable` to
     NOTAM changes: out-of-scope and irrelevant ones are listed but are not
     news and do not make a diff loud.

### State at end of session 9

- 586 tests across workspaces, typecheck clean, web builds.
- Verified live against Postgres: two briefings of the owner's flight, the
  diff reading forwards in time, all 31 NOTAMs reported as new against an
  earlier briefing that had none.
- Open, unchanged: install Ollama and record fixtures (onboarding §5a);
  owner review of the provisional labelled set; the C172 POH (blocks step
  7); airspace data (step 8); a visual pass over the web app.

---

## Session 10 — 2026-09-12/13 — The model turned on, the labels reviewed, the POH read (step 7 / M6b)

The owner asked for three things at once: install and run the local model,
review the provisional NOTAM labels properly, and ingest the C172 POH they
had just dropped into the repo root.

### The model

115. Installed Ollama 0.34 (winget) and pulled `qwen2.5:7b`. The first
     request died with "CUDA error: device kernel image is invalid" — the
     bundled CUDA build is newer than this laptop's 546.92 driver. Ran the
     server on its Vulkan backend instead (`OLLAMA_VULKAN=1
     CUDA_VISIBLE_DEVICES=-1 ollama serve`), which puts the whole 7B model
     on the RTX 3060 and answers in a few seconds. Recorded in
     `.env.example` and onboarding, because the next person will hit it.
116. First eval run: **61.5 % agreement**, and worse than that number
     suggests — precision and recall on `critical` were both **0 %**. The
     model called the departure runway closure *irrelevant*. Two prompt
     revisions followed (v2 added the aerodromes and their roles plus the
     deterministic facts; v3 reordered the schema so the model explains and
     quotes before it commits, added worked examples, and asked for a short
     citation), taking it to 64.3 % with critical recall at 100 %.
117. **The decision that actually fixed it.** A runway closure at an
     aerodrome the flight uses is not a judgement call, and no ranking
     should depend on a 7B model getting it right. Added
     `src/notam/rules.ts`: relevance settled from the ICAO Q code and the
     flight wherever there is one right answer — runway, declared distance
     and threshold changes at an aerodrome in use are critical; ILS and
     instrument procedures are irrelevant to a VFR flight; trigger NOTAMs
     and FIR-wide entry requirements are irrelevant; ARFF category is not a
     private flight's concern. The model is left the cases that need
     reading: obstacles, taxiways, markings, services.
118. The remaining error was over-calling critical on ten lighting and
     obstacle items. Lighting out by day is another thing that is not a
     judgement call, so `daylight` (civil twilight at each point's own
     position and ETA) joined the flight context, and a lighting rule with
     it.
119. **Final: 85.7 % agreement** on 28 assessed of 31 labelled; critical
     recall 100 %, irrelevant precision and recall 100 %, category
     agreement 100 %, zero unverified citations. The four remaining
     disagreements are all "advisory called critical" — over-warning, the
     safe direction. The eval gate in `test/notam/eval.test.ts` is live and
     passing against recorded fixtures.
120. The scorer had been counting deterministically out-of-scope NOTAMs as
     model misses. Added `filtered` to `EvalScore` and excluded them, so
     the model is scored on what it was actually asked.

### The labels

121. Put the 31 provisional labels through a second panel — instructor and
     examiner, regulatory, flight service briefer — each asked to *refute*
     every label rather than to agree. **0 of 31 refuted**, none needing
     adjudication. The file now records the review and carries four
     `openQuestions` for the owner, the sharpest being whether CYSN's 06/24
     is a practical alternative for a C172 once 11/29 is closed.

### The POH

122. `C172MPOH.pdf`: 148 scanned pages, no text layer. The first render came
     out entirely blank, and silently — pdf.js decodes JBIG2 with a
     WebAssembly module and has to be told where it is (`wasmUrl`).
123. OCR settings, measured on the sample loading page by how many of 18 key
     numbers came back right: telling Tesseract the true resolution took it
     from 4/18 to **12/18**, worth more than render scale or segmentation
     mode. Pages printed sideways (about a fifth of the handbook) are
     retried at 90° and 270° and the best reading kept, with boxes mapped
     back to the scanned page so a highlight lands on the right ink.
     Whole handbook: 148 pages read, mean word confidence 79, 30 sideways.
124. **Quotes instead of token ids.** The extraction first asked the model
     for the ids of the words each figure came from; the 3B vision model
     cited "4 provides checklist and amplified procedures" for the
     demonstrated crosswind. Switched to quoting the line, which a small
     model can do, and made the locator do the hard part: match a quote to
     the printed line even when the model reads the image cleanly and the
     scan says "Aff:" for "Aft:", follow a sentence across the lines it
     wrapped onto, and require an exact match for anything carrying a digit
     so that "2400" can never stand in for "2300". Verified figures went
     1 to 5 to 6.
125. Added the check that earns its keep: the quoted line must carry the
     words naming the field and sit under the right category heading. It
     immediately caught the model reporting the *utility* 2,000 lb takeoff
     limit as the normal-category one, and reporting 340 lb as the
     demonstrated crosswind from the pilot-and-front-passenger row.
126. **Measured** (`test/docs/extract.test.ts`): 28 figures proposed, 6
     verified, **all 6 correct** against a hand transcription of the same
     pages; 22 sent to review. Precision is a hard gate and recall is only
     reported — a missed figure is safe in a way an invented one is not.
127. `src/wb/compute.ts` reproduces the POH's own worked example exactly,
     which is how a scan error surfaced: the page's OCR reads the front-seat
     moment as 12.8, but 340 lb at the 37 in arm is 12,580 lb-in, and only
     12.6 makes the printed total of 102.9 add up. Rows are rounded before
     summing, as the POH does.

### The review, and what it found

128. Ran an adversarial code review over the new code — five dimensions,
     each finding then attacked by three skeptics with different lenses.
     **The verification phase died on a session limit**: 36 of 38 agents
     failed, so the findings arrived unverified. Checked all eleven by hand
     against the code instead. Every one was real. The two that mattered:
129. **Word ids collided across runs.** Ids came from a run-local counter
     advanced in page order, so `doc wb --pages 90` followed by
     `doc wb --pages 88` handed both pages ids starting at 1, and
     `tokensById` — a document-wide map — let the later page overwrite the
     earlier one. A figure quoted on page 88 would then be checked against
     page 90's words, and the citation stored with it would point at the
     wrong ink. Ids are now `page * 100_000 + index`, identical whatever a
     run touches, and `alignWbExtraction` looks words up on the page under
     test only. Reader version bumped to 2 and the handbook re-read.
130. **Weight typed for a missing station vanished.** The web panel asked
     for pilot, rear, baggage and fuel from a fixed list, while the spec
     only carries stations whose arm survived verification — so 340 lb of
     rear passengers could be typed, silently not counted, and an
     over-gross aeroplane could come back WITHIN LIMITS. The panel now
     builds its form from `spec.stations`, and `computeLoading` refuses a
     load at a station it has no arm for rather than dropping it.
131. Also fixed: a full ingest run never reused cached pages, and its first
     checkpoint erased the previous run's progress (`keep` was hard-wired
     false when no page subset was given, and the checkpoint padded
     unreached pages with blanks); one page throwing took the whole
     document down; a page that recognised zero words was cached as "read"
     forever (pages now carry `read | blank | failed | pending`);
     `ocr.json` was written non-atomically and parsed unguarded; the CLI
     treated a partially ingested cache as complete; the crop endpoint read
     and decoded synchronously with no bounds and no error handling; the
     "these are the sample airplane's figures" warning vanished as soon as
     the empty weight was edited, leaving the sample *moment* presented as
     the owner's own; and the weight-and-balance result carried no "not an
     official computation" line.
132. One more, found while testing the fix for another: the sloped forward
     CG limit is held flat above its last stated point, which is correct for
     "35.0 inches at 1950 lbs. or less" and dangerous when only the light
     end was extracted — a 2,300 lb loading judged against the 1,950 lb
     limit would read as within limits. `computeLoading` now refuses a
     weight the stated line does not reach, unless the aeroplane is already
     over gross, in which case it says which weight the limit belongs to.

### The loop closed

133. The review queue listed 22 figures and offered no way to act on them,
     so the loading computation could never run. Added `holdshort wb
     confirm`: the owner gives a figure they have read off the page, and the
     handbook still has to agree. It records which of three things it could
     establish — stated beside words naming the field, printed on a page the
     owner names with nothing on that row to check it against, or
     `--on-my-word` for a figure the scan cannot read at all — and the note
     on every figure says which. Confirmations survive re-extraction.
134. Two defects surfaced from *using* it rather than reading it. Searching
     the whole handbook for the fuel arm matched "Total Usable: 48 gallons"
     — the right number, the wrong ink — so the search is now limited to the
     pages the data came from, and an arm must sit beside a word meaning an
     arm. And the note on a confirmed figure claimed the owner had entered
     it when the command had been run by me; it now says how a figure was
     entered, not who entered it.
135. Assembly moved out of the command into `src/wb/assemble.ts`, shared by
     both paths, and the flat figure list now lives in the spec file — which
     is what lets a later extraction run add to confirmations rather than
     flatten them.
136. **The whole chain now runs on the owner's handbook**: a 148-page scan,
     a model reading five pages, six figures verified against the ink, the
     rest confirmed by hand, and a loading that reproduces the handbook's
     own worked example (2,300 lb, 102.9 moment/1000, CG 44.7 in) with every
     limit traceable to the line it came from.
137. And the payoff the spec asked for — extraction feeding a verdict: the
     demonstrated crosswind read off page 42 now reaches the rules engine,
     so the briefing's crosswind finding cites `C172MPOH.pdf p.42: Maximum
     Demonstrated Crosswind Velocity...` instead of taking 15 kt on trust.
     A figure typed into `aircraft/c172.json` still wins, since that is the
     owner speaking about their own aeroplane.

### State at end of session 10

- 631 tests across workspaces, typecheck clean, web builds.
- The relevance model runs locally and its eval gate passes at 85.7 %.
- The owner's POH is read end to end: 6 figures verified, 22 awaiting the
  owner's review, and the computation refusing to run until the envelope is
  complete — which is the designed behaviour, not a gap.

---

## Session 11 — 2026-09-13 — Forecast verification (step 10 / M9)

138. Checked whether step 8 was still blocked before skipping it: NAV
     CANADA publishes no airspace geometry, open.canada.ca has nothing
     usable, OpenAIP needs a key. The FAA's ArcGIS `Class_Airspace` layer is
     queryable, so the US half is buildable — but the owner flies in Canada,
     so step 10 was the better next move, and it needed no new data at all.
139. A briefing now records what each waypoint's forecast asserted for that
     waypoint's ETA, and `holdshort verify` later pairs each prediction with
     the observation nearest its moment. Both halves are written once, so a
     second run only adds; a moment with nothing within 35 minutes keeps
     waiting rather than being paired with something far off.
140. **The judgement that makes it worth having.** "How often was the TAF
     right" needs a tolerance nobody agrees on. Which way it was wrong does
     not, and it is the question that matters: a forecast promising a better
     ceiling than arrives is the one that gets people airborne into weather
     they did not plan for. Every pair is scored optimistic, pessimistic or
     close, and the summary leads with how often the forecast was optimistic
     and by how much at worst.
141. **`P6SM` is a floor, not a measurement**, and this only surfaced
     because the end-to-end test failed on real data: KJFK forecast `P6SM`
     and observed `10SM`, which scored as *pessimistic*. Almost every
     fair-weather TAF says "six or more" and observations of ten are
     routine, so the visibility column would have been measuring the
     phrasing of TAFs rather than their accuracy. An open-ended forecast the
     observation meets is now reported as met, with no error at all — the
     same for `CAVOK` and `9999`.
142. A TEMPO is not what a TAF asserts, so the prevailing conditions are
     what gets scored. But when the category is missed, the check records
     whether an overlay in the same TAF had allowed for what arrived: a
     forecaster who wrote "TEMPO IFR" and got IFR was not blind to it.
143. Below eight pairs the summary says nothing rather than something
     unfounded about a station.
144. Two pieces of tidying the work forced, both good. `ceilingOf` existed
     twice — once in the rules engine, once (newly) in the derived-value
     module — so the rules engine and the verifier could have drifted apart
     on what a ceiling is. One definition now, which is exactly the property
     verification needs. And the scorer's own statistics were misleading at
     first: a met "at least" forecast reported a median error of +9 SM
     beside "close 100%", so a satisfied bound now contributes no error.
145. Store gained `forecast_checks` and `forecast_outcomes` (migration
     0008), both append-only, with the same contract test running against
     the memory and Postgres backends. The migration was edited after it had
     already applied locally; since it is unreleased, the tables were
     dropped and its record removed so it could re-apply, rather than
     carrying a patch migration for a schema nobody else has.
146. **Verified live on real weather.** A CYSN TAF issued 1940Z on 12
     September forecast a ceiling 900 ft higher than the observation that
     arrived at the flight's ETA — the first real finding the feature has
     produced, and the direction that matters.

### State at end of session 11

- 653 tests across workspaces, typecheck clean, web builds.
- Steps 1-7, 9 and 10 done. Step 8 blocked on data, not on effort.

---

## Session 12 — 2026-09-13 — The public website (started, paused)

147. The owner asked for a website for this project, to put on a resume,
     free or very nearly free. Two questions had to be answered before any
     of it could be built: what gets deployed, and where.
148. **What: a static site built from committed fixtures, not a live
     deployment.** The reasoning is worth keeping, because the tempting
     answer is the wrong one. NAV CANADA's CFPS endpoint is unofficial, and
     a public site calling it on behalf of strangers would be discourteous
     and would eventually be blocked. The weather service asks for
     identified, reasonable use. And a publicly usable "should I go?" tool
     invites exactly the operational use every screen of this project
     disclaims. A static site also costs nothing, never falls over, and
     shows the same output — which is what a link on a resume has to do.
149. **Where: Cloudflare Pages**, free, `holdshort.pages.dev`. For a real
     domain, Cloudflare Registrar sells at wholesale with no markup and no
     renewal spike, roughly $10 a year for `.dev` or `.com`. Nothing has
     been registered or deployed — both need the owner's accounts.
150. `packages/core/scripts/build-demo.ts` builds the demo payload from
     committed fixtures alone: no network, no database, no model at run
     time. Given `HOLDSHORT_LLM=ollama` it records any answer it lacks into
     the fixture directory, so the next build needs nothing again.
151. Recorded 78 real METARs and 3 TAFs for CYSN, CYKF and CYHM as a
     fixture, verbatim as the weather service returned them. The
     observations deliberately run past the briefing moment, so the same
     fixture can also demonstrate forecast verification.
152. The demo moves the flight's departure from 2026-09-14T15:00Z to
     2026-09-12T22:00Z, and the site will have to say so plainly. Those
     TAFs were issued at 1940Z on the 12th and run only to 0100Z on the
     13th, so the real departure sits outside them and the demo would show
     nothing but "no forecast covers this". Everything else — route,
     aircraft, personal minimums, every report — is exactly as it is.
153. That move changed the flight context, which is part of the assessment
     cache key, so eight NOTAMs came back unassessed on the first build.
     Recorded those eight against the live model rather than shipping a
     demo with holes in it. The payload is now a real briefing: verdict
     marginal, 34 reports cited, 31 NOTAMs ranked (8 critical, 9 advisory,
     9 irrelevant, 5 out of scope).
154. Also answered a question worth writing down: **no, this cannot keep
     working while the laptop is closed.** There is no git remote, and
     146 MB the work depends on is deliberately not in git — the POH
     (7.9 MB) and the OCR cache (138 MB) — besides a local Postgres and a
     local Ollama. Nothing could continue elsewhere until a remote exists
     and those assets are dealt with.

### Where this stopped

Three things remain, in order: demo mode in the web app (`App.tsx` still
only knows how to POST to the API and needs to load `/demo/briefing.json`
when there is none), the landing content a reader arrives at, and the
Cloudflare Pages configuration and first deploy.

### State at end of session 12

- 653 tests across workspaces, typecheck clean, web builds.
- Steps 1-7, 9 and 10 done; step 8 blocked on data; the website started.
