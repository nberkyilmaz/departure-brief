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
  window.location.hash = '#/brief';
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

    go(/^The reports$/i);

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

    go(/^Nav log$/i);
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

    go(/^Aircraft$/i);
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

    // An address that names nothing lands on the way in, not on a blank.
    window.location.hash = '#/nonsense';
    await waitFor(() => expect(document.querySelector('.start')).not.toBeNull());
  });
});

describe('fuel', () => {
  it('shows the CARs 602.88 sum, and says what it is missing rather than inventing it', async () => {
    window.location.hash = '#/navlog';
    render(<App />);

    await waitFor(() => expect(document.querySelector('.fuel')).not.toBeNull(), { timeout: 10_000 });
    const table = document.querySelector('.fuel')!.textContent ?? '';
    // The regulation, named, with which subsection and why.
    expect(table).toMatch(/CARs 602\.88\(\d\)/);
    expect(table).toMatch(/Reserve, (30|45) min at cruise/);
    expect(table).toMatch(/Required at departure/);

    /*
     * Neither the burn rate nor the fuel aboard is in the repository, so
     * every figure is a dash and the reason is printed underneath. A
     * plausible number here would be the one thing this must never do.
     */
    const section = document.querySelector('.navlog-page')!.textContent ?? '';
    expect(section).toMatch(/no cruise burn rate in the aircraft file/i);
    expect(section).toMatch(/no fuel aboard given in the flight plan/i);
  });
});

describe('a field of its own', () => {
  it('reports on an aerodrome with no flight plan in existence', async () => {
    window.location.hash = '#/aerodrome/CYSN';
    render(<App />);

    expect(await screen.findByRole('heading', { level: 2, name: /CYSN/ }, { timeout: 10_000 })).toBeTruthy();
    // The classification, the raw report, and the runways — about the place.
    await waitFor(() => expect(document.querySelector('.aerodrome-page .raw')).not.toBeNull(), { timeout: 10_000 });
    expect(document.querySelector('.aerodrome-page .raw')!.textContent).toContain('METAR');
    expect(screen.getByRole('heading', { name: 'Runways' })).toBeTruthy();
    // And the wind resolved onto each of them, which is the first thing a
    // pilot works out about a field and used to be left as an exercise.
    expect(screen.getByRole('heading', { name: /Wind on the runways/i })).toBeTruthy();
    // Never a form: looking a field up does not require planning a flight.
    expect(document.querySelector('.inputs')).toBeNull();
  });

  it('resolves the wind onto every runway, most into wind first', async () => {
    window.location.hash = '#/aerodrome/CYSN';
    render(<App />);

    await waitFor(() => expect(document.querySelector('.runway-wind')).not.toBeNull(), { timeout: 10_000 });
    const table = document.querySelector('.runway-wind')!;
    const rows = [...table.querySelectorAll('tbody tr')];
    expect(rows.length).toBeGreaterThan(1);

    // Ordered, never filtered: every end with a heading is on the page.
    expect(rows[0]!.className).toContain('best');
    expect(rows[0]!.textContent).toContain('most into wind');
    expect(rows.slice(1).every((r) => !r.className.includes('best'))).toBe(true);

    // A component in knots against each one, not a runway heading to subtract.
    expect(table.textContent).toMatch(/\d+ kt/);
  });

  it('reads the observation back in words, pointing at the report it came from', async () => {
    window.location.hash = '#/aerodrome/CYSN';
    render(<App />);

    await waitFor(() => expect(document.querySelector('.decoded')).not.toBeNull(), { timeout: 10_000 });
    const rows = [...document.querySelectorAll('.decoded-row')];
    expect(rows.length).toBeGreaterThan(3);

    // Plain words, not the codes repeated back.
    const text = document.querySelector('.decoded')!.textContent ?? '';
    expect(text).toMatch(/Wind/);
    expect(text).toMatch(/Observed/);

    // The raw report is still there in full: the decode is an aid to
    // reading it, never a replacement for it.
    const raw = document.querySelector('.aerodrome-page .raw')!.textContent ?? '';
    expect(raw).toContain('METAR');

    // Hovering a line lights up the characters it was read from.
    expect(document.querySelector('.aerodrome-page .raw mark')).toBeNull();
    fireEvent.mouseEnter(rows[0]!);
    await waitFor(() => expect(document.querySelector('.aerodrome-page .raw mark')).not.toBeNull());
    const marked = document.querySelector('.aerodrome-page .raw mark')!.textContent!;
    expect(marked.length).toBeGreaterThan(0);
    expect(raw).toContain(marked);

    // And the whole report is still readable with the highlight on it.
    expect(document.querySelector('.aerodrome-page .raw')!.textContent).toBe(raw);
  });

  it('says whose wind it is when the field borrowed one', async () => {
    window.location.hash = '#/aerodrome/CYSN';
    render(<App />);

    await waitFor(() => expect(document.querySelector('.runway-wind')).not.toBeNull(), { timeout: 10_000 });
    const page = document.querySelector('.aerodrome-page')!.textContent ?? '';
    // Either it is this field's own reading, or it names the field it came
    // from and how far away that is. Never an unattributed number.
    expect(/Computed from this field's own observation|Computed from .* nm away/s.test(page.replace(/’/g, "'"))).toBe(true);
  });

  it('offers the neighbours, with the age of each reading', async () => {
    window.location.hash = '#/aerodrome/CYSN';
    render(<App />);
    await waitFor(() => expect(document.querySelector('.nearby li')).not.toBeNull(), { timeout: 10_000 });
    const first = document.querySelector('.nearby li')!;
    expect(first.querySelector('a')!.getAttribute('href')).toMatch(/^#\/aerodrome\/[A-Z0-9]{3,4}$/);
    expect(first.textContent).toMatch(/nm/);
  });

  it('tells a malformed identifier apart from one it does not carry', async () => {
    window.location.hash = '#/aerodrome/ZZZZZZ';
    render(<App />);
    expect((await screen.findByText(/is not an aerodrome identifier/i, {}, { timeout: 10_000 })).textContent).toBeTruthy();
    cleanup();

    // Well formed, and genuinely not in a bundle that carries Canada.
    window.location.hash = '#/aerodrome/EGLL';
    render(<App />);
    expect(await screen.findByText(/is not among the/i, {}, { timeout: 10_000 })).toBeTruthy();
  });
});
