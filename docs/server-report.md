# Server report, 25 November 2026

The API is running on the Hetzner server, always on, and waits only for its DNS record. Hours to
Go stays on Render for now: there's a plan and the code it needs, but not a safe way to move the
pilots' data tonight. Details below; how the server works day to day is in
[`deploy/server/README.md`](../deploy/server/README.md).

## What you need to do

1. **The DNS record.** Cloudflare → `nberkyilmaz.com` → DNS → Add record:

   | Type | Name | IPv4 address | Proxy status | TTL |
   | --- | --- | --- | --- | --- |
   | `A` | `depbrief-api` | `5.75.174.24` | **DNS only** (grey cloud) | Auto |

   Nothing else. It must be DNS only: Caddy gets the certificate from Let's Encrypt by answering
   on port 80 itself. Within five minutes of the record existing, the server notices it, restarts
   Caddy so it asks for the certificate at once, and (after step 2) pushes **"HTTPS is live"** to
   your phone. Then <https://depbrief-api.nberkyilmaz.com/api/health> answers
   `{"ok":true,...}`, and the hourly Watch workflow starts checking it from outside too.

2. **The ntfy topic for alerts.** The server's check couldn't take it from the other job's
   settings, so it's saved separately. Use the same topic as the other job (or a new one your phone
   subscribes to):

   ```sh
   ssh -i ~/.ssh/<the server key> root@5.75.174.24
   server-ntfy-topic
   ```

   It asks for the topic without showing it, saves it readable by root only, and sends a test
   push. Until then alerts only go to `/var/log/server-check.log`.

