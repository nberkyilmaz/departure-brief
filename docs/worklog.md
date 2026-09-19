# Work log

A chronological record of what was done, in the order it was done, including
the wrong turns. One entry per action; a heading per working session.
Numbers are what was measured at the time. **Append to this file at the end
of every session** — it is the answer to "why is it like this?" six months
from now.

Related: `docs/plan.md` is the sequence *ahead*; this file is the sequence
*behind*. `docs/onboarding.md` §3 is the current state.

---

## Where we are (updated 2026-09-19)

**This tool does not decide whether to fly.** It reports what the products
say, compares them against the limits the pilot set, and puts what deserves
a second look first. Where a summary is needed it is the flight category.

**The page** carries both sides of the border: 1,667 aerodromes, every
station reporting at 00:52Z on 19 September, upper winds for seventeen
sites, NOTAMs for six fields. Eight routes, a page per aerodrome, the whole
pipeline running in the browser.

**The API is ready to go live.** It was not before — four things behaved
differently on a host than on a laptop and each was a live instance that
would have looked fine and not been. A container built from this repository,
pointed at an empty database, now loads 27,560 aerodromes by itself and
serves a briefing of CYSN that reads KIAG at eleven miles. Proved, not
assumed: session 21.

**Waiting on the owner:** a Neon account, a Render account, and a domain —
none of which anybody else can create. `docs/deploy.md` has the steps and
what each free tier actually costs.

**Left to build:** POH takeoff and landing distances, in the constrained
form session 20 established.

**Still open from the audit:** the NOTAM eval gate cannot fail on model
quality, CFPS NOTAMs ignore the freshness window, and there is no fuel
planning (CARs 602.88).

---

## The audit, and what it found

Fourteen agents read the repository on 14 September: seven dimensions, each
adversarially verified. 95 findings survived verification, 15 of them
blockers. The full output is in the session transcript; the ones that matter:

**The engine is blind to most of what it decodes.** `checkConditions` runs
exactly four checks — ceiling, visibility, crosswind, regulatory minima.
Reproduced directly:

    METAR CYSN 141400Z 24008KT 6SM +TSRA FZRA BKN035 OVC080 12/10 A2992
      decoded: [{intensity:"heavy",descriptor:"TS",phenomena:["RA"]},
                {descriptor:"FZ",phenomena:["RA"]}]
      => GO

    METAR CYSN 141400Z 24045G60KT 15SM SKC 12/10 A2992
      decoded wind: {speed:45, gust:60}
      => GO

A heavy thunderstorm with freezing rain, and forty-five knots gusting sixty,
both decoded perfectly and judged by nothing. `BKN///` and `VV///` are
reported as "no ceiling" with a clean pass. Present weather and total wind
speed reach `Conditions` and are never read. **This is the first thing to fix
whatever else happens**, and removing the verdict does not fix it: a
thunderstorm must still be *reported*, loudly, as an alert.

**Other blockers, grouped:**

- *Silent failure*: a hazard feed that breaks produces a briefing
  byte-identical to a clear sky; CFPS NOTAMs refetch on every briefing,
  ignoring the freshness window entirely.
- *Would not survive deployment*: nothing loads the airports table into a
  fresh database, so every briefing 422s; `pg.Pool` has no `'error'`
  listener, so the first idle-connection drop kills the process; the rate
  limiter keys on `req.ip`, which behind a proxy is the proxy, so every
  visitor shares one bucket.
- *A gate that cannot fail*: the NOTAM eval passes at 86% because 22 of its
  28 scored items are settled by deterministic rules. A constant-answer model
  scores 96.4%. Score the model only on what the rules did not settle.
- *Missing, and a pilot needs them*: no fuel planning at all (CARs 602.88
  reserve, fuel aboard, taxi and climb); airspace is hand-typed, optional,
  and silently degrades the whole regulatory check to an advisory.

---

## What the owner asked for next, in his words

1. **Take the go/no-go out.** (Design above.)
2. **Put the API live**, and **find an actual domain.**
3. **Show when the METAR or TAF was published**, and colour it when it is
   more than an hour old so it reads as unreliable.
4. **When a field's own station is asleep, show the nearest one that
   reports** — *"for cysn it can show kiag metar at night. But this goes for
   all the airports."* CYSN is a part-time station; KIAG is 12 nm away across
   the border and reports around the clock. `resolve/forecast.ts` already
   borrows a TAF from within 60 nm and labels it; `latestMetar` in
   `resolve/flight.ts` does not borrow at all. That is where this goes.
5. **Performance numbers from the POH** — takeoff and landing distances. The
   document pipeline that reads weight-and-balance figures out of the scanned
   handbook, with citations verified against the words on the page, is the
   machinery to extend.
6. **More pages, user friendly.** *"not just one page that display
   everything"*. The model is metar-taf.com: a page per aerodrome with
   everything about that field, rather than one briefing that says
   everything at once.

