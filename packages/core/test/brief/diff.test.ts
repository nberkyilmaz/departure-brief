/**
 * Briefing diff. Built on the recorded reports, so the "weather changed"
 * cases are real changes: the six-hour KJFK history gives two genuine
 * observations of the same field, an hour apart.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { assembleBriefing } from '../../src/brief/assemble.js';
import { diffBriefings } from '../../src/brief/diff.js';
import { diffText } from '../../src/brief/describeDiff.js';
import { parseFlightPlan } from '../../src/domain/flight.js';
import { parseAircraftLimits, parsePilotProfile } from '../../src/domain/profile.js';
import { AWC_BASE_URL, AwcClient } from '../../src/fetch/awc.js';
import { storeAndDecode } from '../../src/store/decode.js';
import { readNasrDirectory } from '../../src/fetch/nasr.js';
import { NAVCANADA_CFPS_BASE_URL, NavCanadaClient } from '../../src/fetch/navcanada.js';
import { readOurAirportsDirectory } from '../../src/fetch/ourairports.js';
import { notamsForFlight } from '../../src/notam/flight.js';
import { resolveFlight } from '../../src/resolve/flight.js';
import { MemoryStore } from '../../src/store/memory.js';
import { FIXTURES, replayHttp } from '../helpers/http.js';

const ROOT = join(__dirname, '..', '..', '..', '..');
const plan = parseFlightPlan(JSON.parse(readFileSync(join(ROOT, 'flights', 'demo-kteb-khpn.json'), 'utf8')));
const profile = parsePilotProfile(JSON.parse(readFileSync(join(ROOT, 'profiles', 'default.json'), 'utf8')));
const aircraft = parseAircraftLimits(JSON.parse(readFileSync(join(ROOT, 'aircraft', 'c172.json'), 'utf8')));

/*
 * Three instants over one real morning at KJFK. Everything is stored up
 * front, so what differs between briefings is only what had been *issued*
 * by each instant — the same thing that separates two real briefings of the
 * same flight an hour apart.
 *
 *   11:00Z  the TAFs (issued 1138Z) do not exist yet; KJFK's latest
 *           observation is 1051Z, 33005KT.
 *   11:45Z  the TAFs are out; KJFK is still on the 1051Z observation.
 *   12:30Z  KJFK's 1151Z observation has arrived, 34007KT.
 */
const T_NO_FORECAST = new Date('2026-09-07T11:00:00Z');
const T_MID = new Date('2026-09-07T11:45:00Z');
const T_AFTER = new Date('2026-09-07T12:30:00Z');

async function seeded(): Promise<MemoryStore> {
  const store = new MemoryStore();
  await store.putAirports(readNasrDirectory(join(FIXTURES, 'nasr', '2026-09-03')));
  const awc = new AwcClient(
    replayHttp({
      [`${AWC_BASE_URL}/metar?ids=KJFK&format=json&hours=6`]: { status: 200, file: 'awc/metar-KJFK-6h.json' },
      [`${AWC_BASE_URL}/metar?ids=KJFK,KTEB,KHPN&format=json`]: { status: 200, file: 'awc/metar-KJFK-KTEB-KHPN.json' },
      [`${AWC_BASE_URL}/taf?ids=KJFK,KTEB,KHPN&format=json`]: { status: 200, file: 'awc/taf-KJFK-KTEB-KHPN.json' },
    }),
  );
  const stored = new Date('2026-09-07T10:00:00Z');
  const history = await awc.metars(['KJFK'], { hours: 6 });
  await storeAndDecode(store, history.reports, history.request, stored);
  const m = await awc.metars(['KJFK', 'KTEB', 'KHPN']);
  await storeAndDecode(store, m.reports, m.request, stored);
  const t = await awc.tafs(['KJFK', 'KTEB', 'KHPN']);
  await storeAndDecode(store, t.reports, t.request, stored);
  return store;
}

async function brief(store: MemoryStore, asOf: Date, p = profile) {
  const resolved = await resolveFlight(store, plan, asOf);
  return assembleBriefing(resolved, p, aircraft);
}

