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
| M0 | Schema and skeleton | in progress |
| M1 | Fetch layer — aviationweather.gov, FAA | |
| M2 | METAR / TAF decoders | |
| M3 | Route and time resolution | |
| M4 | Rules engine — personal minimums, FAR 91.155 | |
| M5 | Briefing assembly and UI | |
| M6 | NOTAM relevance pipeline | |
| M7 | Evaluation harness | |

Airspace transit analysis, nav logs and forecast verification come after the
above works end to end.

## Documentation

- **[`docs/onboarding.md`](docs/onboarding.md)** — start here. Current state,
  build order, conventions, environment, how work is done.
- **[`docs/spec.md`](docs/spec.md)** — the full build plan: hard parts in depth,
  hour estimates, data sources.

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
npm run db:up        # Postgres + PostGIS on localhost:5433
npm test
npm run typecheck
```

## Data sources

All public domain or free, with no redistribution restrictions:

- [aviationweather.gov](https://aviationweather.gov/) (NOAA/AWC) — METAR, TAF, PIREP, AIRMET/SIGMET
- FAA NOTAM API — NOTAMs by location and time
- FAA NASR — airports, runways, magnetic variation
- USGS — terrain elevation

Fetched data is cached locally and not committed. Requests send a real
`User-Agent`, as the SEC- and FAA-style APIs require.
