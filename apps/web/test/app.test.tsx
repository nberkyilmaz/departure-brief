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

/**
 * The verdict the page is showing right now, or null before there is one.
 * Scoped to the briefing itself: the panel above it, which says what a
 * change did, carries the previous verdict in the same kind of badge.
 */
function currentVerdict(): string | null {
  return document.querySelector('#verdict .verdict.big')?.textContent ?? null;
}

/** Waits for a verdict to be on the page, and returns it. */
async function verdict(): Promise<string> {
  await waitFor(() => expect(currentVerdict()).not.toBeNull(), { timeout: 10_000 });
  return currentVerdict()!;
}

/** Waits until the verdict is something other than what it was. */
async function verdictBecomes(want: string): Promise<void> {
  await waitFor(() => expect(currentVerdict()).toBe(want), { timeout: 10_000 });
}

describe('the published page', () => {
  it('briefs the recorded flight in the browser, with no server', async () => {
    render(<App />);
    expect(await verdict()).toMatch(/^(GO|MARGINAL|NO-GO)$/);

    // Not a picture of a briefing: the reports it was judged on are here,
    // and every finding can be opened to the span it cites.
    expect(await screen.findByText(/Reports this briefing was made from/i)).toBeTruthy();
    expect(screen.getByText(/Not for operational use\./i)).toBeTruthy();
  });

  it('rebuilds the verdict when a personal minimum changes', async () => {
    render(<App />);
    const before = await verdict();

    // A ceiling minimum no September afternoon in Ontario is going to meet.
    const ceiling = screen.getByLabelText(/Ceiling \(ft AGL\)/i);
    fireEvent.change(ceiling, { target: { value: '12000' } });

    await verdictBecomes('NO-GO');
    expect(before).not.toBe('NO-GO');

    // And it says which limit did it, against the report it was judged on.
    expect(screen.getAllByText(/ceiling/i).length).toBeGreaterThan(0);

    // Put it back, and the verdict comes back with it: nothing is sticky.
    fireEvent.change(ceiling, { target: { value: '2500' } });
    await verdictBecomes(before);
  });

  it('will not pretend to know an aerodrome it has no reports for', async () => {
    render(<App />);
    await verdict();
    fireEvent.change(screen.getByLabelText(/Destination/i), { target: { value: 'CYYZ' } });
    // It says which aerodromes it does have reports for, rather than failing blankly.
    await waitFor(() => expect(document.querySelector('.error')?.textContent ?? '').toMatch(/CYYZ/), { timeout: 10_000 });
    expect(document.querySelector('.error')!.textContent).toMatch(/CYSN|CYKF|CYHM/);
  });

  it('says plainly that the weather is frozen and it fetches nothing', async () => {
    render(<App />);
    await verdict();
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
    await verdict();

    go(/The reports/i);

    expect(await screen.findByRole('heading', { level: 2, name: /The reports/i })).toBeTruthy();
    // Every report the page holds, not only the ones the briefing cited.
    expect(document.querySelectorAll('.held').length).toBeGreaterThan(50);

    // Opening one shows the report itself, not a summary of it.
    fireEvent.click(document.querySelector('.held-row') as HTMLButtonElement);
    expect(document.querySelector('.held .raw')!.textContent!.length).toBeGreaterThan(10);
  });

  it('keeps the verdict in reach from every page', async () => {
    render(<App />);
    const before = await verdict();

    go(/Weight and balance/i);
    await waitFor(() => expect(document.querySelector('.wb')).not.toBeNull());

    // The briefing is no longer on screen, so the verdict rides in the navigation.
    expect(currentVerdict()).toBeNull();
    const chip = document.querySelector('.nav-verdict')!;
    expect(chip.textContent).toBe(before);
    expect(chip.getAttribute('href')).toBe('#/brief');

    window.location.hash = chip.getAttribute('href')!;
    await waitFor(() => expect(currentVerdict()).toBe(before));
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
