/**
 * The page, driven the way a visitor drives it.
 *
 * The claim the published site makes is that it briefs in the browser: the
 * reports are carried, and changing a personal minimum rebuilds the verdict
 * here rather than fetching a different picture of one. That is not a claim
 * a build can check, so it is checked here — render the app, change a
 * minimum, and watch the verdict move.
 *
 * `fetch` is served from the files the build wrote, so this exercises the
 * same bundle the site loads.
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { App } from '../src/App.js';

const DEMO = join(__dirname, '..', 'public', 'demo');

beforeAll(() => {
  // Nothing carried over from another visit: each test starts as a stranger would.
  window.localStorage.clear();
  // The published site is static files; so is this.
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    const name = url.split('/').pop()!;
    try {
      return new Response(readFileSync(join(DEMO, name), 'utf8'), { status: 200, headers: { 'content-type': 'application/json' } });
    } catch {
      return new Response('not found', { status: 404 });
    }
  }) as typeof fetch;
});

// Each test arrives at the application fresh, as a visitor would.
beforeEach(() => {
  window.location.hash = '';
});

afterEach(cleanup);

/** The flight categories the briefing is showing, in route order. */
function categories(): string[] {
  return [...document.querySelectorAll('#verdict .point h3 .category:not(.forecast)')].map((e) => e.textContent ?? '');
}

/** How many lines are asking to be read, at each level. */
function attentionCounts(): { alert: number; caution: number } {
  return {
    alert: document.querySelectorAll('#verdict .finding.alert').length,
    caution: document.querySelectorAll('#verdict .finding.caution').length,
  };
}

/** Waits for the briefing to be on the page. */
async function briefed(): Promise<void> {
  await waitFor(() => expect(document.querySelector('#verdict .point')).not.toBeNull(), { timeout: 10_000 });
}

describe('the published page', () => {
  it('briefs the recorded flight in the browser, with no server', async () => {
    render(<App />);
    await briefed();
    // A classification of what was reported, not a decision about the flight.
    for (const c of categories()) expect(c).toMatch(/^(VFR|MVFR|IFR|LIFR)$/);
    // And nothing anywhere tells the pilot whether to go.
    expect(document.body.textContent).not.toMatch(/\bNO-GO\b/);

    // Not a picture of a briefing: the reports it was judged on are here,
    // and every finding can be opened to the span it cites.
    expect(await screen.findByText(/Reports this briefing was made from/i)).toBeTruthy();
    expect(screen.getByText(/Not for operational use\./i)).toBeTruthy();
  });

  it('flags more when a personal minimum tightens, and the sky is unchanged', async () => {
    render(<App />);
    await briefed();
    const before = attentionCounts();
    const sky = categories();

    // A visibility minimum no forecast is ever going to meet.
    const visibility = screen.getByLabelText(/Visibility \(SM\)/i);
    fireEvent.change(visibility, { target: { value: '99' } });

    await waitFor(() => expect(attentionCounts().alert).toBeGreaterThan(before.alert), { timeout: 10_000 });
    // The pilot's limit moved; the weather did not, so the category cannot.
    expect(categories()).toEqual(sky);
    expect(screen.getAllByText(/visibility/i).length).toBeGreaterThan(0);

    // Put it back, and the flag goes with it: nothing is sticky.
    fireEvent.change(visibility, { target: { value: '5' } });
    await waitFor(() => expect(attentionCounts().alert).toBe(before.alert), { timeout: 10_000 });
  });

  it('will not pretend to know an aerodrome it has no reports for', async () => {
    render(<App />);
    await briefed();
    // New York: a real aerodrome, and not one this page carries — it holds
    // Canada, which is a statement it should make rather than fail blankly.
    fireEvent.change(screen.getByLabelText(/Destination/i), { target: { value: 'KJFK' } });
    await waitFor(() => expect(document.querySelector('.error')?.textContent ?? '').toMatch(/KJFK/), { timeout: 10_000 });
  });

  it('shows the route as a strip, with the category at each point', async () => {
    render(<App />);
    await briefed();
    const points = [...document.querySelectorAll('.strip-point')];
    // Departure, destination and the alternate, in that order.
    expect(points.map((p) => p.querySelector('.strip-id')!.textContent)).toEqual(['CYSN', 'CYKF', 'alternate CYHM']);
    // Each carries its own classification, which is a fact about that field.
    for (const p of points) expect(p.querySelector('.category')!.textContent).toMatch(/^(VFR|MVFR|IFR|LIFR|—)$/);
    // And the distance between them, from the resolver's own numbers.
    expect(document.querySelectorAll('.strip-leg').length).toBe(points.length - 1);
    expect(document.querySelector('.strip-leg')!.textContent).toMatch(/^\d+ nm$/);
  });

  it('says plainly that the weather is frozen and it fetches nothing', async () => {
    render(<App />);
    await briefed();
    expect(screen.getByText(/The weather here is frozen/i)).toBeTruthy();
    expect(screen.getByText(/rebuilt in your browser/i)).toBeTruthy();
  });
});

