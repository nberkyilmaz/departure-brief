# Hold Short

> ## ⚠ Not for operational use
>
> **This is a study and planning aid. It is not an official weather briefing and
> must not be used as the basis for a real go/no-go decision.** Always obtain an
> official briefing from an approved source. Nothing here is certified,
> authoritative, or a substitute for pilot judgment and the regulations.

Stop before the line and brief before you cross it.

Hold Short answers one question about a planned flight: **given this route, at
this time, in this aircraft — should I go, and why?** It decodes the raw
products a pilot already reads, resolves them to each point along the route at
the time you'll actually be there, and evaluates the result against your own
personal minimums, showing the source behind every finding.

## Why this exists

Existing tools are excellent at fetching and displaying. Ask any of them
"should I go?" and they hand you raw data and wish you luck. Aggregation is
commodity; the reasoning layer is the gap.

## Status

Early. Building in this order:

| | Milestone | State |
| --- | --- | --- |
| M0 | Schema and skeleton | done |
| M1 | Fetch layer — aviationweather.gov, FAA | **done** — NOTAM client awaits API credentials |
| M2 | METAR / TAF decoders | **done** — 8,000 real reports in the corpus, <0.3 % unparsed |
| M3 | Route and time resolution | **done** — ETA per waypoint, TAF period selection with overlays |
| M4 | Rules engine — personal minimums, CARs 602.114/115, FAR 91.155 | **done** — airport-only; every finding cited |
| M5 | Briefing assembly and UI | **done** — API + web app; briefings immutable and content-addressed |
| M6 | NOTAM relevance pipeline | **done** — decoder, filter, dedupe, deterministic rules where there is one right answer, model for the rest |
| M7 | Evaluation harness | **done** — 85.7 % agreement with a reviewed labelled set on a local 7B model; runway closures never missed |
| M9 | Forecast verification | **done** — pairs what the TAF promised with what arrived; scores which way it was wrong |
| M8 | Briefing diff | **done** — diffs the verdict, not the text; a value that moves without crossing a limit is not news |
| M6b | Aircraft documents — POH weight and balance | **done** — OCR of a 148-page scan, extraction checked against the page, review queue; every limit cited to the ink it came from |

Airspace transit analysis, nav logs and forecast verification come after the
above works end to end.

## Documentation

- **[`docs/onboarding.md`](docs/onboarding.md)** — start here. Current state,
  build order, conventions, environment, how work is done.
- **[`docs/spec.md`](docs/spec.md)** — the full build plan: hard parts in depth,
  hour estimates, data sources.
- **[`docs/plan.md`](docs/plan.md)** — the build sequence: decisions taken,
  what each step builds, and what "done" means for it.
- **[`docs/worklog.md`](docs/worklog.md)** — chronological log of everything
  done so far, wrong turns included. Append an entry every session.

## Design rules

These are load-bearing, not preferences:

1. **No model anywhere near the decoders.** METAR has exactly one correct
   parse. Non-determinism there is a defect.
2. **Nothing is ever hidden.** Relevance ranking controls ordering and collapse
   state only. A model error must degrade to noise, never to a missing item.
3. **Every finding cites its source.** A verdict without the raw report beside
   it is worse than no verdict.
4. **Zulu internally, always.** Local time exists only at the display edge.
5. **Raw reports are stored verbatim**, content-addressed, append-only. You can
   always reconstruct exactly what was known at any moment.

## Development

Requires **Node 20+** and Docker.