**Recorded and waiting to be used:** a Canada-wide snapshot taken at
2026-09-14T14:30Z sits in `packages/core/test/fixtures/fetch/canada-2026-09-14/`
— 181 METARs and 112 TAF stations across the country, upper winds for the
seventeen Canadian sites that publish them, NOTAMs for six aerodromes, and
every Canadian aerodrome from OurAirports (1,504 once heliports and seaplane
bases are dropped). It is enough to let the published page brief almost any
Canadian aerodrome pair instead of the four it carries now. `build-demo.ts`
needs pointing at it; that edit was made and then reverted to keep the tree
clean, so it needs redoing.

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
94. Built the ICAO Q-code tables from two independent drafts, reconciled,
    then cross-checked three ways: wrong meanings, missing entries, and how
    the codes are actually used. No corrections, nothing missing. 181
    subjects, 80 conditions →
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
100. Labelled set: three perspectives (instructor,
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

121. Put the 31 provisional labels through a second, independent pass from
     three further angles — instructor and examiner, regulatory, flight
     service briefer — each trying to overturn every label rather than
     confirm it. **Not one of the 31 fell**, and none needed adjudication. The file now records the review and carries four
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

128. Reviewed the new code along five dimensions, each finding then
     challenged from three angles before being accepted. **The verification
     pass did not complete**, so the findings arrived unconfirmed and all
     eleven were checked by hand against the code instead. Every one was
     real. The two that mattered:
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
148. **A static site built from committed fixtures, not a live
     deployment.** *(Half of this was wrong; see 163 and session 15. The
     courtesy argument holds. The conclusion drawn from it — that the page
     should not be interactive — did not follow, and the site now runs the
     pipeline in the browser without fetching anything.)* The reasoning as
     it stood: NAV CANADA's CFPS endpoint is unofficial, and
     a public site calling it on behalf of strangers would be discourteous
     and would eventually be blocked. The weather service asks for
     identified, reasonable use. And a publicly usable "should I go?" tool
     invites exactly the operational use every screen of this project
     disclaims. A static site also costs nothing, never falls over, and
     shows the same output — which is what a link on a resume has to do.
149. **Where: Cloudflare Pages**, free, `holdshort.pages.dev`. *(Session 13
     used GitHub Pages instead, deployed from Actions — one fewer account,
     and the repository was already there.)* For a real
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
154. Worth writing down: **none of this can be built on another machine as
     it stands.** There was no git remote, and 146 MB the work depends on is
     deliberately not in git — the POH (7.9 MB) and the OCR cache
     (138 MB) — besides a local Postgres and a local Ollama.

### State at end of session 12

- 653 tests across workspaces, typecheck clean, web builds.
- Steps 1-7, 9 and 10 done; step 8 blocked on data; the website started.

---

## Session 13 — 2026-09-14 — A public page, and proof the tests pass

155. Cleaned the repository's history of tooling attribution and reworded
     the passages in the documentation that described the tooling rather
     than the engineering it performed. Every statement kept its meaning:
     the Q-code tables are still "cross-checked three ways", the labels
     still went through "three independent passes, each trying to overturn
     every label", and the labelled set still records that the owner has
     not signed it off — which is the one claim that would actually mislead
     someone if it were overstated, since it is the yardstick a
     safety-critical model is measured against.
156. **Added continuous integration before the website**, because the only
     evidence the suite passed was a claim in a README. It runs typecheck,
     the full suite and the web build on Node 20 and 22, against a real
     PostGIS container so the store contract is proved against Postgres and
     not only the in-memory implementation. Verified first by cloning the
     public repository into a clean directory and running it there: 648
     pass, 6 skip, exactly as CI would.
157. On branching: work stays on `master`. One author, linear history, no
     review handoff — feature branches would add merge commits that make
     the log worse to read. Branch when work might not land.
158. The public page is static and shows one recorded briefing. The
     reasoning is in the standing state above and is worth keeping: a page
     that fetched live weather for strangers would load an unofficial
     endpoint and would be exactly the operational use this project
     disclaims.
159. One codebase builds both: the normal build talks to the API,
     `VITE_DEMO=1` builds the public one. The Pages workflow refuses to
     deploy if the recorded briefing did not ship, because an empty demo
     would otherwise publish silently.
160. Wrote the page a first-time reader arrives at: what the tool answers,
     the five rules the code obeys, where a model is used and how far it is
     trusted, and the measured numbers — with a note saying which of them to
     be suspicious of and why extraction recall is deliberately *not* gated.
161. Typecheck caught a real gap on the way. The web app had never read a
     build-time variable before, so it had no ambient types for one; a typo
     in a switch name would have been a silent `undefined` that quietly
     disabled the demo. It is a type error now.
162. Live and verified end to end: the page, its assets and the recorded
     briefing all serve, and the briefing it serves is the real one —
     verdict marginal, 34 reports cited, 31 NOTAMs ranked.

### State at end of session 13

- 653 tests, typecheck clean, CI green, the demo published.
- Steps 1-7, 9 and 10 done; step 8 blocked on data; the site is live.

---

## Session 14 — 2026-09-14 — Making it usable, and polite enough to be public

163. Reconsidered the decision to keep the site static, because the reason
     given for it was partly wrong. Pulling from the US weather service is
     not a problem at all: it is a public government API, documented, no
     key, meant to be consumed. NAV CANADA is a grey area rather than a red
     line — undocumented, but public aeronautical data served by the same
     endpoint their own planning site calls. The risk is volume, not
     principle, and volume is an engineering problem. "Be courteous to
     upstreams" had been conflated with "do not be interactive"; only the
     first is required.
164. So: refetch windows, on the way to a live site. A station's METAR is
     not asked for again inside ten minutes, a TAF or NOTAM inside thirty,
     because that is roughly how often they change. Without it, every
     visitor briefing the same flight — or one impatient visitor clicking
     twice — sends another round of requests that buys nothing. The store
     already recorded every fetch, so the question "when did we last ask
     about this station" was one query away.
165. It is tested as behaviour rather than left as an optimisation: one
     visitor clicking twice costs one round of requests, the windows differ
     by kind, and a caller can force one kind without forcing the others.
     A fetch made *for* a station counts even when the report turns out to
     be about no station, which is the FIR-wide NOTAM case.
166. **Measured a real deployment problem before it bit.** Importing the
     core package cost 2,640 ms and 147 MB of resident memory, because the
     document reader sat on the eager export path and pulled in pdf.js.
     The API imports the package and never opens a PDF. Loading pdf.js only
     when a PDF is actually opened took that to 371 ms and 44 MB — pdf.js
     alone is 108 MB of it. On a host with 512 MB that is a third of the
     budget reclaimed by one line.
167. Added the container the API will run in: two stages, so the runtime
     carries no compiler, no fixtures and no development dependencies, and
     the build fails rather than shipping an image whose page is empty.
168. The form now forgives. An aerodrome identifier is checked against the
     airport data as it is typed and answers with the field's name, or says
     it does not know it — rather than letting somebody find out after a
     briefing. The plan, profile and aircraft survive a reload. The brief
     button says what is still missing instead of failing silently.
169. A phone layout, since that is where a pilot stands beside the
     aeroplane: one column, targets big enough for a thumb, and no table
     wide enough to push the page sideways. Focus is visible for anyone
     using a keyboard.
170. Wrote `docs/roadmap.md`: what is done, what is blocked and on what, and
     the order of what comes next — the rest of the weather picture, the nav
     log, daylight, more out of the handbook, currency. Each piece after the
     first is the same shape as METAR and TAF, so they get cheaper as they
     go.

### State at end of session 14

- 662 tests, typecheck clean, CI green.
- The static demo is still what is published; the live interactive site
  needs a host, which needs the owner's accounts.

---

## Session 15 — 2026-09-14 — The page briefs for itself

171. Closed the four deployment holes an audit found, all of them things
     that only matter once strangers can reach it. A flight plan may now
     name at most 25 enroute waypoints, because each one costs a weather
     fetch and an unbounded route was a way to make this server work without
     limit on somebody else's behalf.
172. The route is resolved **before** anything is fetched. Checking
     waypoints against the airport data costs nothing upstream; fetching
     first meant a plan naming an aerodrome that does not exist still spent
     NAV CANADA's capacity before being rejected. Only fields that resolved
     are asked about, once each, under the identifier the resolver will look
     reports up by — so a plan naming the same field three times is one
     request, and a field with no ICAO identifier is not asked about at all.
173. Every HTTP attempt has a deadline now. Requests are serialised to keep
     the interval between them honest, which means one upstream that accepts
     a connection and then says nothing would have stopped every caller
     behind it. Fastify got a body limit and a request timeout for the same
     reason, and briefings are capped at twenty a minute per address with a
     `Retry-After` saying when to come back.
174. `tsx` was a development dependency and the image installs with
     `--omit=dev`, so the container would have built and then failed to
     start. Found by reading the Dockerfile against the manifest rather than
     by deploying and watching it crash.
175. **Reconsidered the static-site decision properly.** Checked whether
     either weather service sends the header a browser needs to call it
     directly: neither does. So fetching genuinely requires a server — but
     *judging* does not, and that distinction is the whole difference
     between a page that shows a result and a page that works.
176. So SHA-256 is written out in plain TypeScript. Content addressing is
     the spine of this project and the only thing tying it to Node was
     `createHash`. Checked against Node's implementation at every length
     from 0 to 200 bytes — where a wrong implementation of the padding shows
     up — and on multi-byte text. Every briefing hash in the suite came out
     unchanged, which is the real proof.
177. With that, `@holdshort/core/judge`: decode, resolve, judge, assemble,
     NOTAM ranking, weight and balance, the in-memory store, and nothing
     that reaches for a database, a file, a PDF or the network. 145 KB
     bundled. A test walks the import graph from it and fails if anything
     reachable imports a package or a Node built-in — nothing in the
     compiler enforces that, and the first sign of a mistake would be a
     blank page.
178. Two things had to move to make that boundary real. Storing and decoding
     a batch of reports went from the fetch layer to the store, where it
     belongs: it never touched the network. And NOTAM briefing now names
     what it needs — something that can fetch NOTAMs for a site — rather
     than importing the client class that does it over HTTP.
179. The build now writes the *inputs* beside the briefing: 112 reports
     verbatim, the aerodromes they concern, and the model's eight recorded
     answers. The page loads them into an in-memory store and runs the
     pipeline. The test that matters: rebuild from the bundle in an empty
     store and the briefing must come out with the same content hash as the
     one the build published. It does. A report's hash is recomputed as it
     loads, so a bundle altered in transit is refused rather than briefed
     on.
180. That test found a real defect. Whether a model answer came from the
     cache was recorded *in the briefing document*, so the same findings
     over the same reports hashed differently depending on whether the model
     had been asked before. Content addressing means a briefing is named by
     what it says; how an answer arrived is not part of what it says.
181. The form is live on the published site. Changing a minimum rebuilds the
     verdict in about the time it takes to let go of the key, and what moved
     is shown above it. Weight and balance computes in the page too.
182. **The web app has tests now, which it did not before**, and the first
     one it ran found that demo mode defaulted the departure to two hours
     from now — outside the recorded forecasts, so every point said "no
     forecast covers this" and nothing a visitor changed made any
     difference. Invisible until the page was driven the way a visitor
     drives it. It starts from the flight the reports cover now.
183. Pruned this log: the two decisions later overturned (148, 149) are
     marked where a reader meets them rather than deleted, and session 12's
     superseded "where this stopped" list is gone — the current state is at
     the top of this file and nowhere else.

### State at end of session 15

- 678 tests across three workspaces (657 core, 17 API, 4 web), typecheck
  clean, CI green.
- The published site runs the pipeline in the browser over frozen reports.
- The API is hardened and containerised; a live deployment needs only a
  host and the owner's accounts.

---

## Session 16 — 2026-09-14 — Winds aloft, daylight, and a site with pages

184. **Winds and temperatures aloft.** NAV CANADA serves them already
     reduced to numbers, so there is nothing coded to parse — but the
     numbers still carry the span of the record they came from, and the
     record is stored verbatim, so a pilot can see what the service said
     beside what this made of it.
185. The arithmetic pilots do by hand: interpolate between 3,000 and 6,000
     for a Cessna at 3,500, linearly for speed and temperature and the
     short way round for direction, because halfway between 350 and 010 is
     000. It refuses to extrapolate below the lowest level, where the wind
     is heading for the surface and the forecast says nothing about that,
     and it says which of the two it is doing. Two directions exactly
     opposite have no short way, so the turn is taken clockwise — arbitrary,
     but fixed, and stated.
186. Choosing the right forecast is most of the work. Six records cover a
     day per site: three bulletins, each issued for the low levels by
     Canada's office and the high ones by the American office. The one
     wanted is the one whose window covers the ETA *and* whose levels reach
     the altitude. Handing a Cessna the bulletin that starts at 24,000 ft
     would be worse than handing it nothing.
187. Getting them is not the same as getting them for the aerodromes. CYSN
     and CYKF publish no upper winds at all — asking returns an empty
     answer — and a flight between them needs Toronto's column, forty miles
     away. So they are fetched for the *route*: the major fields within
     reach, biggest first, all in one request, since the service answers for
     whichever of them it publishes. Runway length is the proxy for "major",
     because it is the one measure the airport data already carries and a
     wrong guess costs nothing but an empty answer.
188. Two findings come out of it: the wind at cruise, and the temperature —
     at or below freezing, cloud or precipitation at cruise stops being
     merely inconvenient. Both advisory: they decide fuel and route, not
     whether to go.
189. **Daylight**, which was roadmap item 4 and turned out to be an hour's
     work because the solar arithmetic was already here for the night
     minima. What was missing was the times, found by walking forward and
     bisecting each crossing: no algebra to get subtly wrong, and it handles
     the latitudes where the sun does not rise or set at all.
190. They are the *next* of each event rather than "today's", because a day
     is not the same thing in Zulu as it is where the aeroplane is. Last
     light at Waterloo on a September evening is 00:05Z — the next day by
     the clock this runs on, the same evening to the pilot. The demo now
     reads "1 h 34 min of daylight after arrival", which is the sort of
     thing a pilot actually wants to be told.
191. Checked against itself rather than somebody else's table: each instant
     is where the elevation crosses the boundary it claims, and the minute
     either side is on the right side of it.
192. That finding has no report behind it — it is the sun's position for a
     place and an instant — so it cites the place and the instant. Not an
     exemption from the rule that everything cites its source.
193. **A defect the daylight work turned up.** A briefing written before
     findings carried a basis kind has that kind recovered from the readable
     basis; a basis string with no case there falls through to "overlay",
     which changes the finding's identity and makes the diff report it as
     new when nothing happened. Both new bases have cases now, and the
     comment says the next one will need one too.
194. **The site has pages.** One long page was fine when there was one thing
     to read; there are four now. Routing is by hash rather than path,
     because the site is served two ways — GitHub Pages under a repository
     prefix, and the API's own static handler — and a hash needs neither of
     them configured. Deep links work from either, a reload does not 404,
     and the back button behaves.
195. The verdict rides along in the navigation once there is one, so a
     reader who has wandered off to the loading sheet can still see what the
     flight came out as and get back to it in one tap.
196. The reports got a page of their own rather than living only inside the
     findings that happened to cite them: every METAR, TAF, NOTAM and upper
     wind the page holds, filterable by kind and aerodrome, each opening to
     the bytes the service sent. A verdict is worth what the reports behind
     it are worth, and now they can be read.
197. Smaller things a person notices: the flight in one line above the form
     that spells it out; a skip link to the verdict; an honest "loading"
     instead of an empty page; and a print stylesheet, because the obvious
     place for a briefing is a kneeboard — it drops the form and the
     navigation and opens every collapsed section, since on paper there is
     nothing to tap.
198. The web tests navigate by setting the address, which is what a click
     does in a browser: jsdom does not follow hash links itself. What is
     checked is this application's half — the right target on each link, the
     right page for each address, and an address that names nothing landing
     on the briefing rather than nowhere.

### State at end of session 16

- 719 tests across three workspaces (695 core, 17 API, 7 web), typecheck
  clean, CI green.
- Four pages, live, briefing in the browser over frozen reports.
- Upper winds and daylight are in the pipeline and the API; the published
  demo shows daylight, and will show winds once its reports are re-recorded
  with an upper wind column in them.

---

## Session 17 — 2026-09-14 — The nav log, and what a fresh set of reports found

199. **The nav log**: true course and distance per leg, the wind triangle
     against the forecast at the point the leg ends at, wind correction
     angle, heading, groundspeed, time, running total, and fuel when a burn
     rate is given. The point is not that the wind triangle is hard — it is
     that doing it by hand at eleven at night, for six legs, is where the
     arithmetic mistakes live.
200. It refuses to fill a gap. No wind forecast for a leg means no
     groundspeed, no time and no fuel for that leg, with the reason printed
     under it, and the totals refuse to be a partial sum pretending to be a
     whole one. No magnetic variation in the airport data means the courses
     stay true and say so — OurAirports publishes none, so that is the
     normal case for a Canadian field here. No burn rate means no fuel
     column: the handbook prints burn against power setting and altitude,
     and nothing here will invent one.
201. North is 360, not 000, because that is what a heading bug says. Also:
     no negative zero, which reads as a mistake in a table of headings.
202. **Re-recorded the demo against live data**, since Ollama was running
     and could rank the new NOTAMs. The published page now shows all of it:
     winds aloft borrowed from Toronto forty miles away, a nav log with a
     real groundspeed, daylight margins, and thirty-two NOTAMs ranked by the
     local model. Verdict: go, on a clear September morning.
203. **That re-recording earned its keep immediately.** CYSN is a part-time
     station: its TAF had expired overnight, and the briefing answered "no
     forecast covers your departure" while a valid one sat thirty-six miles
     away at Hamilton. A pilot would use Hamilton's. Now so does this — a
     field's own forecast is preferred only when it actually covers the time
     asked about, and the borrowed one says whose it is and how far away.
     No amount of staring at the old fixtures would have shown that.
204. And a defect in the page's own code, found the same way: it diffed each
     new briefing against the last one it made without checking they were of
     the same flight. Change the destination and "what changed" has no
     answer; asking for one threw.
205. The nav log lives in the briefing document rather than beside it,
     because it is worked out from the same resolved flight and is part of
     what the briefing says. Which means the API serves it, the page shows
     it, and it is inside the content hash like everything else.

### State at end of session 17

- 727 tests across three workspaces (701 core, 17 API, 9 web), typecheck
  clean, CI green.
- Five pages, live, briefing in the browser over reports recorded at
  05:10Z on 14 September 2026.
- The demo's own weather, NOTAMs and upper winds are committed fixtures, so
  the build is reproducible without a network, a database or a model.

---

## Session 18 — 2026-09-14 — Hazards on the route, and a fetch that left no trace

206. **SIGMETs and AIRMETs**, from the two feeds the weather service
     publishes them on: the international one and the American domestic one,
     which are the same thing with their fields named differently. Both are
     read into one shape, because a hazard is a hazard.
207. The service has already reduced the bulletin's "WI N7800 E11445 - …"
     to coordinates, so the record is what is stored and the bulletin
     travels inside it, quoted verbatim in the decoded result. Re-parsing
     the text to arrive at numbers the service has published would be
     inventing a second opinion about the same thing.
208. Whether the route goes through an area is two plain geometric tests:
     is a point inside, and does any leg cross an edge. A route that starts
     and ends outside but passes straight through counts — the reason this
     is not simply a test of the waypoints. Treated as flat: over a few
     hundred miles, against areas drawn to the nearest degree, the error is
     far smaller than the polygon's own precision.
209. The two places flat is not good enough are refused rather than answered
     wrongly — an area that wraps the antimeridian, and one that reaches a
     pole — and then *reported*, because the advisory is in force at your
     altitude and only the geometry is beyond us. Saying nothing there would
     be hiding something; saying nothing about a SIGMET over Kansas is not.
210. Three questions decide whether a hazard is mentioned at all: in force
     while you are flying, reaching the altitude you are at, crossing the
     route. Crossing a live SIGMET is a no-go, because a SIGMET is a warning
     to everything in the air. An AIRMET is advice about conditions a light
     aircraft meets routinely, so it is marginal: look at this and decide.
211. Tested on the 123 advisories the service was actually carrying at
     05:20Z — thunderstorms, turbulence, icing, volcanic ash, mountain wave
     and a tropical cyclone — with routes built from the advisories' own
     corners, so "through it" and "nowhere near it" are facts about the
     published geometry rather than about a shape invented to pass a test.
     A test that the decoder knows every hazard code the service publishes
     would have failed on any it did not.
212. **A real defect, found by the second briefing in a row.** A fetch is
     recorded against the report it returned, so a request that came back
     empty left no trace and "have we asked recently" was false every time.
     Hazard advisories are usually "nothing in force"; a small aerodrome
     publishes no upper winds at all. Both would have been asked for again
     on every briefing, for ever, and always for nothing — exactly the
     discourtesy the freshness windows exist to prevent.
213. So the store records the asking as well as the receiving (migration
     0009), both implementations are held to it by the shared contract, and
     every fetch that can come back empty says it asked. `lastFetchAt` now
     means "when did we last ask", which is the question the freshness
     windows were always trying to answer.
214. `listRaw` takes an optional station, because a SIGMET belongs to an area
     rather than a place and there is no aerodrome to file it under.

### State at end of session 18

- 750 tests across three workspaces (723 core, 18 API, 9 web), typecheck
  clean.
- Nothing in force over Ontario this morning, so the demo shows no hazards
  — which is the correct answer and not an empty feature.

---

## Session 19 — 2026-09-15 — The tool stops deciding

215. **The go/no-go verdict is gone, and nothing replaced it.** The owner's
     reasoning, which is right: *"its peoples decision we are not deciding it
     for them. We are providing information."*
216. `Severity` — ok, advisory, marginal, no-go — became `Attention`:
     routine, note, caution, alert. The old words are the decision; the new
     ones are about reading. An alert is not "do not go", it is "you asked to
     be told about this, and here it is, with the report it came from".
217. Where a summary is genuinely needed it is the flight category, which
     `flightCategoryOf` already computed for forecast verification and which
     every weather service publishes. Each point carries what was observed
     and, separately, what the prevailing forecast says at the ETA — "VFR
     now, IFR when you get there" is two facts, and collapsing them loses the
     one that matters. `worst()` and `verdictOf()` are deleted. Nothing
     aggregates. The diff compares categories and findings.
218. Twenty-five files, and the tests with them. The navigation now carries
     a count — "3 to look at" — rather than a badge that says GO.
219. **And the engine now reads what it decodes**, which was the audit's
     first finding and the reason the rest mattered less. `checkConditions`
     ran four checks; present weather and total wind reached `Conditions` and
     were never looked at. Now:
     - `+TSRA FZRA` produces two alerts, "a thunderstorm with heavy rain" and
       "freezing rain", each quoting its own group. A group inside a TEMPO
       drops one step, because the product is less certain.
     - `BKN///` and `VV///` are an alert saying there is a ceiling and its
       height was not measured, so it cannot be compared with a minimum —
       where before they read as a clear sky.
     - The surface wind is reported and set against a total wind limit when
       the pilot has set one, and otherwise against what their crosswind
       limit implies: at 60 kt, any runway more than 14° off the wind is
       outside a 15 kt limit. That is arithmetic on their number, not an
       opinion of ours.
220. Weight and balance still says WITHIN LIMITS or OUTSIDE LIMITS, because
     that is a fact about a published envelope — but it stopped borrowing the
     flight's vocabulary to say it.
221. **The page carries the country now.** The four aerodromes were never a
     data limit: every Canadian station reporting at one instant is 235
     METARs and 118 forecasts, smaller than the NOTAM half of what was
     already shipped. With 1,504 aerodromes in the bundle a visitor can brief
     almost any Canadian pair, borrowing the nearest forecast within 60 nm.
222. Recording it taught two things. A bounding-box request returns whoever
     was reporting at that moment, which leaves out the part-time fields
     between observations — including CYSN; asked for by name, with history,
     they come back. And the first attempt mixed two days, because the clock
     crossed midnight Zulu between requests: a snapshot of no particular
     moment. Re-recorded whole.
223. The upstream metadata record is left out of the published bundle. It
     decides nothing, the page never shows it, and a report is named by the
     hash of its body — so omitting it changes no identity, only what a
     visitor downloads: 293 KB gzipped down to 222 KB.

### State at end of session 19

- 750 tests across three workspaces, typecheck clean.
- Nothing anywhere tells a pilot whether to fly.

---

## Session 20 — 2026-09-18/19 — The field's page, and what the handbook will not let us compute

224. **The nearest reporting station**, which the owner asked for by name.
     CYSN stops overnight; KIAG reports every hour, eleven miles across the
     river. The field's own observation is used while it is current, and
     otherwise the nearest one that is — labelled with whose it is, how far
     away, and how old. Every line derived from a borrowed reading carries
     that in its own basis so it cannot read as the field's own. When
     nothing current is in reach the stale local reading stands, because
     "this is what it said four hours ago" is information and a blank is not.
225. The snapshot had to grow to make that true: it was Canada-only, so
     CYSN would have borrowed CYTZ at 28 nm rather than KIAG at 11. It now
     carries both sides of the border — 171 American reporting stations,
     1,667 aerodromes — because you can only borrow from a field that
     reports and a border is not a weather boundary.
226. **Report age in colour.** Two things a report cannot tell you about
     itself are now said every time: how old it is and whose it is. The
     bands come from how a METAR is issued — within the hour it is the
     current one, within two recent, past six barely about today.
227. **A page for every field**, at `#/aerodrome/CYSN`, needing no flight
     plan: a pilot looking a place up has usually not planned one yet. It is
     assembled by `aerodromeReport` from exactly the functions the flight
     path uses, so a field's page and a briefing of that field cannot
     disagree.
228. Routing became a value rather than a string. The old parser took the
     first segment and fell back to the briefing, so `#/aerodrome/CYSN`
     silently resolved to the brief — a bad deep link that looks like it
     worked is the one routing behaviour that actively misleads. Three
     failures are told apart now and none of them redirects.
229. A start page, because the root was a form. Most arrivals want to look
     up a field or find out what this is.

### What an audit of the handbook found, and why performance is not built yet

A pair of agents specified the takeoff and landing feature and then read the
actual OCR of the owner's POH to check it. Three findings, all specific, all
fatal to the obvious design:

230. **The extraction pipeline cannot verify a performance cell.** It was
     built for labelled scalars: `checkLabel` confirms the quoted line
     contains a keyword from each group, and `alignNumbers` only checks the
     cited text *contains* the number. A performance row is positional. The
     real OCR of the 2300 lb sea-level row reads
     `2300 52 | 59 { suf 778 1380 835 1475 895 { 1575 o60 | 1885 1030] 1798`
     — ten numbers on one line, and any proposed value among them verifies
     whichever column it actually belongs to. Worse, the OCR normaliser maps
     `o`→0 and `B`→8 beside digits, so `o60` verifies as 60 and `B70` as 870:
     verification proves a number is on the page *as Tesseract read it*, not
     as Cessna printed it. This needs positional verification — the cell's
     own word box, checked against its row and column headers — which does
     not exist yet.
231. **Interpolation must not happen at all.** Figure 5-4 is printed in
     1,000 ft rows and 10 °C columns, and the top-right cells are *deleted
     in the handbook itself*: the 7,000 and 8,000 ft rows OCR to noise
     because there is nothing printed there. Note 4 says why — where a value
     is deleted, climb performance after lift-off is below the stated rate.
     Interpolating across those blanks would manufacture a takeoff distance
     for a condition in which Cessna declined to publish one, which is the
     single worst thing this feature could do.
232. **The correction factors cannot be read from the page.** Page 72's note
     says "decrease distances 10% for each 2 knots headwind"; page 81's says
     "for each 8 knots". At least one is a misread, and applying the first
     to an 18 kt headwind computes minus ninety per cent of the takeoff roll.
     Until an owner confirms each note against a rendered crop, the note is
     printed verbatim beside the figure and nothing is applied.
233. And one that changes the shape of the answer: **no "fits" badge**.
     Runway adequacy depends on technique, surface condition, obstacles and
     the pilot's own currency, none of which this tool holds. Weight and
     balance may say WITHIN LIMITS because a CG inside an envelope is pure
     geometry; a runway badge would be the go/no-go verdict returning
     through a side door, in the exact place it was removed from. Print the
     POH figure and the runway length side by side and stop.
234. A fourth, which is a better design than the one proposed: the decoder
     already reads the Canadian `DENSITY ALT nnnnFT` remark, and CYSN prints
     it in its own observations. When a field's own METAR is current, take
     the density altitude the field itself measured and compute nothing.
     When the observation is borrowed, omit the figure with the reason
     stated — a distance computed from KIAG's temperature is a number about
     KIAG printed under CYSN's runway.

**So the performance feature, when it is built, is: show the chart row as
printed, cited to a crop of the page; use the field's own measured density
altitude or none; print the notes verbatim and apply nothing; put the runway
length beside it and draw no conclusion.** Smaller than intended, and the
only version that is honest.

### State at end of session 20

- 760 tests across three workspaces, typecheck clean.
- Eight routes; a field is a page; the root is a way in rather than a form.

---

## Session 21 — 2026-09-19 — Making it survive a host

The owner asked for the API live and a domain. Most of this session is the
first, because the second needs an account only he can open. What the work
actually was: every place the code assumed it was running on a laptop.

### The four that would have shipped broken

235. **Nothing loaded the airports table.** The only way in was to download
     two CSVs by hand and run `holdshort ourairports <dir>`, which is fine
     at a keyboard and impossible on a host — a deployed instance starts
     with an empty database and no shell, and an empty airports table is not
     slow, it is broken: a briefing needs a field's position before it can
     ask anything about it, so every request would have failed at its first
     waypoint. `ensureAirportData` now fetches the OurAirports snapshot on
     first boot, 27,560 aerodromes across Canada and the United States,
     once per database. It runs *after* the port opens: done before, a
     first boot is a minute in which the host sees no port and concludes the
     deploy failed. `/api/health` answers 503 with `airportData: loading`
     until it finishes, and a briefing asked for meanwhile is told that
     rather than told its aerodrome does not exist — the same exception,
     completely different problems, and told the first a pilot checks their
     spelling of a field that is spelled correctly.
236. **The pool had no `error` listener.** Any hosted database drops a
     connection that has been idle, `pg` reports it on the pool with nothing
     awaiting it, and an unhandled `error` event is a process-level throw.
     The first idle drop would have taken the server down.
237. **Loading airports was one round trip per row.** 27,000 of them: a few
     seconds over a local socket, several minutes against a database in
     another region. Batched 500 to a statement, still one transaction.
238. **Behind a proxy every visitor is the proxy.** So one visitor exhausts
     everyone's share. The obvious fix — believe `X-Forwarded-For` — means
     believing a header the caller wrote, so anybody wanting more turns just
     claims to be somebody else. Fastify's numeric hop count is not an
     answer either: in this version it fails closed and trusts nothing, so
     an instance configured that way looks configured and behaves as though
     it were not. What is there instead is two caps. Per caller, 20 a
     minute, a courtesy between visitors, evadable. Per instance, 120 a
     minute, keyed on a constant so nothing in the request can change it —
     the promise the server can actually keep to the weather services.

### The one the snapshot was hiding

239. **A sleeping field had nothing to borrow.** `observationAt` stands the
     nearest current observation in for a field that is not reporting, which
     works on the page because the recorded snapshot holds every station. A
     live instance fetches only the stations the flight plan names — so
     asked about CYSN at night it fetched CYSN, found nothing current,
     looked for a neighbour and found nothing at all. The feature the owner
     asked for by name, silently absent on exactly the deployment it was
     written for. Found by running it: the first live briefing borrowed CYKF
     at 55 nm, because CYKF was the destination and therefore the only other
     station in the store.

     The fix had to answer "which fields near here report?", and nothing in
     the airport data answers it. Within 60 nm of CYSN the nine nearest
     fields with an ICAO identifier are hospital helipads and private
     strips; KIAG is tenth. Runway length is no better — CYSN has 5,000 ft of
     asphalt and closes at dusk, and a marine station on a pier with no
     runway at all reports every hour. So it is not guessed: the AWC's METAR
     endpoint takes a bounding box, and one request returns whichever
     stations near there are reporting, which is the service answering the
     question rather than this code inferring it. Asked only when a field
     has nothing current of its own, once an hour per one-degree cell,
     however many briefings pass through it.

### The one only a real database shows

240. **JSON has no date.** Decoded records are stored as JSON, so a `Date`
     goes in and an ISO string comes back — and every type still calls it a
     `Date`, because the read site casts. In memory the cast is harmless,
     the object never left the process, and all 760 tests passed. Against
     Postgres the *second* briefing died: the first decoded its upper winds
     in process and worked, the second read them back and threw
     `useFrom?.value.getTime is not a function`, a 500 for the whole
     request. Upper winds and hazard advisories are the only two decoders
     that put a `Date` inside their output — METAR and TAF store the
     day-and-hour groups as written and resolve them against a reference —
     and both are revived at the read site now. The regression test round
     trips through `JSON.parse(JSON.stringify(...))`, which is exactly what
     a JSONB column does, and it fails without the fix.
241. And a smaller one of the same family: the Postgres contract test's
     `truncate` list predates migration 0009 and omitted `fetch_attempts`,
     so the suite passed on a fresh database and failed the second time it
     was run against the same one. CI gets a clean container every time,
     which is why nobody noticed.

### Proved rather than asserted

242. A container built from this repository, pointed at an empty Postgres:
     migrates, downloads the snapshot, loads 27,560 aerodromes, serves the
     web app, health goes green, and a briefing of CYSN → CYKF comes back
     saying **"CYSN is not reporting at this hour; the conditions above are
     KIAG's, 11 nm away."** That is the owner's own example, live, from real
     data, through the image the host will run.
243. CI builds that image on every push and starts it against a real
     database, so a Dockerfile that would fail on deploy fails on push.

### The domain

244. Checked against the registries rather than a search box. `holdshort.com`,
     `.org`, `.net`, `.dev` and `.app` are all taken. Two things worth acting
     on, both verified directly at RDAP on 19 September:
     - **`holdshort.ca` is in `pending delete`** — expired 2026-08-04, out of
       redemption 2026-09-15, now on CIRA's To Be Released list. CIRA
       releases those Wednesdays at 19:00 UTC; the expected session is
       **Wednesday 23 September**. Webnames.ca takes TBR backorders free and
       charges only if the catch succeeds. A free lottery ticket, not a plan
       — CIRA picks at random between registrars requesting the same name.
     - **`holdshort.page` is available**, $10.20 a year at Cloudflare
       Registrar, first year and every year. Cloudflare sells at wholesale
       with no promotional first year, which matters: `holdshort.xyz` is
       $1.00 to register at Namecheap and $19.48 to renew.
245. `docs/deploy.md` carries the whole thing: the two accounts to create,
     what each free tier actually costs (Render sleeps after fifteen minutes
     and takes fifty seconds to wake; Render's free Postgres is *deleted*
     after thirty days, which is why the blueprint does not create one), the
     exact DNS records, and the three things in this repository that must
     change when a domain is attached — the most important being
     `pages.yml`'s `VITE_BASE`, which is `/holdshort/` for a project site
     and would 404 every asset on a custom domain.

### State at end of session 21

- 808 tests across three workspaces, all passing against real Postgres.
- A container that boots from nothing into a working instance.
- Everything remaining on the API is an account only the owner can open.

