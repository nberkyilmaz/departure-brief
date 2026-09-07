# Onboarding

Read this first, then `docs/spec.md` for the full build plan. Between them you
should have everything needed to pick up work without further context.

---

## 1. What this is

Hold Short is a **flight briefing decision-support tool**. It answers one
question about a planned flight: *given this route, at this time, in this
aircraft — should I go, and why?*

It decodes the raw products a pilot already reads (METAR, TAF, PIREP, NOTAM),
resolves them to each point along the route **at the time the aircraft will
actually be there**, and evaluates the result against the pilot's own personal
minimums — showing the source behind every finding.

### The thesis

Existing tools (ForeFlight, Garmin Pilot, 1800wxbrief) are excellent at
fetching and displaying. Ask any of them "should I go?" and they hand you raw
data and wish you luck.

**Aggregation is commodity. The reasoning layer is the gap.** Everything in this
codebase should be judged against whether it improves the reasoning layer. We do
not compete on charts, moving map, or data coverage.

### Four things that don't exist elsewhere

1. **NOTAM relevance ranking** against *this specific flight* — aircraft,
   altitude, equipment, time window. Existing tools filter by category or
   distance only.
2. **Personal minimums as a real rules engine.** Every pilot has them; nothing
   encodes them and evaluates a route against them leg by leg.
3. **Briefing diff.** You brief at 1400 for a 1900 departure. What changed?
   Nothing on the market answers this.
4. **Forecast verification.** Did the TAF verify against the actual METAR at
   your ETA? Accumulate it and you learn which fields forecast badly.

---

## 2. Safety framing — non-negotiable

**This is a study and planning aid. It is not an official briefing and must
never be presented as one.**

This is a hard constraint on the product, not a disclaimer to bury:

- The warning stays at the top of the README and visible in the UI.
- Never imply certification, authority, or that it replaces an official
  briefing.
- **Never show a verdict without its raw source beside it.**
- Never let any component silently drop information (see design rule 2).

If a change would make the tool feel more authoritative than it is, that change
is wrong regardless of how good it looks.

---

## 3. Current state

The repo is scaffolded and nothing is implemented yet. Exactly this exists:

| Path | What |
| --- | --- |
| `package.json` | Node ≥20, TypeScript, Vitest. **No runtime dependencies yet** — the decoders need none. |
| `tsconfig.json` | Strict, plus `noUncheckedIndexedAccess` and `exactOptionalPropertyTypes` |
| `docker-compose.yml` | `postgis/postgis:16-3.4` on **port 5433** (avoids colliding with an existing 5432) |
| `README.md` | Safety framing, status, design rules |
| `docs/spec.md` | Full build plan — milestones, hours, hard parts, interview material |
| `src/` | Empty directories: `decode/metar`, `decode/taf`, `fetch`, `domain` |
| `test/fixtures/` | Empty |

`npm install` has not been run yet.

---

## 4. Build order

Strictly sequential. Each milestone should leave the system working end to end.

| | Milestone | Hours | State |
| --- | --- | --- | --- |
| M0 | Schema and skeleton | 8–12 | scaffold done, schema pending |
| **M2** | **METAR / TAF decoders** | **20–28** | **next** |
| M1 | Fetch layer — AWC, FAA NOTAM, NASR | 12–16 | |
| M3 | Route and time resolution | 20–28 | |
| M4 | Rules engine — personal minimums, FAR 91.155 | 20–28 | |
| M5 | Briefing assembly and UI | 25–35 | |
| M6 | NOTAM relevance pipeline | 20–28 | |
| M6b | Aircraft document ingestion | 25–35 | |
| M7 | Evaluation harness | 12–16 | |
| M4b | Airspace transit analysis (PostGIS) | 25–35 | |
| M8 | Briefing diff | 10–14 | |
| M9 | Forecast verification | 12–16 | |
| M10 | Polish, README, demo | 8–12 | |

**Decoders come before the fetch layer deliberately.** Decoding is pure,
testable, and needs no network. Building it first means the fetch layer has
something to hand its output to, and the test corpus can be pasted-in real
reports rather than live calls.

**The deterministic pipeline must produce a useful briefing before any LLM
enters it.** M6 comes after M5 for that reason.

