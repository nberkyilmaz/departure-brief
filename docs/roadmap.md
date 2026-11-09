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
| **Along the way** | Every reporting station within 25 nm of the track, read for the time you are abeam it, by the same checks as the ends; more than 10 nm off the line, a crossed limit is a caution rather than an alert. |
| **Rules engine** | Personal minimums, CARs 602.114/115, FAR 91.155, crosswind per runway on true headings. Every finding cited. |
| **Briefings** | Immutable, content-addressed, reproducible; an API and a web view. |
| **NOTAM relevance** | Decoded, filtered by time and geography, deduped; deterministic rules where there is one right answer, a local model for the rest. |
| **Evaluation harness** | A reviewed labelled set and a gate that fails the build, not a claim in a README. |
| **Briefing diff** | What changed since last time, measured against the verdict rather than the text. |
| **Route map** | Where the flight goes and the 25 nm either side of it that is searched, every station with its category for the time you would pass it, and the advisories you would be inside while they are in force. |
| **Side view** | The route from the side: the ground at each station, the cloud bases forecast for when you pass it put on the altitude scale, SIGMET bands where you would be inside them while they are in force, the freezing level where there are upper-air temperatures, and what pilots have reported along the way. The terrain under the line is shaded from a published elevation model. It says what it does not know: no tops, and that spot heights on the centre line are not a clearance. |
| **When can I go?** | The flight judged again for each of the next twelve hours, by the same code as the briefing, the destination at the time you would arrive and the stations along the way when you would pass them; pick an hour and it is briefed. |
| **Weight and balance** | Read out of a scanned handbook, every figure checked against the ink before it is used. |
| **Forecast verification** | Did the TAF turn out to be right, and which way was it wrong. |
| **Winds and temperatures aloft** | Canada's from NAV CANADA at all ninety-seven aerodromes it publishes them for, interpolated to the altitude flown; the temperature at cruise as the first question about icing. The United States has had no official winds aloft forecast since NOAA discontinued its FB bulletin on 3 November 2026, so a US field reads the nearest balloon within 200 nm instead, labelled as measured with the station and its age. |
| **Daylight** | Last light on arrival and how much of it is left, from the same solar arithmetic the night rules use. |
| **Nav log** | The wind triangle leg by leg, true and magnetic, with a blank and a reason wherever a number cannot be had. |
| **Magnetic variation** | NOAA's World Magnetic Model, checked against all hundred of its published test values, so a Canadian field gets a magnetic heading as readily as an American one. |
| **Hazard advisories** | SIGMETs and AIRMETs that are in force, at your altitude, and across your route, with the American AIRMETs from the G-AIRMET and each hazard's three-hourly pictures taken as one. |
| **The site** | Five pages, running the whole pipeline in the browser over reports it carries. |

### Blocked, and on what

- **Airspace in Canada** needs Canadian airspace geometry, which NAV CANADA
  sells rather than publishes. The US half is done: Class B, C and D and
  special use areas your line goes through are drawn on the map and the
  side view from the FAA's layers, as a picture and not as a check.
- **US NOTAMs** need FAA API credentials. Canadian ones need no key. The
  site already carries every American field and its weather; until the
  credentials arrive, a briefing that touches one says plainly that its
  NOTAMs were not checked, and where to look them up.

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

### 1. Make the site usable — done

The pipeline works and nobody could use it. That came before every feature
below, because a feature nobody can reach is not finished.

Done: a form that forgives, with aerodrome lookup rather than free text and
a plan that survives a reload; a verdict scannable in five seconds with the
reasoning one tap away; a phone layout; what the briefing could not see,
stated beside the verdict rather than left to be inferred. And the page
runs the pipeline itself, so changing a minimum rebuilds the verdict in the
browser rather than showing a different picture of one.

**Live weather** is live, for nothing a month. Neither weather service
allows a browser to call it directly, so a relay on Cloudflare's free plan
takes the whole country's METARs, TAFs, hazard advisories and upper winds on
a timer and keeps the latest copy; the page reads it on every load and
judges it itself, and fetches NOTAMs through it for the aerodromes being
briefed. If the relay cannot be reached the page falls back to the recorded
reports and says why. Deployed on 27 October 2026; how, in docs/deploy.md.

The API on Render remains the way to add memory — briefing history, "what
changed" across visits, and forecast verification fed continuously — when
that is worth $7 a month.

### 2. The rest of the weather picture

Each is the same shape as METAR and TAF — fetch, decode with spans, store
verbatim, feed the rules — so they get cheaper as they go.

- ~~**Winds and temperatures aloft.**~~ Done. Interpolated to the altitude
  being flown, with the temperature at cruise as the first question about
  icing. Fetched for the route rather than the aerodromes, because a small
  field is almost never an upper wind site. The US half read NOAA's FB
  bulletin, column by column, since a high site leaves its lowest levels
  blank — until NOAA retired the NAM model it was built from on 3 November
  2026 and discontinued the bulletin with it (SCN 26-47, updated 5
  November). There is no official replacement. The decoder stays, tested
  against the last bulletins issued; US legs now read what the balloons
  measured: the mandatory levels, and between them the same flight's
  significant levels once they have arrived, which give a wind about every
  thousand feet at a light aircraft's heights and the temperature wherever
  it changed course.
- ~~**SIGMET and AIRMET.**~~ Done. In force, at your altitude, and across
  your route — all three, or it is not mentioned. An area the geometry
  cannot answer for is reported as needing to be checked by eye. One on the
  route that would be over before you could reach it, even leaving half an
  hour early with 40 kt behind you, or not begin until you could be past
  it, is a note rather than an alert. American AIRMETs come from the
  G-AIRMET, which covers the lower 48.
- ~~**PIREPs.**~~ Done. What somebody up there actually found, which is
  often the only honest answer about icing and turbulence, drawn on the map
  and the side view from the last ninety minutes and within 50 nm of the
  route. They are shown and not judged: no report becomes a finding, and
  no report at all says nothing about the air.
- **Graphical area forecast.** Images rather than text, so a different kind
  of work: show it, do not pretend to reason about it.

### 3. The nav log — done

True course, the wind triangle, heading, groundspeed, time and fuel, leg by
leg, with the reason printed wherever a number is missing.

~~**Magnetic** courses.~~ Done, from the World Magnetic Model rather than a
data source: OurAirports publishes no variation and NASR's is decades old
at many fields. The variation is taken where each leg begins, for the date
flown, and the aerodrome page gives every runway end in both.

Still wanted: **fuel reserve** against fuel aboard, which needs the
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
  the runway length beside it and draw no conclusion.
- **Airworthiness dates**: annual, transponder, ELT, pitot-static. A flight
  can be legal on weather and illegal on paperwork.

### 6. Pilot currency

Medical, flight review, ninety-day passenger currency, night currency. The
same shape as personal minimums, and the same treatment: a finding with a
date and a citation, never a silent pass.

### 7. Then the blocked ones

Canadian airspace when geometry can be found; US NOTAMs when credentials
arrive.

---

## After the web

A mobile application, once the web version has earned it. The pipeline is
already a library with no interface assumptions, an HTTP surface on top and
a store behind an interface, so the work is a client rather than a rewrite.

Worth doing in this order for a reason: a phone is where a pilot stands
beside the aeroplane, and a briefing that is not trustworthy on a laptop
will not become trustworthy on a phone.
