# Hold Short — Flight Briefing Decision Support

A build spec. Supersedes `bellwether-spec.md` and `recoup-spec.md`.

*Hold short.* Stop before the line and brief before you cross it. It answers one question: **given this flight, at this time, should I go — and why?**

---

## 0. The competitive read, up front

ForeFlight, Garmin Pilot and 1800wxbrief are excellent at fetching and displaying. Ask any of them *"should I go?"* and they hand you raw data and wish you luck.

**Aggregation is commodity. Reasoning is not.** Do not compete on charts, moving map, or data coverage — you will lose, and it isn't interesting engineering. Compete on the decision layer.

### The four things that don't exist in one place

| # | Feature | Why it's whitespace |
| --- | --- | --- |
| 1 | **NOTAM relevance ranking** | Existing tools filter by category or distance. None reason about *your* aircraft, altitude, equipment and time window. A taxiway closed at 0200Z is noise for a 1400Z departure. |
| 2 | **Personal minimums engine** | Every pilot has them; every pilot keeps them on paper. Nothing encodes them and evaluates a route against them leg by leg. |
| 3 | **Briefing diff** | You brief at 1400 for a 1900 departure. What changed? Nothing on the market answers this. |
| 4 | **Forecast verification** | Did the TAF verify against the actual METAR at your ETA? Accumulate it and you learn which fields forecast badly. Nobody offers this. |

### Your unfair advantage

**You already know this domain.** Bellwether would have required learning securities accounting first; Recoup required learning CPG deductions. Here you're the expert. That's twenty-plus hours you don't spend, and it will show in every design decision — which is exactly what makes a project read as real rather than academic.

### How this maps to the Confido posting

The target role is a Software Engineer at an AI-infrastructure company for CPG finance. Different domain, same job. Every line of their posting has a counterpart here:

| Their posting says | Hold Short |
| --- | --- |
| "AI-powered workflows for **document processing and data extraction**" | **H1b** — airworthiness and W&B extraction from photographed logbooks and scanned POH pages, OCR-grounded, low-confidence routed to review |
| "Scaling systems that **ingest data from multiple sources**" | AWC, FAA NOTAM, FAA NASR, USGS, plus uploaded documents — all normalized to one canonical schema |
| "**Backend services and APIs** that power financial workflows and analytics" | Fetch layer, decoders, rules engine, briefing assembly |
| "Building **analytics and forecasting** tools" | **H6** forecast verification — does the TAF actually verify, and how does it bias? |
| "**Product experiences that turn data into actionable insights**" | The entire thesis: raw METAR in, plain-language verdict with citations out |
| "Experience with **AI/ML-powered systems**" *(nice to have)* | Two distinct LLM workloads — document extraction and relevance ranking — both measured against labelled sets in CI |
| "Complex **operational and data** problems" | Regulatory rules engines, 3D geometry, time-resolved forecasts |

**Do not describe this as "an aviation app" in an interview.** Describe it as a multi-source ingestion pipeline with a document-extraction layer, a deterministic rules engine, and measured LLM components — that happens to be about flying. The transferable skills are the point; the domain is what makes it memorable.

### Safety framing — non-negotiable

This is a **study and planning aid, not an operational tool.** It does not replace an official briefing. Say so prominently in the UI and at the top of the README — not buried in a footer.

Handled well this is a *positive* signal: it shows you understand that software near a safety-critical domain carries obligations. Handled badly it's the thing an interviewer with a pilot's licence will grill you on. Never imply certification, never imply authority, never let the UI present a verdict without the raw source beside it.

---

## 1. What it does

```
Flight plan in → Fetch → Decode → Resolve to route+time → Evaluate → Verdict + diff
```

You give it: departure, destination, alternate, route, departure time, aircraft, and your personal minimums profile.

It gives you:

- **A go / marginal / no-go verdict per leg**, with every finding citing the raw report behind it
- **A ranked NOTAM list** — the few that affect this flight, with the rest collapsed but available
- **A time-resolved forecast** — conditions at each waypoint at your ETA, not "conditions now"
- **A departure window** — when the marginal period opens and closes
- **A diff against your last briefing** for this flight

---

## 2. Data sources

All free, all public, no licensing traps. This is a much better data situation than the market-data world.

| Source | What you get | Notes |
| --- | --- | --- |
| **aviationweather.gov** (NOAA AWC) | METAR, TAF, PIREP, AIRMET/SIGMET | US government, public domain. Has a JSON data API. Verify current endpoint shapes — they modernized recently. |
| **FAA NOTAM API** | NOTAMs by location and time | Free API key via registration. The data itself is the messy part, not the access. |
| **FAA NASR** | Airports, runways, frequencies, magnetic variation | Free bulk download, updated on the 28-day cycle. You need runway headings for crosswind computation. |
| **Aircraft performance** | From the POH | Manual entry. One JSON profile per aircraft you fly. |

No vendor terms to worry about, nothing you can't commit to a public repo. Cache aggressively anyway — be a good citizen with rate limits and send a real `User-Agent`.

---

## 3. Architecture

```
   Flight plan (route, time, aircraft, minimums profile)
                        │
                        ▼
        ┌───────────────────────────────────┐
        │  Fetch layer — one interface per  │
        │  source, cached, rate-limited     │
        └───────────────────────────────────┘
             │           │            │
      METAR/TAF      NOTAM        NASR/airport
             │           │            │
             ▼           ▼            ▼
   ┌──────────────┐  ┌──────────────────────┐
   │ Deterministic│  │ NOTAM pipeline       │
   │ decoders     │  │ parse → dedupe →     │
   │ METAR/TAF/   │  │ LLM relevance rank   │
   │ PIREP        │  │ (cites source text)  │
   └──────────────┘  └──────────────────────┘
             │                   │
             ▼                   │
   ┌──────────────────────┐      │
   │ Route + time resolver│      │
   │ ETA per waypoint,    │      │
   │ TAF period selection │      │
   └──────────────────────┘      │
             │                   │
             ▼                   ▼
   ┌─────────────────────────────────────────┐
   │  Rules engine (deterministic, testable) │
   │  personal minimums · FAR 91.155/91.169  │
   │  crosswind per runway · currency        │
   └─────────────────────────────────────────┘
                        │
                        ▼
              Briefing (versioned, content-addressed)
                        │
                        ├──► go / marginal / no-go, every finding cited
                        └──► diff vs. previous briefing for this flight

   Postgres — flights, raw reports, decoded reports, briefings (append-only)
```

**Same discipline as the earlier specs.** Every raw report is stored verbatim with its fetch timestamp and content hash. Briefings are immutable versions, never updated in place. That's what makes the diff feature trivial to build — it falls out of the storage model rather than being bolted on — and it means you can always reconstruct exactly what you knew at any moment.

---

## 4. The hard parts

### H1 — Deterministic decoders

METAR and TAF are terse coded formats with a real grammar and a long tail of edge cases: `VRB03KT`, `10SM`, `-RA BR`, `BKN008 OVC015`, `TEMPO`, `PROB30`, `BECMG`, `FM1800`, `RMK` sections, `AUTO`, `CAVOK`, wind shear groups, variable wind ranges, `M` prefixes for temperatures below zero, sea-level pressure in remarks.

**Write a real parser, not regex soup.** A small tokenizer plus a state machine over group types, the same shape as the ALB log parser you already built at Vretta. Every decoded field keeps a reference to the substring it came from — that's your grounding, exactly like the OCR token citations in the earlier specs.

**These decoders must be deterministic and fully unit-tested.** No LLM anywhere near them. Weather decoding has a single correct answer and you should treat any ambiguity as a parser bug. Build a corpus of a few hundred real METARs and TAFs and assert against hand-decoded expectations.