---

## 5. The immediate next task — M2, decoders

Write a real parser for METAR, then TAF. **Not regex soup.** A tokenizer plus a
state machine over group types — the same shape as a log-format parser.

Groups that must be handled:

```
KJFK 141851Z 28016G24KT 10SM FEW045 SCT250 09/M04 A3012 RMK AO2 SLP198
     ^time   ^wind      ^vis ^clouds      ^temp  ^alt  ^remarks
```

- Wind: `28016G24KT`, `VRB03KT`, `00000KT`, `280V350` variable range, `KT`/`MPS`
- Visibility: `10SM`, `1/2SM`, `M1/4SM`, `CAVOK`, metric forms
- Weather: intensity `-`/`+`/`VC`, descriptors, phenomena, multiple groups
- Clouds: `FEW045 SCT100 BKN250 OVC008`, `CLR`, `SKC`, `VV003`, `CB`/`TCU`
- Temp/dewpoint: `09/M04` — `M` prefix is negative
- Altimeter: `A3012` (inHg), `Q1013` (hPa)
- `AUTO`, `COR`, `NOSIG`, `RMK` section
- TAF adds: validity period, `FM`, `BECMG`, `TEMPO`, `PROB30`/`PROB40`

### Requirements

1. **Every decoded field keeps a source span** — the substring offsets it came
   from. This is the grounding used everywhere downstream; retrofitting it is
   painful.
2. **Deterministic and total.** Unknown groups are preserved as `unparsed`
   rather than dropped or guessed at.
3. **A test corpus of real reports** asserted against hand-decoded
   expectations. Aim for a few hundred, covering the long tail.
4. **No model involvement.** METAR has exactly one correct parse.

---

## 6. Design rules

These are load-bearing. Breaking one is a bug, not a style choice.

1. **No LLM anywhere near the decoders.** METAR has exactly one correct parse.
   Non-determinism there is a defect.
2. **Nothing is ever hidden.** Relevance ranking controls ordering and collapse
   state only. A model error must degrade to noise, never to a missing item.
3. **Every finding cites its source.** A verdict without the raw report beside
   it is worse than no verdict.
4. **Zulu internally, always.** Local time exists only at the display edge.
   Local time in the domain model is how you get a bug that ruins someone's
   flight planning.
5. **Raw reports are stored verbatim**, content-addressed by SHA-256 of their
   bytes, append-only. Briefings are immutable versions, never updated in place.
   This is what makes the diff feature nearly free and lets you reconstruct
   exactly what was known at any moment.

---

## 7. Domain conventions

- **Times** — Zulu everywhere internally, ISO 8601 with explicit `Z`.
- **Altitudes** — always label MSL or AGL. Class G thresholds and Class E floors
  are AGL; cruise altitudes are MSL. Mixing them is a correctness bug.
- **Winds** — METAR winds are **true**; ATIS and tower winds are **magnetic**.
  Runway headings from NASR come in both. Make them consistent before computing
  a crosswind component.
- **Distances** — statute miles for visibility, nautical miles for navigation.
  They are different units and both appear. Type them distinctly.
- **`TEMPO` is not prevailing.** It qualifies the base group rather than
  replacing it. Conservative handling: a `TEMPO` below minimums makes a leg
  *marginal*, not *go*.
- **Aircraft limits vs personal limits** are different numbers. Demonstrated
  crosswind is a POH figure; personal crosswind is the pilot's own, usually
  lower.

---

## 8. Architecture

```
   Flight plan (route, time, aircraft, minimums profile)
                        │
                        ▼
        Fetch layer — one interface per source, cached, rate-limited
             │           │            │
      METAR/TAF      NOTAM      NASR + airspace
             │           │            │
             ▼           ▼            ▼
   Deterministic     NOTAM pipeline        Aircraft documents
   decoders          parse → dedupe →      OCR boxes → LLM extract
   (no LLM)          LLM relevance rank    → citation alignment
             │           │                        │
             ▼           │                        │
   Route + time resolver │                        │
   ETA per waypoint      │                        │
   TAF period selection  │                        │
             │           │                        │
             ▼           ▼                        ▼
   ┌─────────────────────────────────────────────────┐
   │  Rules engine (deterministic, heavily tested)   │
   │  personal minimums · FAR 91.155 · crosswind     │
   │  airworthiness · currency                       │
   └─────────────────────────────────────────────────┘
                        │
                        ▼
              Briefing (immutable, content-addressed)
                        ├──► go / marginal / no-go, every finding cited
                        └──► diff vs. previous briefing

   Postgres + PostGIS — raw reports, decoded reports, airspace geometry,
                        briefings (append-only)
```

