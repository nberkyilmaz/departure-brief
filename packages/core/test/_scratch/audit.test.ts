import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'vitest';
import { decodeMetar, flightCategory, ceiling, visibilityStatuteMiles, windKnots } from '../../src/decode/metar/index.js';
import { decodeTaf } from '../../src/decode/taf/index.js';
import { explainMetar } from '../../src/explain/metar.js';
import { parseConditions } from '../../src/decode/conditions.js';
import { tokenize } from '../../src/decode/tokenizer.js';

const snap = JSON.parse(readFileSync(join(__dirname, '..', 'fixtures', 'fetch', 'canada-2026-09-18', 'weather.json'), 'utf8'));

describe('audit', () => {
  it('A: oracle vs AWC fields', () => {
    const mism: string[] = [];
    let n = 0;
    for (const r of snap.metar) {
      const raw: string = r.rawOb;
      const m = decodeMetar(raw);
      n++;
      const cat = flightCategory(m);
      if (r.fltCat !== undefined && cat !== r.fltCat) mism.push(`CAT ${r.fltCat} vs ${cat} :: ${raw}`);
      if (r.fltCat === undefined && cat !== null) mism.push(`CAT awc-undefined vs ${cat} :: ${raw}`);
      const c = ceiling(m)?.value ?? null;
      const awcCeil = (r.clouds ?? []).filter((x: any) => (x.cover === 'BKN' || x.cover === 'OVC' || x.cover === 'OVX') && x.base != null).map((x: any) => x.base);
      const awcC = awcCeil.length ? Math.min(...awcCeil) : null;
      if (c !== awcC) mism.push(`CEIL awc=${awcC} ours=${c} :: ${raw}`);
      const v = m.visibility ? visibilityStatuteMiles(m.visibility.value) : null;
      const av = r.visib;
      if (av !== undefined && av !== null) {
        const avn = typeof av === 'string' ? (av.endsWith('+') ? Number(av.slice(0, -1)) : Number(av)) : av;
        if (v === null || Math.abs(v - avn) > 0.01) mism.push(`VIS awc=${av} ours=${v} :: ${raw}`);
      } else if (v !== null) mism.push(`VIS awc=none ours=${v} :: ${raw}`);
      if (m.temperature) {
        if (r.temp !== m.temperature.value.temperature) mism.push(`TEMP awc=${r.temp} ours=${m.temperature.value.temperature} :: ${raw}`);
        if (r.dewp !== m.temperature.value.dewpoint) mism.push(`DEWP awc=${r.dewp} ours=${m.temperature.value.dewpoint} :: ${raw}`);
      }
      if (m.wind) {
        const w = windKnots(m.wind.value);
        const dir = m.wind.value.direction;
        if (r.wdir !== (dir === 'VRB' ? 'VRB' : dir) && !(r.wdir === undefined && dir === null)) mism.push(`WDIR awc=${r.wdir} ours=${dir} :: ${raw}`);
        if (r.wspd !== w.speed && !(r.wspd === undefined && w.speed === null)) mism.push(`WSPD awc=${r.wspd} ours=${w.speed} :: ${raw}`);
        if ((r.wgst ?? null) !== w.gust) mism.push(`WGST awc=${r.wgst} ours=${w.gust} :: ${raw}`);
      }
      if (m.altimeter && m.altimeter.value.value !== null && r.altim != null) {
        const ours = m.altimeter.value.unit === 'inHg' ? m.altimeter.value.value * 33.8639 : m.altimeter.value.value;
        if (Math.abs(ours - r.altim) > 0.6) mism.push(`ALT awc=${r.altim} ours=${ours.toFixed(1)} :: ${raw}`);
      }
    }
    console.log(`A: ${n} metars, ${mism.length} mismatches`);
    console.log(mism.join('\n'));
  });

  it('B: unparsed body tokens in the snapshot', () => {
    const counts = new Map<string, { n: number; ex: string }>();
    for (const r of snap.metar) {
      const m = decodeMetar(r.rawOb);
      for (const u of m.unparsed) {
        if (u.section === 'remarks') continue;
        const k = `${u.section}:${u.text}`;
        const e = counts.get(k) ?? { n: 0, ex: r.rawOb };
        e.n++;
        counts.set(k, e);
      }
    }
    console.log('B metar body unparsed:\n' + [...counts.entries()].sort((a, b) => b[1].n - a[1].n).map(([k, v]) => `${k} x${v.n} :: ${v.ex}`).join('\n'));
    const tc = new Map<string, { n: number; ex: string }>();
    for (const r of snap.taf) {
      const t = decodeTaf(r.rawTAF);
      for (const u of t.unparsed) {
        if (u.section === 'remarks') continue;
        const k = `${u.section}:${u.text}`;
        const e = tc.get(k) ?? { n: 0, ex: r.rawTAF };
        e.n++;
        tc.set(k, e);
      }
    }
    console.log('B taf body unparsed:\n' + [...tc.entries()].sort((a, b) => b[1].n - a[1].n).map(([k, v]) => `${k} x${v.n} :: ${v.ex}`).join('\n'));
  });

  it('C: explain samples', () => {
    const cases = [
      'METAR CYSN 190300Z VRB03KT M1/4SM FG VV002 04/04 A2989',
      'METAR CYSN 190300Z 31008KT 1 3/4SM BR BKN008 04/03 A2989',
      'METAR CYSN 190300Z 31008KT 3/4SM BR BKN008 04/03 A2989 RMK VIS 3/4V1 1/2 TWR VIS 1 1/2',
      'METAR CYSN 190300Z 31008KT 2 1/2SM R24/1200V2000FT/D BR BKN008 04/03 A2989',
      'METAR EGLL 190320Z 27010KT 4000 BR BKN008 04/03 Q1013 R27L/CLRD70 TEMPO 2000 -RA BKN004',
      'METAR CYQA 190300Z AUTO VRB02KT 9SM CLR 07/07 A3027 RMK SLP257',
      'METAR CYEK 071100Z AUTO 29007KT 9SM CLR 02/01 A3034 RMK ICE MISG CHINO RWY22 SLP278',
      'METAR KXXX 190300Z 31008KT 1/8SM FG VV001 04/03 A2989 RMK CIG 004',
      'METAR KXXX 190300Z 31008KT 1/16SM FG VV001 04/03 A2989',
      'METAR KXXX 190300Z 31008KT 5/8SM FG VV001 04/03 A2989',
      'METAR CYSN 190300Z 31008KT 15SM SKC 04/03 A2989 RMK LAST STFD OBS/NEXT 191200Z',
      'METAR CYSN 190300Z 31008KT 15SM SKC 04/03 A2989 RMK SN E',
    ];
    for (const raw of cases) {
      console.log('C >> ' + raw);
      for (const l of explainMetar(decodeMetar(raw))) console.log(`   [${l.label}] ${l.text}  <${raw.slice(l.span?.start ?? 0, l.span?.end ?? 0)}>${l.indeterminate ? ' (indeterminate)' : ''}`);
    }
  });

  it('D: remark kinds histogram + suspicious', () => {
    const kinds = new Map<string, { n: number; ex: string[] }>();
    for (const r of snap.metar) {
      const raw: string = r.rawOb;
      const m = decodeMetar(raw);
      for (const item of m.remarks?.items ?? []) {
        const e = kinds.get(item.value.kind) ?? { n: 0, ex: [] };
        e.n++;
        if (e.ex.length < 8) e.ex.push(raw.slice(item.span.start, item.span.end));
        kinds.set(item.value.kind, e);
      }
    }
    console.log('D remark kinds:\n' + [...kinds.entries()].map(([k, v]) => `${k} x${v.n}: ${v.ex.join(' | ')}`).join('\n'));
    const un = new Map<string, number>();
    for (const r of snap.metar) {
      const m = decodeMetar(r.rawOb);
      for (const u of m.unparsed) if (u.section === 'remarks') un.set(u.text, (un.get(u.text) ?? 0) + 1);
    }
    console.log('D unparsed remarks top: ' + [...un.entries()].sort((a, b) => b[1] - a[1]).slice(0, 40).map(([k, v]) => `${k} x${v}`).join(', '));
  });

  it('E: hand cases', () => {
    const t = tokenize('TEMPO 1914/1918 24010KT 280V350');
    const r = parseConditions(t, 2, 3);
    console.log('E conditions past-end wind: ' + JSON.stringify(r));
    const s = decodeMetar('METAR CYSN 190300Z 31008KT 15SM //////  ///TCU BKN010/// 04/03 A2989');
    console.log('E sky: ' + JSON.stringify(s.sky.map((x) => x.value)) + ' ' + JSON.stringify(s.unparsed));
    const ws = decodeTaf('TAF KOMA 190051Z 1901/1924 17009KT P6SM SCT150 BKN250 WS017/20042KT TEMPO 1901/1903 -TSRA OVC080CB');
    console.log('E taf ws: ' + JSON.stringify(ws.periods[0]!.conditions.windShear) + ' ' + JSON.stringify(ws.unparsed));
    const m00 = decodeMetar('METAR CYSN 190300Z 31008KT 15SM SKC M00/M02 A2989');
    console.log('E M00: ' + JSON.stringify(m00.temperature));
    const vis = decodeMetar('METAR CYSN 190300Z 31008KT 11/16SM BR BKN008 04/03 A2989');
    console.log('E 11/16SM: ' + JSON.stringify(vis.visibility));
    const t24 = decodeMetar('METAR CYSN 192400Z 31008KT 15SM SKC 04/03 A2989');
    console.log('E hour24: ' + JSON.stringify(t24.time));
    const spd = decodeMetar('METAR CYSN 190300Z 31008KT 15SM SKC 04/03 A2989 RMK PK WND 31025/0245 SLP123 T00441022');
    console.log('E remarks: ' + JSON.stringify(spd.remarks?.items.map((x) => x.value)));
    const taf = decodeTaf('TAF CYSN 191338Z 1914/2002 24008KT P6SM FEW040 BKN250 TEMPO 1914/1918 BKN040 FM192000 26010G20KT P6SM SCT030 BECMG 2000/2002 30008KT PROB30 2000/2002 1/2SM FG RMK NXT FCST BY 192000Z');
    console.log('E taf periods: ' + JSON.stringify(taf.periods.map((p) => ({ k: p.kind, v: p.validity?.value, ind: p.indicator?.value, vis: p.conditions.visibility?.value, sky: p.conditions.sky.map((s) => s.value) }))));
    const wx = decodeMetar('METAR CYSN 190300Z 31008KT 1SM -SN BLSN BKN008 M04/M06 A2989 RMK SN E');
    console.log('E remark SN E: ' + JSON.stringify(wx.remarks?.items.map((x) => x.value)));
  });
});
