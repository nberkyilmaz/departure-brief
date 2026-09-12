# Work log

A chronological record of what was done, in the order it was done, including
the wrong turns. One entry per action; a heading per working session.
Numbers are what was measured at the time. **Append to this file at the end
of every session** — it is the answer to "why is it like this?" six months
from now.

Related: `docs/plan.md` is the sequence *ahead*; this file is the sequence
*behind*. `docs/onboarding.md` §3 is the current state.

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