### H2 — Route and time resolution

**This is where most of the genuine difficulty lives, and it's invisible from the outside.**

You depart at 1400Z and arrive at 1630Z. What are the conditions *at your ETA*, not now?

- **TAF validity periods** — a TAF is a sequence of periods with `FM` transitions, plus `TEMPO` and `PROB` overlays that don't replace the prevailing group, they qualify it. Selecting the governing condition at a given instant means resolving a base period plus any active overlays, and deciding how to treat a `TEMPO` for go/no-go purposes. (Conservative answer: a `TEMPO` below minimums makes the leg marginal, not go.)
- **ETA computation** — groundspeed from planned TAS and forecast winds aloft, per leg. Winds aloft add another data source and another interpolation.
- **Airports without TAFs** — most small fields have none. You interpolate from nearby reporting stations and must be honest in the UI that you're doing so, with a confidence marker.
- **Time zones** — everything in Zulu, internally, always. Convert only at the display edge. Local time in the domain model is how you get a bug that kills someone's flight planning.

### H3 — NOTAM relevance ranking

**The flagship feature.**

NOTAMs are partly structured, largely free text, written in an abbreviation dialect (`RWY 09/27 CLSD`, `TWY B BTN TWY C AND TWY D CLSD`, `AD AP ABN U/S`), and issued in volume. A typical briefing has dozens; a handful matter.

The pipeline:

1. **Parse what's structured** — location, effective start and end, category, affected facility. Deterministic. A NOTAM outside your time window is dropped before you spend a token.
2. **Dedupe and cluster** — the same condition often appears repeatedly across issuances. Fingerprint on `(location, facility, condition)` with the identifier stripped, exactly like the 5xx dedupe.
3. **LLM relevance classification** per surviving NOTAM, against the flight context — aircraft type, planned altitude, equipment, arrival time, whether you're IFR or VFR:

```typescript
const NotamAssessment = z.object({
  relevance:   z.enum(["critical", "advisory", "irrelevant"]),
  category:    z.enum(["runway", "taxiway", "approach", "airspace",
                       "lighting", "navaid", "obstacle", "services", "other"]),
  affects:     z.array(z.enum(["departure", "enroute", "arrival", "alternate"])),
  plain_text:  z.string(),          // decoded into normal English
  cited_span:  z.string(),          // must appear verbatim in the source
  rationale:   z.string(),
});
```

4. **Verify the citation.** If `cited_span` isn't a literal substring of the source NOTAM, the assessment is untrusted and gets demoted rather than shown. Same grounding trick as the OCR token alignment — a free correctness signal that costs nothing.

**Never let the model drop a NOTAM silently.** Everything is shown; relevance controls ordering and collapse state only. A model error must degrade to noise, never to a missing item. This is the single most important design rule in the project, and it's a great thing to be able to explain.

### H1b — Aircraft document ingestion

**This is the piece that makes "document processing and data extraction" literally true rather than approximately true — and it closes a real hole in the product.**

The rules engine needs to answer *"is this aircraft legal for this flight?"* That requires:

- **Airworthiness dates** — annual inspection, 100-hour if applicable, transponder certification (24 calendar months), pitot-static and altimeter (24 months, IFR), ELT battery, AD compliance
- **Weight and balance** — empty weight, empty arm and moment, the loading envelope, and station arms for each seat and baggage area
- **Limitations** — demonstrated crosswind component, max gross weight, useful load

**Where does any of that live?** In a photographed maintenance logbook page and a scanned POH. Not in an API. Every pilot has these as phone photos or PDFs, and no existing app reads them — you type the numbers in by hand, every time, and hope you typed them right.

**The technique is the one from the Recoup spec, unchanged:**

1. **Real word boxes first** — OCR the page, get `{text, page, x, y, w, h}` per token.
2. **LLM extraction** with the page image plus the token list, returning each field with the token ids it came from.
3. **Align** — union the cited boxes for the highlight. If the cited tokens' text doesn't fuzzy-match the returned value, the field is automatically low-confidence.
4. **Route low-confidence fields to a review queue** with the source region highlighted, rather than into the legality check.

