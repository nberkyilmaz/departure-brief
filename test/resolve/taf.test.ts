/**
 * TAF period selection. The case set is enumerated: base only, FM
 * succession, BECMG before/during/after its window, TEMPO/INTER/PROB
 * overlays in and out of window, element inheritance and replacement, NSW,
 * validity edges, cancelled forecasts, unplaceable periods. Real TAFs from
 * the corpus where they have the shape needed.
 */
import { describe, expect, it } from 'vitest';
import { EMPTY_CONDITIONS } from '../../src/decode/conditions.js';
import { conditionsText } from '../../src/resolve/describe.js';
import { decodeTaf } from '../../src/decode/taf/index.js';
import { mergeConditions, periodWindows, resolveTaf } from '../../src/resolve/taf.js';

const issued = new Date('2026-09-07T11:42:00Z');
const at = (iso: string) => new Date(iso);

// corpus: KAXN — base, FM, standalone PROB30 (US practice)
const KAXN =
  'TAF KAXN 071142Z 0712/0812 16010KT P6SM SCT006 OVC050 FM071600 16016G24KT P6SM BKN035 PROB30 0720/0723 6SM -RA BR OVC025 FM072300 16017G28KT 5SM -RA BR SCT025 BKN040 PROB30 0803/0806 4SM TSRA OVC025CB FM080600 17017G26KT P6SM BKN040 BKN080 PROB30 0806/0809 5SM -RA BR OVC030';
// corpus: EFVA — BECMG, TEMPO, PROB30 TEMPO, NSW (ICAO practice)
const EFVA =
  'TAF EFVA 071135Z 0712/0812 20009KT 9999 SCT035 BECMG 0717/0719 3000 DZ BKN008 BECMG 0719/0721 9999 NSW BKN014 TEMPO 0801/0805 20015G28KT FEW014 SCT070CB TEMPO 0805/0812 20015G28KT 7000 -SHRA BKN008 SCT070CB PROB30 TEMPO 0805/0812 3500 DZ';

const kaxn = decodeTaf(KAXN);
const efva = decodeTaf(EFVA);
const text = (raw: string, f: ReturnType<typeof resolveTaf>) => ({
  prevailing: f.prevailing ? conditionsText(raw, f.prevailing.conditions) : null,
  sources: f.prevailing?.sources.map((s) => (s.period.kind === 'base' ? 'base' : s.period.indicator!.value)) ?? [],
  overlays: f.overlays.map((o) => `${o.kind}${o.probability ? o.probability : ''}: ${conditionsText(raw, o.conditions)}`),
});

describe('periodWindows', () => {
  it('places base and FM periods end to end and windows by their own group', () => {
    const { windows, unplaced } = periodWindows(kaxn, issued);
    expect(unplaced).toEqual([]);
    const iso = (d: Date) => d.toISOString().slice(0, 16) + 'Z';
    expect(windows.map((w) => [w.period.kind, iso(w.from), iso(w.to)])).toEqual([
      ['base', '2026-09-07T12:00Z', '2026-09-07T16:00Z'],
      ['FM', '2026-09-07T16:00Z', '2026-09-07T23:00Z'],
      ['PROB', '2026-09-07T20:00Z', '2026-09-07T23:00Z'],
      ['FM', '2026-09-07T23:00Z', '2026-09-08T06:00Z'],
      ['PROB', '2026-09-08T03:00Z', '2026-09-08T06:00Z'],
      ['FM', '2026-09-08T06:00Z', '2026-09-08T12:00Z'],
      ['PROB', '2026-09-08T06:00Z', '2026-09-08T09:00Z'],
    ]);
  });

  it('a period with no time group is unplaced, not dropped', () => {
    const taf = decodeTaf('TAF KXYZ 071100Z 0712/0812 27010KT P6SM SKC TEMPO VRB05KT 3SM BR');
    const { windows, unplaced } = periodWindows(taf, issued);
    expect(windows.length).toBe(1);
    expect(unplaced.map((p) => p.kind)).toEqual(['TEMPO']);
    expect(resolveTaf(taf, issued, at('2026-09-07T13:00Z')).unplaced.length).toBe(1);
  });

  it('hour 24 is the end of the day', () => {
    const taf = decodeTaf('TAF KXYZ 071100Z 0712/0724 27010KT P6SM SKC');
    const { windows } = periodWindows(taf, issued);
    expect(windows[0]!.to.toISOString()).toBe('2026-09-08T00:00:00.000Z');
  });
});

