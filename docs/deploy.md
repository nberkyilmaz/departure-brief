# Putting it live

Three things can be published, and they are not the same thing.

**The page** (GitHub Pages) runs the whole pipeline in the browser. It is
already live and needs no server. On its own it carries recorded reports,
because neither the AWC nor NAV CANADA sends the headers a browser needs to
let a page call them directly — that was measured, not assumed, and
measured again on 20 October 2026.

**The relay** (a Cloudflare Worker, free) is what makes the page's weather
current. Every five minutes it takes every METAR and TAF in the country, the
hazard advisories and the upper winds, and keeps the latest copy; the page
reads that copy on every load and judges it itself. It holds no logic about
weather — it moves bytes and says when it fetched them. **This is the
recommended way to put live weather on the site**, and it costs nothing.

**The API** (Render and Neon) fetches too, and also remembers: stored
briefings, "what changed since last time" across visits, and forecast
verification. It is the full server, and the free tier sleeps; see below.

Where "free" has a catch, the catch is written down.

---

## What you need accounts for

You have to create these yourself; nothing here can do it for you.

| | What | Cost | Why |
|---|---|---|---|
| 1 | [Cloudflare](https://dash.cloudflare.com/sign-up) | free | Runs the relay. 100,000 requests a day, 1,000 storage writes a day (the relay uses about 600), and it does not sleep. |
| 2 | [Neon](https://neon.tech) | free tier | Only for the API. Postgres that does not expire. Render's own free Postgres is deleted after 30 days, which would take every stored briefing with it. |
| 3 | [Render](https://render.com) | free tier, or $7/month always on | Only for the API. The free tier sleeps after 15 minutes idle and the next request waits ~50 s. |
| 4 | A registrar | ~$10/year | See [the domain](#the-domain). Optional: the site works at its GitHub address. |

---

## The relay, step by step

About ten minutes, once. Everything is run from the repository root.

### 1. Sign in

```sh
npx wrangler@4 login
```

It opens a browser to the Cloudflare account and asks to allow Wrangler.

### 2. Somewhere to keep the copy

```sh
npx wrangler@4 kv namespace create SNAPSHOTS --config apps/relay/wrangler.toml
```

It prints an `id`. Put it in [`apps/relay/wrangler.toml`](../apps/relay/wrangler.toml)
in place of `REPLACE_WITH_THE_ID_WRANGLER_PRINTS`. The id is not a secret —
it names a store only your account can reach — so it is committed.

### 3. Deploy

```sh
npm run deploy -w apps/relay
```

It prints the relay's address, something like
`https://depbrief-relay.<your-subdomain>.workers.dev`. Open
`<that address>/status`: the first request fetches anything not yet held,
and within five minutes the timer has run and every product shows an age.
It answers 200 when everything is held and fresh, and 503 when something is
missing or the timer has stopped.

### 4. Point the page at it

In GitHub: **Settings → Secrets and variables → Actions → Variables → New
repository variable**, name `RELAY_URL`, value the relay's address with no
trailing slash. Then **Actions → Pages → Run workflow**. The page now says
**Live weather** and the age of the reports at the top of every briefing.

Unset the variable and redeploy, and the page goes back to the recorded
reports. If the relay is ever unreachable, the page falls back on its own
and says why — it never passes recorded weather off as current.

### What the relay does and does not do

- **Asks the services on a timer, not per visitor.** METARs every five
  minutes, TAFs and hazard advisories every fifteen, upper winds hourly. A
  hundred visitors are no extra requests upstream; there is a test that
  says so.
- **Gets the whole country in one request**, from the AWC's cache files
  rather than its data API. The data API's `bbox` silently thins stations
  over a large area — one box over Canada returned 145 METARs where the
  same area in four boxes returned 550. The cache file returns every one.
- **NOTAMs are the exception**: there is no country-wide request, so they
  are fetched when a flight is briefed, kept half an hour per aerodrome, and
  throttled to twenty upstream requests a minute per instance.
- **Never replaces good weather with an error page.** A product that fails
  keeps its last good copy, which carries its own age.
- **Answers only the pages named** in `ALLOWED_ORIGINS` in `wrangler.toml`.
  Add the custom domain there if one is ever attached.

To run it on a laptop against the real services, with the page in live
mode beside it:

```sh
npm run dev -w apps/relay
VITE_DEMO=1 VITE_RELAY=http://127.0.0.1:8787 npm run dev -w apps/web
```

---

## The API, step by step

### 1. A database

Create a Neon project. Copy the connection string it gives you — it looks
like `postgresql://user:pass@ep-something.us-east-2.aws.neon.tech/neondb?sslmode=require`.

Keep the `?sslmode=require`. `pg` reads it from the string and verifies the
certificate against the system roots; Neon presents a real one, so there is
nothing to configure and nothing to disable.

The schema creates itself. `PostgresStore.connect` runs every migration in
`packages/core/src/store/migrations` that the database has not recorded yet,
each in its own transaction, before the server accepts a request.

### 2. The service

In Render: **New → Blueprint**, point it at this repository. It reads
[`render.yaml`](../render.yaml), which asks for a free Docker web service in
the Ohio region with a health check on `/api/health`.

Set the two secrets in the dashboard:

- `DATABASE_URL` — the Neon string.
- `DEPBRIEF_USER_AGENT` — `depbrief/0.1 (your.email@example.com)`. Put a
  real address in it. Both weather services ask for one, and it is the
  difference between being throttled politely and being blocked.

Then deploy.

### 3. What the first boot does

The airports table starts empty, and an instance with an empty airports
table cannot resolve the first waypoint of any flight plan — it is not slow,
it is broken. So on first boot the service downloads the OurAirports
snapshot (~17 MB, about 27,000 aerodromes across Canada and the United
States) and loads it.

While that runs:

```
GET /api/health  →  503  {"ok": false, "airportData": "loading", "airports": 0}
POST /api/briefings  →  503  "this instance is still loading its airport data"
```

and when it finishes:

```
GET /api/health  →  200  {"ok": true, "airportData": "ready", "airports": 27560}
```

The port opens *before* the load starts, so Render sees a listening service
immediately rather than concluding the deploy failed. It happens once per
database, not once per deploy. If it fails, the service still serves and
`/api/health` says why in `reason`.

Watch the log for:

```
no airport data in the store; loading the OurAirports snapshot
loading 27,560 aerodromes from the 2026-09-19 snapshot
27,560 aerodromes loaded from the 2026-09-19 snapshot
```

### 4. Check it

```sh
curl https://<your-service>.onrender.com/api/health
curl https://<your-service>.onrender.com/api/airports/CYSN
```

Then a briefing:

```sh
curl -X POST https://<your-service>.onrender.com/api/briefings \
  -H 'content-type: application/json' \
  -d '{"plan":{"departure":"CYSN","route":[],"destination":"CYKF",
        "departureTime":"2026-09-19T14:00:00Z",
        "cruise":{"tas":110,"altitude":3500},
        "airspace":{"CYSN":"E","CYKF":"C"}},
       "profile":{"version":1,"name":"default","ceilingAglFt":2500,
        "visibilitySm":5,"crosswindKt":15,"crosswindIncludesGust":true}}'
```

At night this comes back with, among other things:

```
CYSN is not reporting at this hour; the conditions above are KIAG's, 11 nm away
```

which is the whole point.

---

## What a deployment changes about the code

Four things behave differently on a host than on a laptop, and each one was
a live instance that would have looked fine and not been.

**The database drops idle connections.** Any hosted Postgres closes a
connection that has been sitting there, and `pg` reports that on the pool
asynchronously with nothing awaiting it — an unhandled `error` event, which
is a process-level throw. Without a listener the first idle drop takes the
whole server down. There is one now.

**Loading 27,000 airports one row at a time is 27,000 round trips.** Over a
local socket that is a few seconds; against a database in another region it
is several minutes, long enough that a first boot looks hung. Inserts are
batched 500 to a statement, still inside one transaction.

**Behind a proxy, every visitor looks like the proxy.** `TRUST_PROXY=true`
makes Fastify read `X-Forwarded-For` instead — but that header is written by
whoever is calling, so anybody wanting more turns can claim to be somebody
else. Which is why there are two caps: a per-caller one (20/minute, a
courtesy between visitors, evadable) and an instance-wide one (120/minute,
keyed on nothing at all, and therefore the one the weather services can
actually rely on).

**A field that is asleep has nothing to borrow.** `observationAt` stands the
nearest current observation in for a field that is not reporting — the
recorded snapshot the page carries holds every station, so it works there. A
live instance fetches only the stations named in the plan, so asked about
CYSN at night it found nothing of its own, looked for a neighbour, and found
nothing at all: the feature silently absent on exactly the deployment it was
written for. Now, when a field has nothing current, one request asks the AWC
which stations are reporting in the surrounding box. Which ones those are is
not guessed from runway lengths or identifiers — it is what the service
answers. Once an hour per one-degree cell, however many briefings pass
through it.

And one bug that only a real database shows: **JSON has no date.** Decoded
records are stored as JSON, so a `Date` goes in and a string comes back,
which every type still calls a `Date` because the read site casts. In memory
the cast is harmless, so all 808 tests passed; against Postgres the second
briefing died in `upperWindFor` with `useFrom?.value.getTime is not a
function`. Upper winds and hazard advisories are the only two decoders that
put a `Date` inside their output, and both are revived at the read site now.

---

## The domain

All three of `departurebrief.com`, `departurebrief.ca` and
`departurebrief.dev` were free when checked directly at the registries on
19 September 2026 — Verisign's RDAP for `.com`, CIRA's for `.ca`, Google's
for `.dev`, each returning 404 with a known-registered control returning
200, so the 404 means what it says.

**Register `departurebrief.com` at Cloudflare Registrar: $10.46 a year,
first year and every year.** Cloudflare sells at wholesale with no markup
and no promotional first year, which is the whole trap in domain pricing —
`holdshort.xyz`, for comparison, is $1.00 to register at Namecheap and
$19.48 to renew. Take the `.ca` too if you want it ($9.19, and `.ca`
requires Canadian presence, which you have); it is the better address for a
CARs-first tool built by a Canadian, and $9 is not a decision.

### Why the project is not called Hold Short any more

`holdshort.com` belongs to **Holdshort Aviation Systems, LLC** — aircraft
scheduling software for flight schools and flying clubs. Registered in July
2004, renewed through 2032, with all four registrar locks set and a live
service behind a DigitalOcean load balancer. Not a domain that is for sale,
and more to the point, an operating aviation-software company with the same
name in the same industry.

This project is not competing with them — they do scheduling, this does
pre-flight information, and "hold short" is a standard ATC instruction that
nobody owns. But the cost is real: anyone searching the name
finds their product first. Renamed on 19 September 2026, before a domain was
attached rather than after.

### DNS, once you have one

Replace `<domain>` throughout.

Apex to GitHub Pages — all four A records and all four AAAA:

```
A     @   185.199.108.153        AAAA  @   2606:50c0:8000::153
A     @   185.199.109.153        AAAA  @   2606:50c0:8001::153
A     @   185.199.110.153        AAAA  @   2606:50c0:8002::153
A     @   185.199.111.153        AAAA  @   2606:50c0:8003::153

CNAME www   nberkyilmaz.github.io.
```

The `www` target is the **user** host. A CNAME target is a hostname and
cannot carry a path, so it is never `nberkyilmaz.github.io/departure-brief`.

The API subdomain:

```
CNAME api   <your-service>.onrender.com.
```

Add `api.<domain>` in Render (Settings → Custom Domains) **first** — it
shows you the exact target — then create the CNAME, then Verify. Render
issues and renews the certificate. A Hobby workspace includes two custom
domains, so this one is free. If your DNS is at Cloudflare, leave this record
DNS-only (grey cloud): proxying breaks Render's hostname validation.

### Four things to change in this repository when the domain is attached

1. **Settings → Pages → Custom domain**. Do not commit a `CNAME` file — this
   site deploys through a custom Actions workflow, where GitHub does not use
   one.

2. **[`.github/workflows/pages.yml`](../.github/workflows/pages.yml)** sets
   `VITE_BASE: /${{ github.event.repository.name }}/`, because a project
   site is served from `/departure-brief/`. On a custom domain the site is at the
   root, and leaving that line ships a page whose script, stylesheet and
   recorded reports all 404. Change it to `/` or delete it —
   `apps/web/vite.config.ts` already defaults to `/`.

3. **`DEPBRIEF_ALLOWED_ORIGINS`** on the Render service: add
   `https://<domain>`, comma separated. The page and the API are different
   origins, and an origin that is not on that list is refused by the browser
   before the server sees it.

4. **`ALLOWED_ORIGINS`** in [`apps/relay/wrangler.toml`](../apps/relay/wrangler.toml):
   add `https://<domain>` beside the GitHub address, then
   `npm run deploy -w apps/relay`. Same reason: a page the relay does not
   name cannot read its answers, and falls back to the recorded weather.

Then tick **Enforce HTTPS** in Settings → Pages once DNS has propagated. If
you chose a `.page`, `.dev` or `.app`, note that those are HSTS-preloaded:
browsers refuse plain HTTP outright, so during the certificate window the
site is unreachable rather than merely insecure. Wait; do not change DNS.

---

## Running it yourself

> **If you had the database before the rename**, its role and database are
> still called `holdshort` and the new default connection string looks for
> `depbrief`. Recreate the volume — it holds nothing but fetched weather
> and a few test rows, and the instance reloads the airport snapshot by
> itself on the next boot:
>
> ```sh
> docker compose down -v && npm run db:up
> ```
>
> Renaming in place is not worth documenting: `ALTER ROLE` refuses to
> rename the session user, and the cluster's bootstrap superuser cannot be
> dropped, so it takes a temporary third superuser to do at all. I found
> that out the hard way.

```sh
npm ci
npm run db:up                 # Postgres on 5433, from docker-compose.yml
cp .env.example .env          # put DATABASE_URL and a contact address in it
npm run build -w apps/web
npm start -w apps/api
```

Or the container exactly as the host runs it:

```sh
docker build -t depbrief .
docker run --rm -p 3000:3000 \
  -e DATABASE_URL=postgres://depbrief:depbrief@host.docker.internal:5433/depbrief \
  -e DEPBRIEF_USER_AGENT='depbrief/0.1 (you@example.com)' \
  depbrief
```

CI builds the image on every push, so a Dockerfile that would fail on the
host fails here first.