```bash
npm install
cp .env.example .env # then put a contact address in HOLDSHORT_USER_AGENT
npm run db:up        # Postgres + PostGIS on localhost:5433 (Docker Desktop must be running)
npm test             # passes without Docker; includes the Postgres tests when it is up
npm run typecheck
npm run corpus:metar # what the METAR decoder does not yet understand, by frequency
npm run corpus:taf   # same for TAF; add --us to restrict to US stations

npm run holdshort -- fetch KJFK KTEB      # store + decode the current METAR/TAF
npm run holdshort -- nasr <dir>           # load a NASR cycle's APT CSV files — US airports (see src/fetch/nasr.ts)
npm run holdshort -- ourairports <dir> --country CA   # OurAirports snapshot — everywhere else (see src/fetch/ourairports.ts)
npm run holdshort -- airport CYSN         # runways with true headings (and magnetic variation where the source has it)
npm run holdshort -- resolve flights/demo-cysn-cykf.json --fetch   # conditions at each waypoint at its ETA, cited
npm run holdshort -- brief flights/demo-cysn-cykf.json --fetch     # go / marginal / no-go per waypoint against profiles/default.json
npm run holdshort -- notams flights/demo-cysn-cykf.json --fetch    # every NOTAM for the flight, classified and (with a model) ranked
npm run holdshort -- diff flights/demo-cysn-cykf.json --fetch      # brief again and say what changed since last time
npm run holdshort -- verify --fetch                                # did the forecasts your briefings relied on turn out to be right?
npm run holdshort -- doc ingest C172MPOH.pdf                       # OCR a scanned POH into word boxes (cached by content hash)
npm run holdshort -- doc find C172MPOH.pdf "demonstrated crosswind" # search the OCR text, with page numbers
npm run holdshort -- wb confirm aircraft/c172.wb.json cgAftNormalIn=47.3   # confirm a figure the extraction could not; the handbook still has to agree
npm run holdshort -- wb aircraft/c172.wb.json --empty 1454 --empty-moment 57.6 --front 340 --fuel 38   # a loading, every limit cited to its POH page
npm run holdshort -- decode "METAR KJFK 071151Z 34007KT 10SM CLR 19/11 A3015"

# Two things use a model, both optional and both local: NOTAM relevance
# ranking, and reading figures out of a scanned POH. Install Ollama, then:
ollama pull qwen2.5:7b                                # text: NOTAM relevance
ollama pull qwen2.5vl:3b                              # vision: POH extraction (sees the page image)
HOLDSHORT_LLM=ollama npm run eval:notam -- --record   # rank, record fixtures, score against the labelled set
HOLDSHORT_LLM=ollama OLLAMA_MODEL=qwen2.5vl:3b npm run holdshort -- doc wb C172MPOH.pdf --pages 88,90 --type C172

npm run build -w apps/web && npm start   # the web app and API on http://127.0.0.1:3000
npm run dev:api & npm run dev:web        # development: Vite on :5173 proxying /api to :3000
```

The repo is an npm workspace: `packages/core` (the pipeline; runtime
dependencies are `pg` and, for reading scanned documents, `pdfjs-dist`,
`@napi-rs/canvas` and `tesseract.js` — all prebuilt, no native compile),
`apps/api` (Fastify), `apps/web` (Vite + React). The decoders still depend
on nothing.

## How much of this uses a model, and how well

Two things do, both optional and both local. Everything else — the
decoders, the rules engine, the weight-and-balance arithmetic — is
deterministic, and the numbers below are measured by tests in the repo, not
estimated.

**NOTAM relevance** (`npm run eval:notam`), qwen2.5:7b against a labelled
set of 31 real NOTAMs for the demo flight, itself panel-labelled and then
adversarially reviewed:

| | |
| --- | --- |
| agreement | 85.7 % of the 28 the model was asked about |
| critical recall | 100 % — no NOTAM that matters was missed |
| irrelevant precision / recall | 100 % / 100 % |
| citations that could not be verified | 0 |

The three the model was never asked about were ruled out of scope by
schedule; a further nine were settled by deterministic rules from the Q
code, because a closed runway at your departure aerodrome should not depend
on a 7B model. The four remaining disagreements are all *advisory* items
called *critical* — over-warning, which is the safe direction.

**POH extraction** (`npm test`, `test/docs/extract.test.ts`), qwen2.5vl:3b
reading a 1976 handbook scanned on an office copier:

| | |
| --- | --- |
| figures proposed | 28 |
| verified against the page and used | 6 |
| of those, correct | 6 of 6 |
| sent to the review queue | 22 |

Precision is a hard gate: a figure the pipeline accepts must be the figure
the page prints, because it goes straight into a weight-and-balance sum.
Recall is reported and deliberately not gated — a figure the model misses
waits for you in the review queue, which is safe in a way an invented one
is not. The checks caught the model quoting a line from a different page,
and reading the utility-category weight limit as the normal-category one.

What the model misses, you confirm — and the handbook still has to agree.
`holdshort wb confirm` takes a figure you have read off the page and looks
for it in the scan, recording which of three things it could establish:

| | |
| --- | --- |
| the handbook states it beside words naming the field | the figure is cited to that line |
| the handbook prints it on a page you name, with no label on its row | recorded as printed there, marked unlabelled |
| the scan cannot read it at all (this handbook's diagrams OCR to noise) | `--on-my-word`: recorded as your figure, with no citation |

Nothing is ever silently upgraded between those, and the note on every
figure in `aircraft/*.wb.json` says which one it is.

## Data sources

All public domain or free, with no redistribution restrictions:

- [aviationweather.gov](https://aviationweather.gov/) (NOAA/AWC) — METAR, TAF, PIREP, AIRMET/SIGMET
- NAV CANADA CFPS — Canadian NOTAMs (the JSON endpoint behind plan.navcanada.ca; unofficial, so the client fails loudly if its shape changes)
- FAA NOTAM API — US NOTAMs by location and time (awaiting credentials; the client is written but unverified)
- FAA NASR — US airports, runways, magnetic variation
- OurAirports — airports and runways outside the US (public domain)
- USGS — terrain elevation

Fetched data is cached locally and not committed. Requests send a real
`User-Agent`, as the SEC- and FAA-style APIs require.