```typescript
const AirworthinessRecord = z.object({
  kind:             z.enum(["annual", "100_hour", "transponder",
                            "pitot_static", "altimeter", "elt", "ad_compliance"]),
  performed_on:     z.string(),            // ISO date
  tach_hours:       z.string().nullable(),
  next_due_on:      z.string().nullable(),
  signed_by:        z.string().nullable(),
  certificate_no:   z.string().nullable(),
  source_token_ids: z.array(z.number()),
});
```

**Weight and balance is the better demo.** Extract the station arms and envelope from the POH once, per aircraft, then compute CG for an actual loading and check it against the envelope. Document extraction feeding a numeric engine producing a verdict — the whole pipeline in one screen, and genuinely useful because W&B is a thing pilots recompute constantly and get wrong.

**Handwriting warning.** Maintenance logbook entries are often handwritten, and OCR on handwriting is materially worse than on print. Two mitigations: lean on the confidence routing (this is exactly the case it exists for), and start with the printed sources — POH pages, typed inspection stickers, avionics shop invoices — before attempting handwritten log entries. Be honest about the accuracy split in your README; measuring it is more impressive than pretending it doesn't exist.

**Scope:** 25–35 hours. Do it after the rules engine exists, so extraction has something to feed.

### H3b — Airspace transit analysis

**Given the route and altitude, which airspace do you actually fly through — and what are the VFR minima there?**

This is the piece that makes the rules engine real rather than a lookup table, and it's the hardest non-LLM problem in the project.

**The geometry.** Airspace is 3D and irregular. Class B is the upside-down wedding cake with multiple shelves at different radii and floors. Class C has an inner core and an outer shelf. Class D is roughly cylindrical but keyed to an airport's operating hours. Class E floors vary — surface, 700 AGL, 1200 AGL — and the transitions are irregular polygons drawn around instrument approaches. Class G is whatever's left underneath.

**The approach.** Put the airspace polygons in **PostGIS** (you already have Postgres) with floor and ceiling as attributes. Sample your route polyline at a fixed interval — every half nautical mile is plenty — and for each sample point run a point-in-polygon query filtered by your planned altitude band. Collapse consecutive identical results into transit segments:

```
KXYZ → KABC at 4500 MSL
  ├─ 0.0–12.4 nm   Class G  → 1 SM, clear of clouds (day, <1200 AGL... check AGL)
  ├─ 12.4–38.1 nm  Class E  → 3 SM, 500 below / 1000 above / 2000 horizontal
  ├─ 38.1–41.7 nm  Class D  → 3 SM, 500 / 1000 / 2000  ⚠ tower closes 0400Z
  └─ 41.7–52.0 nm  Class E  → 3 SM, 500 / 1000 / 2000
```

**The rules table (91.155)** is a beautiful deterministic test target — exhaustive, finite, and every row is checkable:

| Airspace | Visibility | Cloud clearance |
| --- | --- | --- |
| Class B | 3 SM | Clear of clouds |
| Class C, D | 3 SM | 500 below / 1000 above / 2000 horizontal |
| Class E, below 10,000 MSL | 3 SM | 500 / 1000 / 2000 |
| Class E, at/above 10,000 MSL | 5 SM | 1000 / 1000 / 1 SM |
| Class G, ≤1200 AGL, day | 1 SM | Clear of clouds |
| Class G, ≤1200 AGL, night | 3 SM | 500 / 1000 / 2000 |
| Class G, >1200 AGL, <10,000 MSL, day | 1 SM | 500 / 1000 / 2000 |
| Class G, >1200 AGL, <10,000 MSL, night | 3 SM | 500 / 1000 / 2000 |
| Class G, >1200 AGL, ≥10,000 MSL | 5 SM | 1000 / 1000 / 1 SM |

