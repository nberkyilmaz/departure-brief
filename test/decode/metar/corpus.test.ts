/**
 * Invariants over every real report in test/fixtures/metar. These do not
 * check that a decode is *right* — the hand-decoded cases do that — but that
 * the decoder is total, deterministic, and loses nothing.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { decodeMetar, type DecodedMetar } from '../../../src/decode/metar/index.js';
import { isValidSpan, type Span } from '../../../src/decode/span.js';
import { tokenize } from '../../../src/decode/tokenizer.js';

const dir = join(__dirname, '..', '..', 'fixtures', 'metar');
const corpus: { file: string; raw: string }[] = readdirSync(dir)
  .filter((f) => f.endsWith('.txt'))
  .flatMap((file) =>
    readFileSync(join(dir, file), 'utf8')
      .split(/\r?\n/)
      .map((raw) => raw.trim())
      .filter((raw) => raw.length > 0)
      .map((raw) => ({ file, raw })),
  );

/** Every span the decoder claims for a token or run of tokens. */
function claimedSpans(m: DecodedMetar): Span[] {
  const spans: Span[] = [];
  const push = (s: { span: Span } | null) => {
    if (s) spans.push(s.span);
  };
  push(m.reportType);
  push(m.station);
  push(m.time);
  m.modifiers.forEach(push);
  push(m.wind);
  push(m.visibility);
  m.rvr.forEach(push);
  m.weather.forEach(push);
  m.sky.forEach(push);
  push(m.temperature);
  push(m.altimeter);
  push(m.altimeterAlternate);
  m.recentWeather.forEach(push);
  m.windShear.forEach(push);
  m.runwayState.forEach(push);
  m.trends.forEach(push);
  if (m.remarks) {
    spans.push({ start: m.remarks.span.start, end: m.remarks.span.start + 3 }); // the RMK keyword itself
    m.remarks.items.forEach(push);
  }
  // Trend-section unparsed tokens lie inside their trend's span; checked separately below.
  m.unparsed.filter((u) => u.section !== 'trend').forEach(push);
  return spans;
}

/** Everything claimed inside one trend, so that its tokens are each owned exactly once. */
function trendInnerSpans(m: DecodedMetar, t: DecodedMetar['trends'][number]): Span[] {
  const spans: Span[] = [{ start: t.span.start, end: t.span.start + t.value.indicator.length }];
  const push = (s: { span: Span } | null) => {
    if (s) spans.push(s.span);
  };
  push(t.value.from);
  push(t.value.until);
  push(t.value.at);
  const c = t.value.conditions;
  push(c.wind);
  push(c.visibility);
  c.weather.forEach(push);
  push(c.noSignificantWeather);
  c.sky.forEach(push);
  push(c.windShear);
  c.icing.forEach(push);
  c.turbulence.forEach(push);
  push(c.altimeter);
  m.unparsed
    .filter((u) => u.section === 'trend' && t.span.start <= u.span.start && u.span.end <= t.span.end)
    .forEach(push);
  return spans;
}

describe('METAR corpus invariants', () => {
  it('has a corpus to test', () => {
    expect(corpus.length).toBeGreaterThan(1000);
  });

  it('never throws, is deterministic, and round-trips through JSON', () => {
    for (const { raw } of corpus) {
      const a = decodeMetar(raw);
      const b = decodeMetar(raw);
      expect(b).toEqual(a);
      expect(JSON.parse(JSON.stringify(a))).toEqual(a);
    }
  });

  it('every span is valid and every token is claimed exactly once', () => {
    const failures: string[] = [];
    for (const { raw } of corpus) {
      const m = decodeMetar(raw);
      const tokens = tokenize(raw);
      const spans = claimedSpans(m);
      for (const s of spans) {
        if (!isValidSpan(raw, s)) failures.push(`invalid span ${JSON.stringify(s)} in: ${raw}`);
        // A claimed span must begin and end on token boundaries.
        if (/^\s|\s$/.test(raw.slice(s.start, s.end))) failures.push(`span not on token boundary: ${raw}`);
      }
      for (const t of tokens) {
        const owners = spans.filter((s) => s.start <= t.start && t.end <= s.end).length;
        if (owners !== 1) failures.push(`token "${t.text}" claimed ${owners} times in: ${raw}`);
      }
      for (const trend of m.trends) {
        const inner = trendInnerSpans(m, trend);
        for (const t of tokens.filter((t) => trend.span.start <= t.start && t.end <= trend.span.end)) {
          const owners = inner.filter((s) => s.start <= t.start && t.end <= s.end).length;
          if (owners !== 1) failures.push(`trend token "${t.text}" claimed ${owners} times in: ${raw}`);
        }
      }
      if (failures.length > 20) break;
    }
    expect(failures).toEqual([]);
  });

  it('always identifies station and time on real reports', () => {
    const missing = corpus.filter(({ raw }) => {
      const m = decodeMetar(raw);
      return m.station === null || m.time === null;
    });
    expect(missing.map((x) => x.raw)).toEqual([]);
  });

  it('keeps the unparsed body rate low on US reports', () => {
    let body = 0;
    let unparsed = 0;
    for (const { raw } of corpus) {
      if (!/^(METAR |SPECI )?[KP][A-Z0-9]{3} /.test(raw)) continue;
      const m = decodeMetar(raw);
      const tokens = tokenize(raw);
      const rmk = tokens.findIndex((t) => t.text === 'RMK');
      body += rmk >= 0 ? rmk : tokens.length;
      unparsed += m.unparsed.filter((u) => u.section === 'body').length;
    }
    expect(body).toBeGreaterThan(10000);
    expect(unparsed / body).toBeLessThan(0.005);
  });
});
