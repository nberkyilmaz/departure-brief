/**
 * Decode every report in a fixture corpus and report what the decoder did
 * not understand, most frequent first. This is how the long tail gets worked
 * down: fix the top of this list, re-run, repeat.
 *
 *   npx tsx scripts/corpus-report.ts --kind metar|taf [--section body|trend|remarks] [--top N] [--us]
 */
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { decodeMetar } from '../src/decode/metar/index.js';
import { decodeTaf } from '../src/decode/taf/index.js';
import { tokenize } from '../src/decode/tokenizer.js';
import type { UnparsedToken } from '../src/decode/unparsed.js';

const args = process.argv.slice(2);
const opt = (name: string): string | undefined => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const kind = opt('--kind') ?? 'metar';
const section = opt('--section');
const top = Number(opt('--top') ?? 40);
const usOnly = args.includes('--us');

const decoders: Record<string, (raw: string) => { unparsed: readonly UnparsedToken[] }> = {
  metar: decodeMetar,
  taf: decodeTaf,
};
const decode = decoders[kind];
if (!decode) {
  console.error(`unknown --kind ${kind}; expected one of ${Object.keys(decoders).join(', ')}`);
  process.exit(2);
}

const US = /^(?:METAR |SPECI |TAF (?:AMD |COR )?)?[KP][A-Z0-9]{3} /;
const dir = join(dirname(fileURLToPath(import.meta.url)), '..', 'test', 'fixtures', kind);
const raws = readdirSync(dir)
  .filter((f) => f.endsWith('.txt'))
  .flatMap((f) => readFileSync(join(dir, f), 'utf8').split(/\r?\n/))
  .map((l) => l.trim())
  .filter((l) => l.length > 0)
  .filter((l) => !usOnly || US.test(l));

let tokens = 0;
let bodyTokens = 0;
const counts: Record<string, number> = { body: 0, trend: 0, remarks: 0 };
let reportsWithUnparsedBody = 0;
const freq = new Map<string, { count: number; example: string }>();

for (const raw of raws) {
  const m = decode(raw);
  const all = tokenize(raw);
  tokens += all.length;
  const rmk = all.findIndex((t) => t.text === 'RMK');
  bodyTokens += rmk >= 0 ? rmk : all.length;
  let bodyHit = false;
  for (const u of m.unparsed) {
    counts[u.section] = (counts[u.section] ?? 0) + 1;
    if (u.section === 'body') bodyHit = true;
    if (section && u.section !== section) continue;
    // Collapse digits so `SLP123` and `SLP456` count as one shape.
    const shape = u.text.replace(/\d/g, '#');
    const e = freq.get(shape) ?? { count: 0, example: raw };
    e.count++;
    freq.set(shape, e);
  }
  if (bodyHit) reportsWithUnparsedBody++;
}

const pct = (n: number, d: number) => `${((100 * n) / Math.max(d, 1)).toFixed(2)}%`;
console.log(`${kind}: ${raws.length} reports${usOnly ? ' (US only)' : ''}`);
console.log(`tokens: ${tokens}  body: ${bodyTokens}  remarks: ${tokens - bodyTokens}`);
console.log(`unparsed body: ${counts.body} (${pct(counts.body!, bodyTokens)}) in ${reportsWithUnparsedBody} reports`);
console.log(`unparsed trend: ${counts.trend}`);
console.log(`unparsed remarks: ${counts.remarks} (${pct(counts.remarks!, tokens - bodyTokens)})`);
console.log('');
const sorted = [...freq.entries()].sort((a, b) => b[1].count - a[1].count).slice(0, top);
for (const [shape, { count, example }] of sorted) {
  console.log(`${String(count).padStart(6)}  ${shape.padEnd(18)}  ${example.slice(0, 110)}`);
}