describe('resolveTaf — prevailing state', () => {
  it('base period before any FM', () => {
    const f = resolveTaf(kaxn, issued, at('2026-09-07T14:00Z'));
    expect(text(KAXN, f)).toEqual({ prevailing: '16010KT P6SM SCT006 OVC050', sources: ['base'], overlays: [] });
    expect(f.outsideValidity).toBe(false);
  });

  it('FM replaces everything, including elements it does not mention', () => {
    // FM080600 gives no weather; the -RA BR from FM072300 must not carry over.
    const f = resolveTaf(kaxn, issued, at('2026-09-08T10:00Z'));
    expect(text(KAXN, f)).toEqual({ prevailing: '17017G26KT P6SM BKN040 BKN080', sources: ['FM080600'], overlays: [] });
  });

  it('an FM takes effect exactly at its time, not before', () => {
    expect(text(KAXN, resolveTaf(kaxn, issued, at('2026-09-07T15:59Z'))).sources).toEqual(['base']);
    expect(text(KAXN, resolveTaf(kaxn, issued, at('2026-09-07T16:00Z'))).sources).toEqual(['FM071600']);
  });

  it('BECMG: before its window the old state; during, an overlay; after, merged into prevailing', () => {
    const before = resolveTaf(efva, issued, at('2026-09-07T16:00Z'));
    expect(text(EFVA, before)).toEqual({ prevailing: '20009KT 9999 SCT035', sources: ['base'], overlays: [] });

    const during = resolveTaf(efva, issued, at('2026-09-07T18:00Z'));
    expect(text(EFVA, during)).toEqual({
      prevailing: '20009KT 9999 SCT035',
      sources: ['base'],
      overlays: ['BECMG: 20009KT 3000 DZ BKN008'],
    });

    const after = resolveTaf(efva, issued, at('2026-09-07T19:30Z'));
    // First BECMG complete (vis 3000, DZ, BKN008), second in progress (9999 NSW BKN014).
    expect(text(EFVA, after)).toEqual({
      prevailing: '20009KT 3000 DZ BKN008',
      sources: ['base', 'BECMG'],
      overlays: ['BECMG: 20009KT 9999 NSW BKN014'],
    });

    const later = resolveTaf(efva, issued, at('2026-09-07T22:00Z'));
    expect(text(EFVA, later).prevailing).toBe('20009KT 9999 NSW BKN014');
    expect(later.prevailing?.conditions.weather).toEqual([]);
  });
});

describe('resolveTaf — overlays', () => {
  it('a standalone PROB30 is an overlay merged onto the FM in force, never the prevailing state', () => {
    const f = resolveTaf(kaxn, issued, at('2026-09-07T21:00Z'));
    expect(text(KAXN, f)).toEqual({
      prevailing: '16016G24KT P6SM BKN035',
      sources: ['FM071600'],
      overlays: ['PROB30: 16016G24KT 6SM -RA BR OVC025'],
    });
    expect(f.overlays[0]!.probability).toBe(30);
    expect(f.overlays[0]!.conditions.wind).toBe(f.prevailing!.conditions.wind);
  });

  it('overlay windows are half-open: in at the start, out at the end', () => {
    expect(resolveTaf(kaxn, issued, at('2026-09-07T19:59Z')).overlays).toEqual([]);
    expect(resolveTaf(kaxn, issued, at('2026-09-07T20:00Z')).overlays.length).toBe(1);
    expect(resolveTaf(kaxn, issued, at('2026-09-07T22:59Z')).overlays.length).toBe(1);
    expect(resolveTaf(kaxn, issued, at('2026-09-07T23:00Z')).overlays).toEqual([]);
  });

  it('several overlays can cover one instant; TEMPO and PROB30 TEMPO are distinct', () => {
    const f = resolveTaf(efva, issued, at('2026-09-08T06:00Z'));
    expect(text(EFVA, f)).toEqual({
      prevailing: '20009KT 9999 NSW BKN014',
      sources: ['base', 'BECMG', 'BECMG'],
      overlays: ['TEMPO: 20015G28KT 7000 -SHRA BKN008 SCT070CB', 'TEMPO30: 20009KT 3500 DZ BKN014'],
    });
    expect(f.overlays.map((o) => o.probability)).toEqual([null, 30]);
  });

  it('a TEMPO that gives only wind inherits visibility, weather and sky', () => {
    const f = resolveTaf(efva, issued, at('2026-09-08T03:00Z'));
    expect(text(EFVA, f).overlays).toEqual(['TEMPO: 20015G28KT 9999 NSW FEW014 SCT070CB']);
  });

  it('every element in the result carries its span into the TAF', () => {
    const f = resolveTaf(kaxn, issued, at('2026-09-07T21:00Z'));
    const vis = f.overlays[0]!.conditions.visibility!;
    expect(KAXN.slice(vis.span.start, vis.span.end)).toBe('6SM');
    const wind = f.prevailing!.conditions.wind!;
    expect(KAXN.slice(wind.span.start, wind.span.end)).toBe('16016G24KT');
  });
});

