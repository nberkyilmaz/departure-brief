/**
 * Invariants over every real TAF in test/fixtures/taf: total, deterministic,
 * and lossless. Hand-decoded cases in decode.test.ts check correctness.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Conditions } from '../../../src/decode/conditions.js';
import { isValidSpan, type Span } from '../../../src/decode/span.js';
import { decodeTaf, type DecodedTaf, type TafPeriod } from '../../../src/decode/taf/index.js';
import { tokenize } from '../../../src/decode/tokenizer.js';

const dir = join(__dirname, '..', '..', 'fixtures', 'taf');
const corpus: string[] = readdirSync(dir)
  .filter((f) => f.endsWith('.txt'))
  .flatMap((file) =>
    readFileSync(join(dir, file), 'utf8')
      .split(/\r?\n/)
      .map((raw) => raw.trim())
      .filter((raw) => raw.length > 0),
  );

const within = (inner: Span, outer: Span) => outer.start <= inner.start && inner.end <= outer.end;
const same = (a: Span, b: Span) => a.start === b.start && a.end === b.end;

export function conditionSpans(c: Conditions): Span[] {
  const spans: Span[] = [];
  const push = (s: { span: Span } | null) => {
    if (s) spans.push(s.span);
  };
  push(c.wind);
  push(c.visibility);
  c.weather.forEach(push);
  push(c.noSignificantWeather);
  c.sky.forEach(push);
  push(c.windShear);
  c.icing.forEach(push);
  c.turbulence.forEach(push);
  push(c.altimeter);
  return spans;
}

/** Top-level regions: header fields, whole periods, the amendment notice, the RMK keyword, remark tokens. */
function topLevelSpans(d: DecodedTaf): Span[] {
  const spans: Span[] = [];
  const push = (s: { span: Span } | null) => {
    if (s) spans.push(s.span);
  };
  push(d.reportType);
  d.modifiers.forEach(push);
  push(d.station);
  push(d.issued);
  push(d.validity);
  push(d.status);
  d.periods.forEach((p) => spans.push(p.span));
  d.notices.forEach(push);
  // Temperatures in the trailer are top-level; those inside a period are inner.
  d.temperatures.filter((t) => !d.periods.some((p) => within(t.span, p.span))).forEach(push);
  if (d.remarks) spans.push({ start: d.remarks.span.start, end: d.remarks.span.start + 3 });
  // Body-section unparsed tokens inside a period are inner; the rest (trailer) are top-level.
  d.unparsed.filter((u) => u.section === 'remarks' || !d.periods.some((p) => within(u.span, p.span))).forEach(push);
  return spans;
}

/** Everything claimed inside one period, deduplicated (FM's indicator and validity share a span). */
function innerSpans(d: DecodedTaf, p: TafPeriod): Span[] {
  const spans: Span[] = [];
  if (p.indicator) spans.push(p.indicator.span);
  if (p.validity && p.kind !== 'base' && !spans.some((s) => same(s, p.validity!.span))) spans.push(p.validity.span);
  spans.push(...conditionSpans(p.conditions));
  d.temperatures.filter((t) => within(t.span, p.span)).forEach((t) => spans.push(t.span));
  d.unparsed.filter((u) => u.section === 'body' && within(u.span, p.span)).forEach((u) => spans.push(u.span));
  return spans;
}

describe('TAF corpus invariants', () => {
  it('has a corpus to test', () => {
    expect(corpus.length).toBeGreaterThan(1000);
  });

  it('never throws, is deterministic, and round-trips through JSON', () => {
    for (const raw of corpus) {
      const a = decodeTaf(raw);
      expect(decodeTaf(raw)).toEqual(a);
      expect(JSON.parse(JSON.stringify(a))).toEqual(a);
    }
  });

  it('every token is claimed exactly once at the top level and within each period', () => {
    const failures: string[] = [];
    for (const raw of corpus) {
      const d = decodeTaf(raw);
      const tokens = tokenize(raw);
      const top = topLevelSpans(d);
      for (const s of top) {
        if (!isValidSpan(raw, s)) failures.push(`invalid span ${JSON.stringify(s)}: ${raw}`);
      }
      for (const t of tokens) {
        const owners = top.filter((s) => within(t, s)).length;
        if (owners !== 1) failures.push(`token "${t.text}" has ${owners} top-level owners: ${raw}`);
      }
      for (const p of d.periods) {
        const inner = innerSpans(d, p);
        for (const s of inner) {
          if (!within(s, p.span)) failures.push(`inner span outside period: ${raw}`);
        }
        for (const t of tokens.filter((t) => within(t, p.span))) {
          const owners = inner.filter((s) => within(t, s)).length;
          if (owners !== 1) failures.push(`period token "${t.text}" has ${owners} owners: ${raw}`);
        }
      }
      if (failures.length > 20) break;
    }
    expect(failures).toEqual([]);
  });

  it('always identifies station, issue time and validity on real reports', () => {
    const missing = corpus.filter((raw) => {
      const d = decodeTaf(raw);
      return d.station === null || d.issued === null || (d.validity === null && d.status === null);
    });
    expect(missing).toEqual([]);
  });

  it('every period has a validity unless its indicator was malformed', () => {
    let periods = 0;
    let missing = 0;
    for (const raw of corpus) {
      for (const p of decodeTaf(raw).periods) {
        periods++;
        if (p.validity === null) missing++;
      }
    }
    expect(periods).toBeGreaterThan(5000);
    expect(missing / periods).toBeLessThan(0.002);
  });

  it('keeps the unparsed body rate low on US reports (military free text excluded by notices)', () => {
    let body = 0;
    let unparsed = 0;
    for (const raw of corpus) {
      if (!/^(TAF (AMD |COR )?)?[KP][A-Z0-9]{3} /.test(raw)) continue;
      const d = decodeTaf(raw);
      const tokens = tokenize(raw);
      const rmk = tokens.findIndex((t) => t.text === 'RMK');
      body += rmk >= 0 ? rmk : tokens.length;
      unparsed += d.unparsed.filter((u) => u.section === 'body').length;
    }
    expect(body).toBeGreaterThan(10000);
    expect(unparsed / body).toBeLessThan(0.005);
  });
});
