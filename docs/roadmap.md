# Roadmap

The goal, stated plainly: **everything a pilot looks at before a flight, in
one place, with a reason and a source behind every line of it.** Not all at
once — steadily, and each piece finished before the next is started.

Two rules that do not bend as it grows. Nothing is ever hidden: ranking and
collapsing change what you see first, never what exists. And every finding
carries the span of the report it was judged on, because a verdict without
its source is worse than no verdict.

This is a study and planning aid. It is not, and will not become, an
official briefing.

---

## Where things stand

### Done

| | What it does |
| --- | --- |
| **METAR / TAF decoders** | Span-annotated, total, no model anywhere near them. Under 0.3 % of tokens unparsed across 8,000 real reports. |
| **Fetch and store** | Every report kept verbatim, content-addressed, append-only, so what was known at any moment can be reconstructed. |
| **Route and time** | ETA per waypoint; the forecast period that governs each one, prevailing versus overlay. |
| **Rules engine** | Personal minimums, CARs 602.114/115, FAR 91.155, crosswind per runway on true headings. Every finding cited. |
| **Briefings** | Immutable, content-addressed, reproducible; an API and a web view. |
| **NOTAM relevance** | Decoded, filtered by time and geography, deduped; deterministic rules where there is one right answer, a local model for the rest. |
| **Evaluation harness** | A reviewed labelled set and a gate that fails the build, not a claim in a README. |
| **Briefing diff** | What changed since last time, measured against the verdict rather than the text. |
| **Weight and balance** | Read out of a scanned handbook, every figure checked against the ink before it is used. |
| **Forecast verification** | Did the TAF turn out to be right, and which way was it wrong. |
| **Winds and temperatures aloft** | Interpolated to the altitude flown; the temperature at cruise as the first question about icing. |
| **Daylight** | Last light on arrival and how much of it is left, from the same solar arithmetic the night rules use. |
| **The site** | Four pages, running the whole pipeline in the browser over reports it carries. |

### Blocked, and on what

- **Airspace transit** needs Canadian airspace geometry, which NAV CANADA
  does not publish. The FAA's layer is queryable, so the US half is
  buildable whenever it is wanted.
- **US NOTAMs** need FAA API credentials. Canadian ones need no key.

---

## Next

### 1. Make the site usable — done, except for live weather

The pipeline works and nobody could use it. That came before every feature
below, because a feature nobody can reach is not finished.

Done: a form that forgives, with aerodrome lookup rather than free text and
a plan that survives a reload; a verdict scannable in five seconds with the
reasoning one tap away; a phone layout; what the briefing could not see,
stated beside the verdict rather than left to be inferred. And the page
runs the pipeline itself, so changing a minimum rebuilds the verdict in the
browser rather than showing a different picture of one.

What is left is **live weather**, which needs a host, because neither
weather service allows a browser to call it directly. The image and the
rate limits are done; it needs the owner's accounts. Until then the site
briefs over reports frozen at the moment they were recorded, and says so.

### 2. The rest of the weather picture

Each is the same shape as METAR and TAF — fetch, decode with spans, store
verbatim, feed the rules — so they get cheaper as they go.

- ~~**Winds and temperatures aloft.**~~ Done. Interpolated to the altitude
  being flown, with the temperature at cruise as the first question about
  icing. Fetched for the route rather than the aerodromes, because a small
  field is almost never an upper wind site.
- **SIGMET and AIRMET.** Hazards along the route at the altitude flown.
- **PIREPs.** What somebody up there actually found, which is often the
  only honest answer about icing and turbulence.
- **Graphical area forecast.** Images rather than text, so a different kind
  of work: show it, do not pretend to reason about it.

### 3. The nav log

The arithmetic a pilot does by hand, done once and checked: true and
magnetic heading per leg, groundspeed against the winds aloft, time en
route, fuel burned against fuel aboard, and the reserve the regulations
require. Deterministic, testable, and it makes the go/no-go answer complete
rather than weather-only.

Depends on winds aloft, and on magnetic variation the aerodrome data
already carries.

### 4. Daylight — done

Sunrise, sunset, civil twilight and how much daylight is left on arrival,
which is the question before "is this a night flight". The *next* of each
event rather than the day's, because last light in Ontario falls after
midnight Zulu for half the year.

### 5. More out of the handbook

The document pipeline is built and proven on weight and balance. The same
machinery reads:

- **Takeoff and landing distance**, against the actual runway, altitude and
  temperature — which is where a short strip on a hot day stops being fine.
- **Airworthiness dates**: annual, transponder, ELT, pitot-static. A flight
  can be legal on weather and illegal on paperwork.

### 6. Pilot currency

Medical, flight review, ninety-day passenger currency, night currency. The
same shape as personal minimums, and the same treatment: a finding with a
date and a citation, never a silent pass.

### 7. Then the blocked ones

Airspace transit when geometry can be found; US NOTAMs when credentials
arrive.

---

## After the web

A mobile application, once the web version has earned it. The pipeline is
already a library with no interface assumptions, an HTTP surface on top and
a store behind an interface, so the work is a client rather than a rewrite.

Worth doing in this order for a reason: a phone is where a pilot stands
beside the aeroplane, and a briefing that is not trustworthy on a laptop
will not become trustworthy on a phone.
