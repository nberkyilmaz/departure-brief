# Design notes

The decisions that shaped Departure Brief, and what each one cost.

## 1. Report, don't decide

The first version produced a GO / NO-GO verdict. I took it out. A tool
can't know what the pilot knows — their currency, the aircraft, how the day
feels — and a confident "GO" invites someone to stop reading. Now the only
summary is the flight category (VFR / MVFR / IFR / LIFR), which is a
classification of ceiling and visibility, not an opinion. Everything else is
a finding with an attention level:

- **alert** — a limit crossed in the prevailing forecast or the current
  observation
- **caution** — the same limit crossed inside a TEMPO, PROB or an in-progress
  BECMG, because that product is less certain
- **routine** — checked, and fine

Findings are ranked so the important ones come first. Nothing is ever
dropped.

## 2. Decoders: hand-written, total, and span-annotated

METAR and TAF are small grammars with a long tail of regional quirks. I
wrote the decoders by hand rather than using a library, for two reasons:

- **Spans.** Every decoded value carries the character range it came from.
  That is what lets the UI highlight the exact text behind a finding, and
  what lets a test assert that every token in a report is claimed exactly
  once.
- **Totality.** A decoder never throws. Anything it doesn't understand comes
  back as an explicit "unparsed" span instead of being silently dropped.

I drove it with a corpus of 8,000 real reports and a script that lists the
unparsed tokens by frequency. Under 0.3 % remain, mostly rare remarks.

## 3. Storage: append-only and content-addressed

Every raw report is stored verbatim and named by the SHA-256 of its bytes.
Decodings are stored per decoder version, so improving a decoder never
rewrites history. Every report also records when it was first fetched. A
briefing is assembled "as known by" an instant, and the briefing itself is
hashed. Re-running a briefing for the same instant reproduces it byte for
byte, which is what makes the "what changed since you last looked" diff
meaningful.

The store has two implementations, Postgres and in-memory. One contract
test suite runs against both.

## 4. Resolving a route in time

A forecast is only useful for the time you'll be at a place. The resolver
computes an ETA for each waypoint, then picks the TAF period that governs
it: the prevailing conditions, plus any TEMPO or PROB groups overlapping
that time, judged separately. When a field isn't reporting (CYSN closes
overnight) it borrows the nearest station that is, and every finding says
whose observation it was and how far away.

## 5. The same pipeline in the browser

The core package has a second entry point, `judge`, containing only
deterministic code with no Node dependencies. A test bundles it for the
browser and fails if anything reaches for `fs` or `crypto`. That lets the
web app load reports into an in-memory store and build the briefing itself.
Changing a personal minimum re-judges instantly, and the briefing has the
same content hash the server would produce.

## 6. Live weather without paying for a server

Neither aviationweather.gov nor NAV CANADA sends CORS headers, so a page
can't fetch from them directly. The obvious fix is a server. The free tiers
sleep, though (a 50-second cold start), and the always-on ones cost money
every month.

Instead, a Cloudflare Worker on the free plan acts as a relay:

- **It fetches on a timer, not per visitor.** Every five minutes it
  refreshes whatever is due — METARs every 5 minutes, TAFs and SIGMETs every
  15, upper winds hourly — and stores the latest copy in KV. Visitors read
  the copy, so traffic never multiplies requests to the weather services.
  That comes to about 600 KV writes a day, against a free limit of 1,000,
  and a test simulates the day to check it.
- **It holds no weather logic.** It moves bytes and timestamps them. The
  browser parses them with the same client classes the server uses, so the
  relay can't drift from the pipeline. It also fits in the free plan's
  10 ms of CPU time per request.
- **It never mixes sources.** If live METARs or TAFs can't be had, the page
  falls back entirely to a recorded snapshot and says so. A briefing built
  on today's METAR and last month's TAF would be worse than either alone.

One finding along the way: the AWC data API's bounding-box query
**silently thins stations over large areas**. One box over Canada returned
145 METARs; the same area split into four boxes returned 550. The relay
uses AWC's bulk cache files instead: every current report in one gzip file,
passed through still compressed with a `Content-Encoding` header so the
browser decompresses it.

## 7. Where a model is allowed, and how it's held to account

Two things use a model, both optional and both local through Ollama:

- **NOTAM relevance.** A deterministic rule decides first wherever there is
  one right answer (a closed runway at your departure aerodrome). The model
  ranks the rest and must cite the NOTAM text it relied on; citations are
  verified. An evaluation harness scores it against a labelled set, and CI
  fails if quality drops. The gate originally measured only agreement, which
  a model that refused to answer would pass with 100 %. It now requires
  coverage as well.
- **Reading a scanned handbook.** A vision model proposes weight-and-balance
  figures. A figure is used only if OCR finds it on the cited page. Anything
  else goes to a review queue. Precision is the hard gate, because these
  numbers feed a weight-and-balance calculation.

## 8. Testing

Every upstream client is tested against responses recorded from the real
services, and no fixture is invented. If no real response exists — FAA
NOTAMs, which need credentials — only the request shape is tested. No test
touches the network. CI runs typecheck, the full suite on Node 20 and 22
against real Postgres, the web build, and a container smoke test.

One bug worth recording: Postgres contract tests occasionally failed with
impossible results. The cause was two test runs sharing one database and
truncating each other's tables mid-test. Each run now gets its own database.

## What I'd do next

- **Airspace transit.** Canadian airspace geometry isn't published in a
  usable form; the US half is buildable from the FAA's layer.
- **PIREPs**, which are often the only honest answer about icing.
- **Memory across visits.** Briefing history and continuous forecast
  verification need the API's database; the relay deliberately has none.