describe('moving around it', () => {
  /*
   * Navigation is by hash, which is what a click on one of these links does
   * in a browser — jsdom does not follow them itself, so the links' targets
   * are checked and the address is then set the way the browser would set
   * it. What is being tested is the application's half: the right target on
   * the link, and the right page for the address.
   */
  function go(name: RegExp): void {
    const link = screen.getByRole('link', { name });
    const href = link.getAttribute('href')!;
    expect(href.startsWith('#/')).toBe(true);
    window.location.hash = href;
  }

  it('opens the reports it was judged on, in the words they arrived in', async () => {
    render(<App />);
    await briefed();

    go(/The reports/i);

    expect(await screen.findByRole('heading', { level: 2, name: /The reports/i })).toBeTruthy();
    // Every report the page holds, not only the ones the briefing cited.
    expect(document.querySelectorAll('.held').length).toBeGreaterThan(50);

    // Opening one shows the report itself, not a summary of it.
    fireEvent.click(document.querySelector('.held-row') as HTMLButtonElement);
    expect(document.querySelector('.held .raw')!.textContent!.length).toBeGreaterThan(10);
  });

  it('works the legs out, and says where a number is missing from', async () => {
    render(<App />);
    await briefed();

    go(/Nav log/i);
    expect(await screen.findByRole('heading', { level: 2, name: /Nav log/i })).toBeTruthy();

    const rows = [...document.querySelectorAll('.navlog-table .leg-name')].map((c) => c.textContent);
    expect(rows[0]).toBe('CYSN → CYKF');
    expect(rows.some((r) => r?.includes('alternate'))).toBe(true);

    // Every leg either has a groundspeed or says why it has not.
    for (const row of document.querySelectorAll('.navlog-table tbody tr')) {
      const cells = [...row.querySelectorAll('td')].map((c) => c.textContent ?? '');
      if (cells.length < 12) continue;
      const groundspeed = cells[8]!;
      if (groundspeed === '—') expect(row.nextElementSibling?.className).toContain('leg-gaps');
    }

    // No burn rate has been given, so there is no fuel column and it says so.
    expect(screen.getByText(/nothing here will invent a figure/i)).toBeTruthy();
  });

  it('carries what is waiting to be read from every page, as a count and not a verdict', async () => {
    render(<App />);
    await briefed();
    const waiting = attentionCounts().alert + attentionCounts().caution;

    go(/Weight and balance/i);
    await waitFor(() => expect(document.querySelector('.wb')).not.toBeNull());

    const chip = document.querySelector('.nav-attention');
    if (waiting === 0) {
      // Nothing to read is not something to badge.
      expect(chip).toBeNull();
      return;
    }
    // A count of what is waiting, never a word about whether to go.
    expect(chip!.textContent).toMatch(/^\d+ to look at$/);
    expect(chip!.textContent).not.toMatch(/GO|NO-GO|MARGINAL/);
    expect(chip!.getAttribute('href')).toBe('#/brief');

    window.location.hash = chip!.getAttribute('href')!;
    await waitFor(() => expect(document.querySelector('#verdict .point')).not.toBeNull());
  });

  it('lands on the page an address names, and says which one it is on', async () => {
    window.location.hash = '#/about';
    render(<App />);

    expect(await screen.findByRole('heading', { level: 2, name: /What this is/i })).toBeTruthy();
    const current = [...document.querySelectorAll('.nav a[aria-current="page"]')].map((a) => a.textContent);
    expect(current).toEqual(['How this works']);

    // An address that names nothing lands on the briefing rather than nowhere.
    window.location.hash = '#/nonsense';
    await waitFor(() => expect(document.querySelector('.inputs')).not.toBeNull());
  });
});