3. **Hours to Go's backups, soon.** Its nightly copy of Neon has never run: the workflow is still
   pull request #1 in `hours-to-go-backups`, and that repository has no `DATABASE_URL` secret. Add
   the secret (Hours to Go's deploy.md, step 8), merge the pull request, then **Actions → Backup →
   Run workflow** and check it goes green. The privacy page already promises these copies.

4. **Decide on moving Hours to Go** (below, and `hours-to-go/docs/server-move.md`).

5. Optional: turn off SSH password logins. Nobody can use them now (root and the other account
   have no password, and root takes keys only), but the server logged about 1,350 password guesses
   in twelve hours. As root: `echo 'PasswordAuthentication no' > /etc/ssh/sshd_config.d/10-no-passwords.conf && sshd -t && systemctl reload ssh`,
   then check a new `ssh` session gets in before closing the old one.

## What's done

**The API**, in Docker beside its own Postgres 16, behind Caddy, set up from
[`deploy/server`](../deploy/server). Tested from outside, against the server's address, before
DNS: through the firewall and Caddy (with a temporary test certificate) `/api/health` answers 200,
an aerodrome lookup answers, the page loads, and a real briefing (CYSN to CYKF) was assembled and
stored in 7.6 seconds. The API sees each visitor's real address through Caddy, so its
per-visitor limit works. Ports 3000 and 5432 are closed from outside. 27,551 aerodromes are
loaded. It settles at about 130 MB.

**Kept away from the other job.** The API, Postgres and Caddy have hard memory caps (768, 512
and 128 MB, no swap), CPU caps (1, 0.75 and 0.5 cores), a quarter of the normal CPU weight so the
other job wins any contest for the processor, and a raised OOM score so the kernel would stop
them first. The server also got a 2 GB swap file as a cushion for everything outside Docker. Its
cron entry and files weren't touched. I checked its log after each change; it doesn't run
between 11 pm and 7 am, so the real test was its 7:00 run (see the end). The account it runs as
can still reach the web and the mail server.

**Firewall.** ufw lets in only TCP 22, 80 and 443 (22 added first), on IPv4 and IPv6; everything
going out is allowed, as before.
Docker publishes ports around ufw, so nothing except Caddy publishes one publicly; Postgres
isn't published at all, and the API only on the server's loopback.

**Automatic updates.** Ubuntu's security updates were already installing themselves daily. Added:
when one needs a restart (a new kernel), the server restarts at 04:30, after the backup and
outside the other job's hours. I restarted the server once to prove it: every container came back
healthy by itself, with the firewall, swap and both cron files in place.

**Backups**, the Hours to Go pattern turned around, since this database can't be reached from
GitHub. Every night at 03:23 the server dumps the database, restores the dump into a scratch
database and counts every table, then pushes it to the new private repository
[`nberkyilmaz/departure-brief-backups`](https://github.com/nberkyilmaz/departure-brief-backups)
as the branch `copy/YYYY-MM-DD`. It pushes with a deploy key that can write to that one repository
and nothing else. A workflow there restores the newest copy again every day, checks it against
its manifest, deletes copies older than 90 days, and fails (GitHub emails you) if the newest copy
is missing, more than 26 hours old, or damaged. So it also notices from outside if the server
stops. The first copy (3.0 MB, 10 tables) was made and restored on the server, then restored again
on GitHub, where it matched. The last seven copies also stay on the server. How to restore is in
that repository's README: into a new database first, then a swap that keeps the old one as the
way back.

**Uptime check.** Every five minutes the server checks the API, then (once the DNS record exists)
the API through Caddy over HTTPS and the certificate's expiry, plus the disk and the backup's age.
A problem must show twice in a row before it's pushed; then one push when it starts, one when it
clears, and a reminder every six hours. Pushes go to ntfy.sh the same way the other job's do. The
alert and recovery logic was tested by stopping the API, and delivery by a real push to a
throwaway topic, read back from ntfy. The hourly **Watch** workflow now asks the API's health from
GitHub as well, for when the whole server is down; it notes "no DNS record yet" and passes until
step 1 is done.

**The live page isn't pointed at the API**, on purpose. `pages.yml` has no setting for it: the
published page runs the whole briefing in the browser from the relay, and there is no API mode
in the published build to switch on. Adding one is a code change, and until the DNS record and
certificate exist every call to the API would fail. Meanwhile the API serves its own copy of the
site at its address, with briefings stored on the server, so it's usable as soon as DNS is in.

## Hours to Go

**Decision: move it to this server, but not yet.** Why move: the free Render service sleeps,
and that night it took 27 seconds to answer from asleep; this server is already paid for and
has room. Why not tonight:

- its database can't be copied without the Neon connection string, which only you can get;
- the nightly backups (step 3 above) aren't running, and those come first;
- its privacy page says every service is in the United States (Neon and Render, in Ohio). This
  server is in Germany, so the page, in English and French, must say so before pilots' data moves.
  Your open pull request #43 edits the same page.

The full reasoning, the alternatives (Render Starter at $7 a month ends the wait with no move),
the steps, and the way back (Neon stays untouched until the move is proven) are in
`hours-to-go/docs/server-move.md`.

**Built tonight**, on `main`, with tests:

- `TRUST_PROXY`: behind Caddy, the per-network limits on sign-up, sign-in, resets and feedback
  now count the address Caddy saw. Before, they believed a `CF-Connecting-IP` header, which only
  Cloudflare on Render can be trusted to write; behind Caddy any client could have written its
  own and dodged every limit. Unset on Render, so nothing changes there.
- A clean stop: the server closes on SIGTERM instead of ignoring it, so a deploy or
  `docker stop` lets requests finish rather than killing them after ten seconds. CI now checks it.
  The image was built and run on this server's ARM processor, where it stopped in one second.
- The Reminders workflow fails, and so emails you, when any reminder email couldn't be sent.
  Before, it went green regardless.
- The runbook lists every setting the server reads, and the right number of tests.

**Left for later**, because your pull request #43 is changing the same screens and they'd
collide with it: the 12-month flight review, "days since the last flight", a shorter Progress
page on phones, and the other "not built yet" items in its roadmap. Clearing out expired sessions
and share links would change the live database, so that waits until the backups run.

## What it costs

| | Monthly |
| --- | --- |
| Hetzner CAX11 (2 vCPU ARM, 4 GB, 40 GB disk) with its IPv4 address | about €6.50 before tax at 2026 prices (€5.99 + €0.50); already paid for the other job, so the API adds nothing. Check the invoice for the exact figure. |
| Certificates (Let's Encrypt), Caddy, Docker, ntfy.sh | free |
| Private backups repository and its daily workflow | free: about a minute a day of GitHub's 2,000 free Actions minutes; copies are ordinary files, about 3 MB a night now, so about 300 MB for 90 days |
| Hours to Go | still free on Render and Neon; €0 more if moved here, or $7 for Render Starter |

The copies grow with the stored briefings. If 90 of them ever approach 1 GB, keep fewer days
(the cutoff in the backups repository's `restore.yml`).

## The other job's 7:00 run

It ran at 7:00, 7:07 and 7:15 as usual, and each run finished normally with no errors. The 7:07
run had two things to push to your phone, so you should have that notification as a check. At
7:00 one of the sites it reads didn't answer, as happened once yesterday evening too; at 7:15 it
read every one.

Memory after those runs: 618 MB of 3.8 GB in use, and the swap file untouched. The API was using
135 MB, Postgres 57 MB and Caddy 51 MB.