Write this as a pure function with an exhaustive test per row. It's the single most testable thing in the project.

**Two things this drags in:**

- **AGL vs MSL.** Class G thresholds and Class E floors are AGL; your cruise altitude is MSL. You need terrain elevation along the route. USGS publishes free elevation data; sampling it at your route points is enough — you don't need a full terrain model.
- **Day vs night.** Class G minima change at night, and "night" for 91.155 is between evening and morning civil twilight. That means a solar position calculation for your lat/long and date. Deterministic, well-documented, and satisfying to implement.

**The payoff feature — special use airspace crossed with NOTAMs.** MOAs, restricted and alert areas are in the same geometry layer, and their *activation* comes through NOTAMs. Joining the two gives you something no consumer app does cleanly:

> ⚠ **R-2501 active 1400–2200Z per NOTAM — your route crosses it 1612–1627Z**

That single line ties the geospatial engine to the NOTAM pipeline and is the most compelling thing you could put in a demo video.

**Data source caveat.** The FAA publishes airspace boundaries as shapefiles through its aeronautical data portal. Verify current availability and format before committing to it — these datasets get reorganized. OurAirports and OpenAIP are community fallbacks with varying licensing, so check terms before shipping anything public.

**Scope warning.** This is a real milestone, not an afternoon. Budget 25–35 hours. Do it *after* the rules engine works on airport-only conditions, so you always have something that runs.

### H4 — The rules engine

Deterministic, heavily tested, no LLM. Encodes:

- **Personal minimums** — ceiling, visibility, crosswind component, gust factor, night, recency of type. Configurable per pilot, versioned so you can see how yours evolved.
- **Regulatory** — VFR minimums by airspace class (91.155), IFR alternate requirements and the 1-2-3 rule (91.169), fuel reserves (91.167).
- **Crosswind per runway** — for each runway at each airport, computed against forecast wind at your ETA using true runway heading from NASR corrected for magnetic variation. Compare to your aircraft's demonstrated crosswind and your personal limit, which are different numbers.
- **Currency** — flight review, medical, 90-day passenger currency, night currency, IFR currency and approaches. Aircraft airworthiness too: annual, transponder, pitot-static, ELT.

Every rule returns a structured verdict with the inputs that produced it. `NO-GO: destination ceiling BKN008 at ETA 1630Z, below personal minimum 1500 ft — TAF KXYZ issued 1520Z`. **The citation is the product.**

### H5 — Briefing diff

Because briefings are immutable and content-addressed, this is mostly a structural comparison — but the interesting work is deciding what counts as a *meaningful* change.

A TAF reissued with identical content is not a change. A ceiling moving 2000→1800 ft is not a change if your minimum is 1500. A ceiling moving 1600→1400 crosses your threshold and is the most important thing on the screen. **Diff against the verdict, not against the raw text.**

Surface: new NOTAMs, verdict transitions, and any value that crossed a personal minimum since last check.

### H6 — Forecast verification

Cheap to build, genuinely novel, and it compounds.

For every briefing, record what the TAF predicted for your ETA. Later, fetch the actual METAR for that time. Store the pair. Over a season, per airport: how often does the TAF verify, and does it bias high or low on ceiling and visibility?

Surface it as a confidence annotation — *"KXYZ TAFs have under-forecast ceilings by 300+ ft in 40% of the last 50 observations."* No consumer product does this, and it's exactly the kind of thing a pilot would actually want.

---

## 5. What it costs, and running it on your hardware

### Cost

**The data is entirely free.** Only LLM calls cost anything, and only NOTAM assessment uses the model.

A briefing might have 30 NOTAMs surviving the deterministic filter, at roughly 800 input / 200 output tokens each. Per briefing:

| Setup | Per briefing | 20 briefings/month |
| --- | --- | --- |
| Opus 5 | ~$0.27 | ~$5.40 |
| Haiku 4.5 | ~$0.05 | ~$1.00 |
| Local (Ollama) | $0 | **$0** |

**NOTAM assessment is short text in, small JSON out — the ideal local-model workload.** Realistically this runs at $0 forever once you've tuned it. Use Claude to build your labelled reference set and to benchmark against, then run local.

The seven cost rules from the earlier spec still apply, and two matter most here:

- **Cache on content hash.** A NOTAM's assessment is keyed by `(notam_hash, flight_context_hash, prompt_version, model)`. Re-briefing the same flight re-uses everything unchanged — which is exactly what makes the diff cheap.
- **Never call a model in the request path.** Assessment happens at fetch time; the UI reads rows.

### Hardware

**Build entirely on the laptop.** RTX 3060 with 6 GB runs Qwen 2.5 7B comfortably, and NOTAM assessment is short-context work — this fits with room to spare. You do not need the desktop to develop.

**Add a `FixtureProvider` on day one.** It replays recorded model responses from disk, keyed by the same content hash. Record once, and every subsequent run — tests, refactors, UI work, CI — needs zero GPU and zero API. This is the cassette pattern from HTTP testing applied to inference, and it's what makes the laptop-first workflow comfortable.

| Where | What |
| --- | --- |
| Laptop, ~95% | All coding, tests, decoders, rules engine, UI, fixtures |
| Laptop, sometimes | Qwen 2.5 7B live checks |
| Desktop, rarely | 14B comparison runs, full eval sweeps |

The desktop stops being a dependency and becomes a benchmark box you visit.

---

## 6. Tech stack

| Layer | Choice | Why |
| --- | --- | --- |
| Language | TypeScript, strict | Your strongest |
| API | Node + Fastify | Schema-first validation |
| Database | PostgreSQL + **PostGIS** | Append-only briefings, time-series reports, and airspace geometry in the same engine — no separate geo store |
| Model | Ollama local, Claude for benchmarking | Behind one `LLMProvider` interface |
| Frontend | React | The briefing view is the product surface |
| Eval | Vitest + CLI runner | Decoder correctness + NOTAM relevance scoring |
| CI | GitHub Actions | Decoder tests always; eval gate on the labelled set |

Docker Compose for Postgres. Runs on any machine.

---

## 7. Milestones

| # | Milestone | Deliverable | Hours |
| --- | --- | --- | --- |
| M0 | Schema + skeleton | Postgres, content-addressed report store, Compose | 8–12 |
| M1 | Fetch layer | AWC + FAA NOTAM + NASR ingest, caching, rate limits | 12–16 |
| M2 | METAR/TAF decoders | Tokenizer + state machine, span references, test corpus | 20–28 |
| M3 | Route + time resolver | ETA per waypoint, TAF period selection, TEMPO/PROB handling | 20–28 |
| M4 | Rules engine | Personal minimums, 91.155/91.169, crosswind per runway, currency | 20–28 |
| M4b | Airspace transit | PostGIS geometry, route sampling, terrain AGL, civil twilight, SUA×NOTAM | 25–35 |
| M6b | Aircraft documents | OCR word boxes, LLM extraction with citation alignment, W&B envelope, review queue | 25–35 |
| M5 | Briefing assembly + UI | Verdict view, citations, collapse/expand, minimums profile editor | 25–35 |
| M6 | NOTAM pipeline | Parse, dedupe, LLM relevance, citation verification | 20–28 |
| M7 | Eval harness | Decoder assertions + hand-labelled NOTAM set, CI gate | 12–16 |
| M8 | Briefing diff | Verdict-level comparison, change surfacing | 10–14 |
| M9 | Forecast verification | TAF-vs-METAR pairing, per-airport reliability stats | 12–16 |
| M10 | Polish | README with safety framing, diagram, demo video, seeded demo flight | 8–12 |

**Total: roughly 215–305 hours** with airspace and document ingestion included.