describe('diffBriefings', () => {
  it('an unchanged situation is quiet: same hash, no verdict move, nothing to report', async () => {
    const store = await seeded();
    const b = await brief(store, T_AFTER);
    const again = await brief(store, T_AFTER);
    expect(again.sha256).toBe(b.sha256);
    const d = diffBriefings(b, again);
    expect(d.quiet).toBe(true);
    expect(d.verdict).toBeNull();
    expect(d.points.every((p) => p.changes.length === 0)).toBe(true);
    expect(d.reports.added).toEqual([]);
    expect(diffText(d)).toContain('Nothing material changed');
  });

  it('a forecast arriving where there was none moves the verdict and resolves the coverage findings', async () => {
    const store = await seeded();
    const before = await brief(store, T_NO_FORECAST);
    const after = await brief(store, T_AFTER);
    expect(before.document.briefing.verdict).toBe('marginal');
    expect(after.document.briefing.verdict).toBe('go');

    const d = diffBriefings(before, after);
    expect(d.quiet).toBe(false);
    expect(d.verdict).toEqual({ from: 'marginal', to: 'go' });
    const teb = d.points.find((p) => p.waypoint === 'KTEB')!;
    expect(teb.verdict).toEqual({ from: 'marginal', to: 'go' });
    const resolvedCoverage = teb.changes.find((c) => c.rule === 'forecast.coverage')!;
    expect(resolvedCoverage.kind).toBe('resolved');
    expect(resolvedCoverage.crossesLimit).toBe(true);
    // The checks that only the forecast can answer are new.
    expect(teb.changes.some((c) => c.kind === 'appeared' && c.rule === 'personal.visibility' && c.basisKind === 'prevailing')).toBe(true);
    // The TAFs and the newer observations are new inputs; KJFK's superseded
    // 1051Z observation is no longer one, and the diff says so.
    expect(d.reports.added.filter((r) => r.kind === 'taf').length).toBe(3);
    expect(d.reports.removed.map((r) => [r.station, r.issuedAt])).toEqual([['KJFK', '2026-09-07T10:51:00.000Z']]);

    const text = diffText(d);
    expect(text).toContain('VERDICT MARGINAL -> GO');
    expect(text).toContain('KTEB: MARGINAL -> GO');
  });

  it('a newer observation of the same field is matched to the old one, not counted as a new finding', async () => {
    const store = await seeded();
    // Both briefings know a KJFK observation, but different ones: 1051Z then 1151Z.
    const before = await brief(store, T_MID);
    const after = await brief(store, T_AFTER);
    const kjfk = diffBriefings(before, after).alternate!;
    const observed = kjfk.changes.filter((c) => c.basisKind === 'observed');
    expect(observed.length).toBeGreaterThan(0);
    // Same rule, same waypoint, same kind of evidence — a restatement, not an appear+resolve pair.
    expect(observed.every((c) => c.kind === 'restated')).toBe(true);
    expect(observed.some((c) => c.before!.summary !== c.after!.summary)).toBe(true);
    expect(observed.every((c) => c.crossesLimit === false)).toBe(true);
  });

  it('a value that moves without crossing a limit is not news; the same move against a tighter limit is', async () => {
    const store = await seeded();
    /*
     * KJFK's wind goes 33005KT → 34007KT between the two instants. On its
     * best runway that is 2.4 kt of crosswind, then 4.4 kt: a real change,
     * and nowhere near the owner's 15 kt limit.
     */
    const loose = diffBriefings(await brief(store, T_MID), await brief(store, T_AFTER));
    expect([...loose.points, loose.alternate!].flatMap((p) => p.changes).filter((c) => c.crossesLimit)).toEqual([]);
    const restated = loose.alternate!.changes.find((c) => c.rule === 'crosswind.personal' && c.basisKind === 'observed')!;
    expect(restated.kind).toBe('restated');
    expect(restated.before!.values['crosswindKt']).not.toBe(restated.after!.values['crosswindKt']);

    // The same two moments, judged against a 3 kt limit that falls between them.
    const tight = parsePilotProfile({ name: 'tight', ceilingAglFt: 2500, visibilitySm: 5, crosswindKt: 3 });
    const d = diffBriefings(await brief(store, T_MID, tight), await brief(store, T_AFTER, tight));
    const crossing = d.alternate!.changes.find((c) => c.rule === 'crosswind.personal' && c.basisKind === 'observed')!;
    expect(crossing.kind).toBe('worsened');
    expect(crossing.crossesLimit).toBe(true);
    expect(crossing.before!.severity).toBe('ok');
    // Marginal rather than no-go: that observation is over 90 minutes before
    // the alternate's ETA, so it is context, not hard evidence.
    expect(crossing.after!.severity).toBe('marginal');
    expect(d.quiet).toBe(false);
    expect(diffText(d)).toContain('**');
  });

  it('warns when the two briefings are not like for like', async () => {
    const store = await seeded();
    const a = await brief(store, T_AFTER);
    const b = await brief(store, T_AFTER, parsePilotProfile({ name: 'strict', ceilingAglFt: 5000, visibilitySm: 10, crosswindKt: 3 }));
    expect(diffBriefings(a, b).warnings.join(' ')).toContain('different profiles');

    const other = parseFlightPlan({ ...plan, departureTime: '2026-09-08T13:00:00.000Z' });
    const c = assembleBriefing(await resolveFlight(store, other, T_AFTER), profile, aircraft);
    expect(diffBriefings(a, c).warnings.join(' ')).toContain('different flights');
  });

  it('tolerates a briefing written before findings carried a basis kind', async () => {
    const store = await seeded();
    const after = await brief(store, T_AFTER);
    const legacy = JSON.parse(JSON.stringify(after)) as typeof after;
    for (const p of legacy.document.briefing.points) for (const f of p.findings) delete (f as { basisKind?: unknown }).basisKind;
    const d = diffBriefings(legacy, after);
    // Every finding still matches its counterpart, so nothing looks new.
    expect(d.points.flatMap((p) => p.changes).filter((c) => c.kind === 'appeared' || c.kind === 'resolved')).toEqual([]);
  });
});