---

## 9. Environment

Verified on the development machine:

| | |
| --- | --- |
| Node | v22.23.2 |
| npm | 10.9.8 |
| Docker | 27.0.3 |
| Postgres | via Compose, **port 5433**, user/pass/db all `holdshort` |
| No local `psql` | use `docker compose exec db psql -U holdshort` |

**Two machines are available:**

- **Laptop** — RTX 3060, 6 GB VRAM. Primary development. Runs a 7B model
  comfortably; this is where ~95% of work happens.
- **Desktop** — RX 6750 XT, 12 GB VRAM. Benchmark box for 14B and vision-model
  comparison runs. AMD, so Ollama needs ROCm with
  `HSA_OVERRIDE_GFX_VERSION=10.3.0`, or LM Studio's Vulkan backend as fallback.

The desktop is **not a dependency** for development.

---

## 10. LLM policy

Two LLM workloads exist, both behind a single `LLMProvider` interface:

1. **NOTAM relevance ranking** (M6) — short text in, small JSON out. Ideal local
   workload. Runs at $0.
2. **Aircraft document extraction** (M6b) — vision plus layout. Weaker locally;
   benchmark against a hosted model and route accordingly.

### Three implementations

- **`FixtureProvider`** — replays recorded responses from disk, keyed by content
  hash. **Build this first.** It makes tests and CI run with no GPU and no API
  key, and it's what makes laptop-first development comfortable.
- **`OllamaProvider`** — local, default for development. Start with Qwen 2.5 7B;
  it adheres to JSON schemas better than same-size alternatives.
- **Hosted provider** — for benchmarking and the vision path.

**Do not point one OpenAI-compatible client at both.** Use each provider's own
SDK behind the interface; shims drift and lose structured-output behaviour.

### Cost rules

1. **Cache on content hash** — key on `(content_hash, prompt_version, model_id)`.
   Re-running with an unchanged prompt costs nothing.
2. **Never call a model in the request path.** Assessment happens at fetch time;
   the UI reads rows. Refreshing a page must cost nothing, forever.
3. **Filter deterministically before spending a token.** A NOTAM outside the
   flight's time window is dropped before the model ever sees it.
4. **Cap spend twice** — provider-side limit, plus a token budget counter in
   code that refuses to exceed a daily ceiling.

---

## 11. Testing

- **Decoders** — exhaustive table-driven tests against hand-decoded real
  reports. This is the highest-value test surface in the project.
- **Rules engine** — the FAR 91.155 minima table is finite and exhaustive.
  One test per row, no exceptions.
- **LLM components** — hand-labelled corpus scored in CI. Relevance ranking is
  scored on agreement; extraction on per-field precision and recall. A change
  that regresses accuracy past a threshold fails the build.
- **Citation verification** — for any model output claiming a source span,
  assert the span appears verbatim in the source. Free correctness signal.

Tests must pass without network access, a GPU, or an API key. That is what the
fixture provider is for.

---

## 12. Explicitly out of scope

Listed because each is a tempting detour that adds no value here:

- Charts, moving map, or any georeferenced plate display
- Flight plan filing
- Anything that emits a recommendation without showing its inputs
- A chat interface — this is a pipeline with a decision surface, not an
  assistant
- Non-US airspace and reporting formats (until the US path is complete)
- Real-time or in-flight use of any kind

---

## 13. Where things are

| | |
| --- | --- |
| `docs/spec.md` | Full build plan — hard parts in depth, hour estimates, data sources, interview framing |
| `docs/onboarding.md` | This file |
| `README.md` | Public-facing description and safety framing |

The spec is the authority on *what to build and why*. This file is the authority
on *how work is done here*.
