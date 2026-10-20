/**
 * Hazard advisories, over the 123 the weather service was carrying at
 * 05:20Z on 14 September 2026 — thunderstorms, turbulence, icing, volcanic
 * ash, mountain wave and a tropical cyclone, from both the international
 * feed and the American domestic one.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { decodeSigmet } from '../../src/decode/sigmet/decode.js';
import { sliceSpan } from '../../src/decode/span.js';
import { areaIsTestable } from '../../src/domain/polygon.js';

const DIR = join(__dirname, '..', 'fixtures', 'fetch', 'awc', 'sigmet-2026-09-14');
const records = (name: string): unknown[] => JSON.parse(readFileSync(join(DIR, `${name}.json`), 'utf8')) as unknown[];
const raw = (r: unknown) => JSON.stringify(r);

describe('decodeSigmet', () => {
  it('reads the international feed, and points every value at the record', () => {
    const all = records('isigmet');
    expect(all.length).toBeGreaterThan(50);
    for (const record of all) {
      const text = raw(record);
      const d = decodeSigmet(text);
      expect(d.kind).not.toBeNull();
      expect(d.validFrom).not.toBeNull();
      expect(d.validTo).not.toBeNull();
      expect(d.validFrom!.getTime()).toBeLessThan(d.validTo!.getTime());
      // Every cited value is a slice of the record it came from.
      for (const cited of [d.hazardCode, d.qualifier, d.bulletin]) {
        if (cited) expect(sliceSpan(text, cited.span)).toBe(JSON.stringify(cited.value));
      }
      // The bulletin is the text a pilot would be handed.
      expect(d.bulletin!.value).toMatch(/SIGMET|AIRMET/);
      expect(d.area.length).toBeGreaterThan(2);
    }
  });

  it('knows every hazard the service actually publishes', () => {
    const unknown = [...records('isigmet'), ...records('airsigmet')]
      .map((r) => decodeSigmet(raw(r)))
      .flatMap((d) => d.unparsed.filter((u) => u.startsWith('hazard ')));
    expect(unknown).toEqual([]);
  });

  it('reads the American feed, whose fields are named differently', () => {
    const d = decodeSigmet(raw(records('airsigmet')[0]));
    expect(d.hazard).toBe('thunderstorm');
    expect(d.kind).toBe('sigmet');
    // Numbered altitude fields there, plain base and top internationally.
    expect(d.topFt).toBeGreaterThan(0);
    expect(d.bulletin!.value).toContain('CONVECTIVE SIGMET');
  });

  it('finds the icing and turbulence a light aircraft cares about', () => {
    const decoded = records('isigmet').map((r) => decodeSigmet(raw(r)));
    const icing = decoded.filter((d) => d.hazard === 'icing');
    const turbulence = decoded.filter((d) => d.hazard === 'turbulence');
    expect(icing.length).toBeGreaterThan(5);
    expect(turbulence.length).toBeGreaterThan(10);
    // Severity is carried when the service gives it.
    expect(icing.some((d) => d.qualifier?.value === 'SEV')).toBe(true);
    // And the areas are the kind the geometry can answer for.
    expect(decoded.filter((d) => areaIsTestable(d.area) === null).length).toBeGreaterThan(50);
  });

  it('keeps a record it cannot make sense of rather than throwing', () => {
    for (const bad of ['', 'not json', '[]', '{"hazard":"WHAT","coords":[{"lat":999,"lon":0}]}']) {
      const d = decodeSigmet(bad);
      expect(d.unparsed.length).toBeGreaterThan(0);
      expect(d.area.length).toBe(0);
    }
    // An unknown hazard keeps the service's own code, cited.
    const odd = decodeSigmet('{"hazard":"WHAT","rawSigmet":"WSxx SIGMET"}');
    expect(odd.hazard).toBeNull();
    expect(odd.hazardCode!.value).toBe('WHAT');
  });
});