describe('diffBriefings — NOTAMs', () => {
  const caPlan = parseFlightPlan(JSON.parse(readFileSync(join(ROOT, 'flights', 'demo-cysn-cykf.json'), 'utf8')));
  const cfps = Object.fromEntries(['CYSN', 'CYKF', 'CYHM'].map((s) => [`${NAVCANADA_CFPS_BASE_URL}?site=${s}&alpha=notam`, { status: 200, file: `../notam/navcanada/2026-09-12/${s}.json` }]));
  const caAwc = Object.fromEntries(['CYSN', 'CYKF', 'CYHM'].flatMap((s) => [[`${AWC_BASE_URL}/metar?ids=${s}&format=json`, { status: 204 }], [`${AWC_BASE_URL}/taf?ids=${s}&format=json`, { status: 204 }]]));

  it('reports NOTAMs that appeared since the last briefing', async () => {
    const store = new MemoryStore();
    await store.putAirports(readOurAirportsDirectory(join(FIXTURES, 'ourairports', '2026-09-07'), { snapshot: '2026-09-07' }));
    const awc = new AwcClient(replayHttp(caAwc));
    for (const s of ['CYSN', 'CYKF', 'CYHM']) {
      const m = await awc.metars([s]);
      await storeAndDecode(store, m.reports, m.request, new Date('2026-09-12T12:00Z'));
    }
    const asOf = new Date('2026-09-12T20:00:00Z');
    const resolved = await resolveFlight(store, caPlan, asOf);

    // First briefing: no NOTAM source configured at all.
    const before = assembleBriefing(resolved, profile, aircraft, new Date(), null);
    // Second: NOTAMs fetched.
    const nb = await notamsForFlight({ store, navcanada: new NavCanadaClient(replayHttp(cfps)), now: () => asOf }, resolved, 'C172');
    const after = assembleBriefing(resolved, profile, aircraft, new Date(), nb);

    const d = diffBriefings(before, after);
    expect(d.notams.length).toBe(nb.items.length);
    expect(d.notams.every((n) => n.kind === 'new')).toBe(true);
    expect(d.quiet).toBe(false);
    const closure = d.notams.find((n) => n.id === 'J5067/26')!;
    expect(closure.summary).toContain('RWY 11/29 CLSD');
    expect(closure.notable).toBe(true);
    expect(diffText(d)).toContain('NOTAMs:');
    // A NOTAM outside the flight's window is listed but not flagged for attention.
    const outOfScope = d.notams.find((n) => n.to === 'out-of-scope')!;
    expect(outOfScope.notable).toBe(false);

    // With nothing but out-of-scope NOTAMs arriving, the diff stays quiet.
    const onlyDull = { ...after, document: { ...after.document, notams: { ...after.document.notams!, items: after.document.notams!.items.filter((i) => i.rank === 'out-of-scope') } } };
    expect(diffBriefings(before, onlyDull).quiet).toBe(true);

    // And the reverse: NOTAMs that are gone are reported but do not by themselves make a diff loud.
    const back = diffBriefings(after, before);
    expect(back.notams.every((n) => n.kind === 'gone')).toBe(true);
    expect(back.quiet).toBe(true);
  });
});
