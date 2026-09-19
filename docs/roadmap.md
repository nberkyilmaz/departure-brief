# Roadmap

The goal, stated plainly: **everything a pilot looks at before a flight, in
one place, with a reason and a source behind every line of it.** Not all at
once — steadily, and each piece finished before the next is started.

**This tool does not decide whether to fly.** It reports what the products
say, compares them against the limits the pilot set, and puts what deserves a
second look first. The decision is the pilot's. Where a summary is needed,
it is the flight category — VFR, MVFR, IFR, LIFR — which is an objective
classification of ceiling and visibility, not an opinion.

Two rules that do not bend as it grows. Nothing is ever hidden: ranking and
collapsing change what you see first, never what exists. And every finding
carries the span of the report it was judged on, because a statement without
its source is worth nothing.

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
| **Nav log** | The wind triangle leg by leg, with a blank and a reason wherever a number cannot be had. |
| **Hazard advisories** | SIGMETs and AIRMETs that are in force, at your altitude, and across your route. |
| **The site** | Five pages, running the whole pipeline in the browser over reports it carries. |

### Blocked, and on what

- **Airspace transit** needs Canadian airspace geometry, which NAV CANADA
  does not publish. The FAA's layer is queryable, so the US half is
  buildable whenever it is wanted.
- **US NOTAMs** need FAA API credentials. Canadian ones need no key.

---

## Next

### 0. Take the verdict out, and judge what is decoded — done

Done. The verdict is gone; attention levels replaced severities; the flight
category is the only summary, and it classifies rather than judges. The
rules engine now reads the present weather, the total wind and indeterminate
ceilings it was handed and ignored.

Next, in order: the nearest reporting station when a field's own is asleep;
report age shown in colour; takeoff and landing distance from the POH; a
page per aerodrome; fuel planning; airspace.

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
- ~~**SIGMET and AIRMET.**~~ Done. In force, at your altitude, and across
  your route — all three, or it is not mentioned. An area the geometry
  cannot answer for is reported as needing to be checked by eye.
- **PIREPs.** What somebody up there actually found, which is often the
  only honest answer about icing and turbulence.
- **Graphical area forecast.** Images rather than text, so a different kind
  of work: show it, do not pretend to reason about it.

### 3. The nav log — done

True course, the wind triangle, heading, groundspeed, time and fuel, leg by
leg, with the reason printed wherever a number is missing.

Two things it still wants. **Magnetic** courses need variation, which
OurAirports does not publish and NASR does — so a US field gets magnetic
today and a Canadian one does not; the fix is a variation model rather than
a data source. And **fuel reserve** against fuel aboard, which needs the
handbook's burn table read out the way the weight-and-balance figures
were.

### 4. Daylight — done

Sunrise, sunset, civil twilight and how much daylight is left on arrival,
which is the question before "is this a night flight". The *next* of each
event rather than the day's, because last light in Ontario falls after
midnight Zulu for half the year.

### 5. More out of the handbook

The document pipeline is built and proven on weight and balance. The same
machinery reads:

- **Takeoff and landing distance** — but not as first imagined. An audit of
  the handbook's own OCR found that the extraction pipeline cannot verify a
  positional table cell, that the charts have cells Cessna deliberately left
  blank which interpolation would silently fill, and that the two pages
  disagree about the headwind correction (2 knots on one, 8 on the other),
  so at least one is a misread. The honest feature is: show the chart row as
  printed, cited to a crop; use the density altitude the field itself
  measured or none at all; print the notes verbatim and apply nothing; put
  the runway length beside it and draw no conclusion. See docs/worklog.md,
  session 20.
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