### The minimum credible version

**M0 → M1 → M2 → M3 → M4 → M5 → M6 → M6b → M7**, roughly **150–210 hours**. Decoders, time resolution, rules engine, NOTAM ranking, **document extraction**, and a measured eval harness.

Note what's in and what's out: **M6b is in, M4b is out.** Document extraction is the piece that makes the Confido mapping literal, so it earns its place ahead of airspace geometry. Airspace is the better *aviation* feature; document ingestion is the better *hiring* feature. Build M6b first, M4b right after.

**If you need it smaller:** cut M3's winds-aloft interpolation (use planned TAS for ETA) and cut currency from M4 → about **130–175 hours**, and nothing on the resume becomes untrue.

**Whatever you cut, tell me** — the resume bullets name PostGIS airspace geometry and OCR-grounded document extraction specifically, and both are concrete enough that an interviewer will ask you to walk through them.

M8 (diff) and M9 (forecast verification) are the differentiators. Build them when you can — the diff especially, since it's nearly free once the storage model is right and it's the feature nobody else has.

### Suggested build order

Do **M4 before M4b**: get the rules engine working on airport-only conditions first, so you always have something that runs end to end. Airspace transit is an upgrade to a working system, not a prerequisite for one. Same reasoning applies to M6 — the deterministic pipeline should produce a useful briefing before the LLM ever enters it.

---

## 8. Interview material

- **"Isn't this just ForeFlight?"** → Aggregation is commodity; reasoning isn't. They show you data, this evaluates it against your personal envelope and shows its work. And I'm a pilot, so I know which reasoning matters.
- **"How do you stop the model from hiding a critical NOTAM?"** → It can't. Relevance controls ordering and collapse only; nothing is ever dropped. A model error degrades to noise, never to a missing item.
- **"How do you know the relevance ranking is any good?"** → Hand-labelled corpus, scored in CI, plus citation verification that catches ungrounded assessments for free.
- **"Why no LLM in the decoders?"** → METAR has one correct parse. Non-determinism there is a defect, not a feature.
- **"How do you know which airspace the route crosses?"** → Route polyline sampled at half-mile intervals, point-in-polygon against PostGIS airspace geometry filtered by altitude band, consecutive results collapsed into transit segments. Class G and Class E floors are AGL, so terrain elevation gets sampled too — and night changes the Class G minima, which means a civil twilight calculation.
- **"How does this relate to your work?"** → It's the same problem as the 5xx alerting pipeline at Vretta: thousands of raw items, a handful that matter, fingerprint and rank so a human sees the signal.

That last one is why this project makes your resume cohere. **One story: making noisy operational signal legible.**

---

## 9. Traps

- **Local time anywhere in the domain model.** Zulu internally, always. Convert at the display edge only.
- **Letting the LLM near the decoders.** METAR parsing is deterministic. Keep it that way.
- **Dropping NOTAMs on model judgment.** Rank and collapse; never filter out.
- **Presenting a verdict without its source.** The citation is the product. A verdict with no raw report beside it is worse than no verdict.
- **`TEMPO` treated as prevailing.** It qualifies the base group, it doesn't replace it. Conservative handling: below-minimums `TEMPO` makes a leg marginal.
- **Magnetic vs. true runway headings.** NASR gives you both; crosswind math needs them consistent with the wind report's reference. METAR winds are true; ATIS and tower winds are magnetic.
- **Scope creep into charts, moving map, or filing.** You will lose that race and it isn't the interesting part.
- **Weak safety framing.** Non-negotiable, and the first thing a pilot-interviewer will check.

---

## 10. Before you apply

The resume describes this in the present tense. That's a target, not a fact. Build the minimum credible version first, or say the word and I'll rewrite the entry to describe only what exists.

The Vretta material carries your application on its own. This is upside, not life support — but it's the most distinctive thing you'll have on the page, and the one an interviewer will actually want to talk about.
