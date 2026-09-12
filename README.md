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
| M6 | NOTAM relevance pipeline | **done** — decoder, filter, dedupe, ranking with citation checks; needs a local model |
| M7 | Evaluation harness | **done** — labelled set + scorer; gate skips until the model is recorded |

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
npm run holdshort -- decode "METAR KJFK 071151Z 34007KT 10SM CLR 19/11 A3015"

# NOTAM relevance ranking is the only part that uses a model, and it is optional.
# Install Ollama, then:
ollama pull qwen2.5:7b
HOLDSHORT_LLM=ollama npm run eval:notam -- --record   # rank, record fixtures, score against the labelled set

npm run build -w apps/web && npm start   # the web app and API on http://127.0.0.1:3000
npm run dev:api & npm run dev:web        # development: Vite on :5173 proxying /api to :3000
```

The repo is an npm workspace: `packages/core` (the pipeline; no runtime
dependency but `pg`), `apps/api` (Fastify), `apps/web` (Vite + React).

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
