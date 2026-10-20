import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { decodeNotam } from '../../src/notam/decode.js';
import { describeQCode, Q_CONDITIONS, Q_PURPOSE, Q_SCOPE, Q_SUBJECTS, Q_TRAFFIC } from '../../src/notam/qcodes.js';

const dir = join(__dirname, '..', 'fixtures', 'notam', 'navcanada', '2026-09-12');
const corpus: string[] = readdirSync(dir)
  .filter((f) => f.endsWith('.json'))
  .flatMap((f) => (JSON.parse(readFileSync(join(dir, f), 'utf8')) as { data: { text: string }[] }).data)
  .map((item) => (JSON.parse(item.text) as { raw: string }).raw);

describe('Q-code tables', () => {
  it('are substantial and well-formed', () => {
    expect(Object.keys(Q_SUBJECTS).length).toBeGreaterThan(120);
    expect(Object.keys(Q_CONDITIONS).length).toBeGreaterThan(60);
    for (const code of [...Object.keys(Q_SUBJECTS), ...Object.keys(Q_CONDITIONS)]) expect(code).toMatch(/^[A-Z]{2}$/);
    for (const e of Object.values(Q_SUBJECTS)) expect(e.meaning.length).toBeGreaterThan(2);
  });

  it('know the codes a VFR pilot meets every day', () => {
    expect(Q_SUBJECTS['MR']?.meaning).toMatch(/runway/i);
    expect(Q_SUBJECTS['MX']?.meaning).toMatch(/taxiway/i);
    expect(Q_SUBJECTS['FA']?.meaning).toMatch(/aerodrome/i);
    expect(Q_SUBJECTS['OB']?.meaning).toMatch(/obstacle/i);
    expect(Q_SUBJECTS['LP']?.meaning).toMatch(/PAPI|precision approach path/i);
    expect(Q_SUBJECTS['IC']?.meaning).toMatch(/ILS|instrument landing/i);
    expect(Q_CONDITIONS['LC']?.meaning).toMatch(/closed/i);
    expect(Q_CONDITIONS['AS']?.meaning).toMatch(/unserviceable/i);
    expect(Q_CONDITIONS['CA']?.meaning).toMatch(/activated/i);
    expect(Q_CONDITIONS['CE']?.meaning).toMatch(/erected/i);
    expect(Q_CONDITIONS['AU']?.meaning).toMatch(/not available|unavailable/i);
    expect(Q_TRAFFIC['IV']).toBeTruthy();
    expect(Q_PURPOSE['NBO']).toBeTruthy();
    expect(Q_SCOPE['AE']).toBeTruthy();
  });

  it('decode every Q code in the NAV CANADA corpus', () => {
    const unknown: string[] = [];
    for (const raw of corpus) {
      const q = decodeNotam(raw).q?.value;
      if (!q) continue;
      const d = describeQCode(q);
      if (!d.subject || !d.condition || !d.traffic || !d.purpose || !d.scope) unknown.push(`${q.code.text}/${q.traffic}/${q.purpose}/${q.scope}`);
    }
    expect(unknown).toEqual([]);
  });

  it('returns null for codes it does not know, never a guess', () => {
    const d = describeQCode({ code: { subject: 'ZZ', condition: 'QQ' }, traffic: 'X', purpose: 'NBO', scope: 'A' });
    expect(d.subject).toBeNull();
    expect(d.condition).toBeNull();
    expect(d.traffic).toBeNull();
    expect(d.purpose).not.toBeNull();
  });
});