describe('resolveTaf — edges', () => {
  it('outside validity yields no prevailing state and says so', () => {
    for (const t of ['2026-09-07T11:59Z', '2026-09-08T12:00Z', '2026-09-09T12:00Z']) {
      const f = resolveTaf(kaxn, issued, at(t));
      expect(f.outsideValidity).toBe(true);
      expect(f.prevailing).toBeNull();
      expect(f.overlays).toEqual([]);
    }
    expect(resolveTaf(kaxn, issued, at('2026-09-07T12:00Z')).outsideValidity).toBe(false);
    expect(resolveTaf(kaxn, issued, at('2026-09-08T11:59Z')).outsideValidity).toBe(false);
  });

  it('a cancelled TAF resolves to nothing', () => {
    const f = resolveTaf(decodeTaf('TAF KXYZ 071100Z 0712/0812 CNL'), issued, at('2026-09-07T13:00Z'));
    expect(f.prevailing).toBeNull();
  });

  it('a validity that begins the day after issue at a month end resolves forward, not back', () => {
    const taf = decodeTaf('TAF KXYZ 302300Z 0100/0124 27010KT P6SM SKC');
    const f = resolveTaf(taf, new Date('2026-09-30T23:00:00Z'), new Date('2026-10-01T05:00:00Z'));
    expect(f.validity?.from.toISOString()).toBe('2026-10-01T00:00:00.000Z');
    expect(f.outsideValidity).toBe(false);
  });

  it('carries station, raw text and issue time for citation', () => {
    const f = resolveTaf(kaxn, issued, at('2026-09-07T14:00Z'));
    expect(f.station).toBe('KAXN');
    expect(f.raw).toBe(KAXN);
    expect(f.issued).toBe(issued);
  });
});

describe('mergeConditions', () => {
  const base = decodeTaf('TAF KXYZ 071100Z 0712/0812 27010KT 5SM -RA BKN020 OVC040 WS020/24045KT').periods[0]!.conditions;
  const change = (s: string) => decodeTaf(`TAF KXYZ 071100Z 0712/0812 ${s}`).periods[0]!.conditions;
  it('replaces given elements and inherits the rest', () => {
    const m = mergeConditions(base, change('3SM BR'));
    expect(m.wind).toBe(base.wind);
    expect(m.visibility).not.toBe(base.visibility);
    expect(m.weather.length).toBe(1);
    expect(m.sky).toBe(base.sky);
    expect(m.windShear).toBe(base.windShear);
  });
  it('NSW clears weather; any sky group replaces the whole sky', () => {
    const m = mergeConditions(base, change('NSW SKC'));
    expect(m.weather).toEqual([]);
    expect(m.noSignificantWeather?.value).toBe('NSW');
    expect(m.sky.length).toBe(1);
  });
  it('is a no-op for an empty change', () => {
    expect(mergeConditions(base, EMPTY_CONDITIONS)).toEqual(base);
  });
});
