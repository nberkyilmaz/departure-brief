/**
 * The published demo's claim is that the page builds the briefing itself
 * from the recorded reports, rather than showing a picture of one built
 * elsewhere. This is that claim, tested: load the bundle into an empty
 * store, run the pipeline, and the briefing that comes out must be the
 * same briefing — by its content hash, which covers every finding, every
 * citation and every report it cites.
 *
 * If this ever fails, the page and the build disagree about what the
 * reports mean, and one of them is lying to a pilot.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { assembleBriefing } from '../../src/brief/assemble.js';
import type { StoredBriefing } from '../../src/brief/types.js';
import { BundleIntegrityError, loadBundle, type DemoBundle } from '../../src/demo/bundle.js';
import { parseFlightPlan } from '../../src/domain/flight.js';
import { parseAircraftLimits, parsePilotProfile } from '../../src/domain/profile.js';
import type { LLMProvider } from '../../src/llm/provider.js';
import { notamsForFlight } from '../../src/notam/flight.js';
import { withHandbookLimits } from '../../src/wb/aircraft.js';
import type { WeightBalanceSpec } from '../../src/wb/types.js';
import { resolveFlight } from '../../src/resolve/flight.js';
import { MemoryStore } from '../../src/store/memory.js';

const DEMO = join(__dirname, '..', '..', '..', '..', 'apps', 'web', 'public', 'demo');
const read = <T,>(name: string): T => JSON.parse(readFileSync(join(DEMO, name), 'utf8')) as T;

/**
 * A provider that cannot answer. Recorded answers are read from the store
 * before a provider is ever called, so this returns everything that was
 * assessed when the demo was built and nothing else — which is exactly
 * what a browser can honestly do.
 */
const noModel: LLMProvider = {
  id: 'none',
  async complete() {
    throw new Error('no model runs here');
  },
};

async function rebuild(bundle: DemoBundle): Promise<StoredBriefing> {
  const store = new MemoryStore();
  await loadBundle(store, bundle);
  const plan = parseFlightPlan(bundle.plan);
  const profile = parsePilotProfile(bundle.profile);
  // The handbook's demonstrated crosswind, with its citation, exactly as the
  // page does it from the weight-and-balance spec published beside the bundle.
  const aircraft = withHandbookLimits(parseAircraftLimits(bundle.aircraft), read<WeightBalanceSpec>('wb.json'));
  const asOf = new Date(bundle.asOf);
  const resolved = await resolveFlight(store, plan, asOf);
  const notams = await notamsForFlight({ store, navcanada: null, provider: noModel, model: bundle.model, now: () => asOf }, resolved, aircraft.type);
  return assembleBriefing(resolved, profile, aircraft, asOf, notams);
}

describe('the demo bundle', () => {
  const bundle = read<DemoBundle>('bundle.json');
  const published = read<StoredBriefing>('briefing.json');

  it('rebuilds the published briefing exactly, with no database and no model', async () => {
    const rebuilt = await rebuild(bundle);
    // Compared field by field first, so a failure says what moved rather
    // than only that two hashes differ.
    expect(rebuilt.document.briefing.verdict).toBe(published.document.briefing.verdict);
    expect(rebuilt.document.briefing.points).toEqual(published.document.briefing.points);
    expect(rebuilt.document.notams?.counts).toEqual(published.document.notams?.counts);
    expect(rebuilt.document.inputs.reports).toEqual(published.document.inputs.reports);
    expect(rebuilt.sha256).toBe(published.sha256);
  });

  it('carries the reports themselves, not a summary of them', () => {
    const notams = bundle.reports.filter((r) => r.kind === 'notam');
    expect(bundle.reports.filter((r) => r.kind === 'metar').length).toBeGreaterThan(10);
    expect(bundle.reports.filter((r) => r.kind === 'taf').length).toBeGreaterThan(0);
    expect(notams.length).toBeGreaterThan(10);
    // A NOTAM's text is the NOTAM, in the form a pilot would be handed it.
    expect(notams.some((r) => r.body.includes('Q)') && r.body.includes('E)'))).toBe(true);
    // FIR-wide NOTAMs belong to no aerodrome but were fetched for several.
    expect(notams.some((r) => r.station === null && r.fetchedFor.length > 1)).toBe(true);
  });

  it('refuses a report whose bytes do not match the name it arrived under', async () => {
    const first = bundle.reports.find((r) => r.kind === 'metar')!;
    const tampered: DemoBundle = {
      ...bundle,
      reports: [{ ...first, body: first.body.replace('KT', 'KT ') }],
    };
    await expect(rebuild(tampered)).rejects.toThrow(BundleIntegrityError);
  });
});
