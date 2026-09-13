/**
 * Document commands: read a scanned PDF into word boxes, search it, and
 * extract weight-and-balance data from it with the page as witness.
 *
 *   holdshort doc ingest <pdf>                          OCR every page (cached by content hash)
 *   holdshort doc find <pdf> <regex>                    lines matching, with page numbers
 *   holdshort doc page <pdf> <n>                        one page's lines with token ids
 *   holdshort doc wb <pdf> --pages 88,90 --type C172 [--out aircraft/c172.wb.json]
 *                                                       extract W&B figures; unverifiable ones go to review
 *   holdshort wb <spec.json> --empty <lb> --empty-moment <per1000> [--front 340] [--rear 0]
 *                [--bag1 0] [--bag2 0] [--fuel 38] [--utility]
 *                                                       compute a loading against the extracted limits
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { basename } from 'node:path';
import { alignWbExtraction, buildWbRequest, pageLines, validateWbExtraction, WB_PROMPT_VERSION, wbContextHash, type ExtractedField } from '../docs/extract/wb.js';
import { downscalePng } from '../docs/crop.js';
import { ingestPdf, pageImagePath } from '../docs/reader/ingest.js';
import type { DocumentOcr } from '../docs/types.js';
import { llmFromEnv } from '../llm/env.js';
import { requestKey } from '../llm/provider.js';
import { computeLoading, IncompleteSpecError, loadingText } from '../wb/compute.js';
import type { CgEnvelope, DocumentCitation, Figure, Loading, ReviewItem, Station, WeightBalanceSpec } from '../wb/types.js';

const CACHE_DIR = process.env['HOLDSHORT_DOC_CACHE'] ?? 'data/docs';

function option(args: string[], name: string): string | null {
  const i = args.indexOf(name);
  return i >= 0 ? (args[i + 1] ?? null) : null;
}

async function loadDocument(pdf: string, pages: readonly number[] | null): Promise<DocumentOcr> {
  // `ingestPdf` returns the cache untouched when it already holds every page
  // asked for, and fills only the gaps otherwise, so let it decide.
  return ingestPdf(pdf, {
    cacheDir: CACHE_DIR,
    pages,
    onPage: (p, of, words, conf, rot, status) =>
      console.error(`page ${p}/${of}: ${status === 'failed' ? 'FAILED' : `${words} words, confidence ${conf}`}${rot ? `, read sideways (${rot}°)` : ''}`),
  });
}

export async function docCommand(args: string[]): Promise<void> {
  const [sub, pdf, ...rest] = args;
  if (!sub || !pdf) usage();
  switch (sub) {
    case 'ingest': {
      const doc = await loadDocument(pdf, null);
      const read = doc.pages.filter((p) => p.status === 'read');
      const blank = doc.pages.filter((p) => p.status === 'blank');
      const failed = doc.pages.filter((p) => p.status === 'failed');
      const mean = read.reduce((s, p) => s + p.meanConfidence, 0) / Math.max(1, read.length);
      console.log(
        `${doc.filename} ${doc.sha256.slice(0, 12)}: ${doc.pageCount} pages, ${read.length} read, mean confidence ${mean.toFixed(1)}, ${read.filter((p) => p.rotation).length} read sideways, ${blank.length} with no text, ${failed.length} failed`,
      );
      for (const p of failed) console.log(`  p${String(p.page).padStart(3)}  FAILED: ${p.error}`);
      for (const p of blank) console.log(`  p${String(p.page).padStart(3)}  no text recognised`);
      for (const p of read) console.log(`  p${String(p.page).padStart(3)}  ${String(p.words.length).padStart(4)} words  conf ${p.meanConfidence.toFixed(1).padStart(5)}${p.rotation ? `  rot ${p.rotation}` : ''}  ${p.lines[0]?.text.slice(0, 60) ?? ''}`);
      return;
    }
    case 'find': {
      const re = new RegExp(rest[0] ?? usage(), 'i');
      const doc = await loadDocument(pdf, null);
      for (const p of doc.pages) for (const l of p.lines) if (re.test(l.text)) console.log(`p${p.page}: ${l.text}`);
      return;
    }
    case 'page': {
      const n = Number(rest[0]);
      if (!Number.isInteger(n)) usage();
      const doc = await loadDocument(pdf, [n]);
      const page = doc.pages[n - 1]!;
      console.log(`page ${n}: ${page.words.length} words, confidence ${page.meanConfidence}${page.rotation ? `, read sideways (${page.rotation}°)` : ''}`);
      console.log(pageLines(page));
      return;
    }
    case 'wb':
      await extractWb(pdf, rest);
      return;
    default:
      usage();
  }
}

function usage(): never {
  console.error('usage: holdshort doc ingest|find|page|wb <pdf> ... | holdshort wb <spec.json> --empty <lb> --empty-moment <per1000> [--front lb] [--rear lb] [--bag1 lb] [--bag2 lb] [--fuel gal] [--utility]');
  process.exit(2);
}

/** Every figure the model returns, page by page, aligned; then the spec is assembled from what verified. */
async function extractWb(pdf: string, args: string[]): Promise<void> {
  const pagesArg = option(args, '--pages');
  if (!pagesArg) usage();
  const pages = pagesArg.split(',').map(Number);
  const type = option(args, '--type') ?? 'unknown';
  const out = option(args, '--out') ?? `aircraft/${type.toLowerCase()}.wb.json`;
  const llm = llmFromEnv();
  if (!llm) {
    console.error('no model configured: set HOLDSHORT_LLM=ollama and OLLAMA_MODEL (a vision model such as qwen2.5vl:3b reads the page image too)');
    process.exit(2);
  }
  const doc = await loadDocument(pdf, pages);
  const fields: ExtractedField[] = [];
  const summaries: string[] = [];
  for (const n of pages) {
    const page = doc.pages[n - 1]!;
    const imgPath = pageImagePath(CACHE_DIR, doc.sha256, n);
    const imagePx = Number(option(args, '--image-px') ?? 900);
    const withImage = args.includes('--no-image') ? null : existsSync(imgPath) ? await downscalePng(readFileSync(imgPath), imagePx) : null;
    const req = buildWbRequest(llm.model, doc, page, withImage);
    console.error(`page ${n}: asking ${llm.description} (${page.words.length} tokens${withImage ? `, with image ≤${imagePx}px` : ''}; request ${requestKey(req).slice(0, 12)}, context ${wbContextHash(doc, n).slice(0, 12)})`);
    let res;
    try {
      res = await llm.provider.complete(req);
    } catch (e) {
      console.error(`page ${n}: the model failed — ${(e as Error).message.slice(0, 160)}; nothing taken from this page`);
      continue;
    }
    const ex = validateWbExtraction(res.json);
    if (!ex) {
      console.error(`page ${n}: the model's answer did not fit the schema; nothing taken from this page`);
      continue;
    }
    summaries.push(`p${n}: ${ex.pageSummary}`);
    const aligned = alignWbExtraction(doc, n, ex);
    fields.push(...aligned);
    for (const f of aligned) {
      const v = typeof f.value === 'number' ? String(f.value) : `${f.value.weightLb} lb @ ${f.value.armIn} in`;
      const problem = f.alignment.problem ?? f.labelProblem;
      console.error(`  ${f.verified ? 'ok ' : '?? '} ${f.name.padEnd(28)} ${v.padStart(16)}  ${f.alignment.match.padEnd(10)} "${(f.context || f.quote).slice(0, 52)}"${problem ? `  — ${problem}` : ''}`);
    }
  }
  const spec = assembleSpec(type, doc, pages, fields);
  writeFileSync(out, JSON.stringify(spec, null, 2) + '\n');
  const verified = fields.filter((f) => f.verified).length;
  console.log(`${summaries.join('\n')}\n${verified} of ${fields.length} figures verified against the page; ${spec.review.length} for review. Written to ${out} (prompt v${WB_PROMPT_VERSION}, ${llm.model}).`);
  if (spec.review.length) console.log(`review: ${spec.review.map((r) => r.field).join(', ')}`);
}

function assembleSpec(type: string, doc: DocumentOcr, pages: readonly number[], fields: readonly ExtractedField[]): WeightBalanceSpec {
  const cite = (f: ExtractedField): DocumentCitation => ({ documentSha256: doc.sha256, filename: doc.filename, page: f.page, box: f.alignment.box, citedText: f.context || f.alignment.citedText });
  // The first verified figure for a name wins; a later page restating it is not a conflict worth a review item.
  const fig = (name: string): Figure | null => {
    const f = fields.find((x) => x.name === name && x.verified && typeof x.value === 'number');
    return f ? { value: f.value as number, source: cite(f), note: f.alignment.match === 'normalised' ? `read through OCR correction from "${f.alignment.citedText}"` : null } : null;
  };
  const points = (prefix: string) =>
    fields
      .filter((f) => f.name.startsWith(`${prefix}[`) && f.verified && typeof f.value === 'object')
      .map((f) => ({ ...(f.value as { weightLb: number; armIn: number }), source: cite(f) }))
      .sort((a, b) => a.weightLb - b.weightLb);
  const station = (id: string, label: string, kind: Station['kind'], arm: string, max: string | null, extra: Partial<Station> = {}): Station | null => {
    const armIn = fig(arm);
    if (!armIn) return null;
    return { id, label, kind, armIn, maxLb: max ? fig(max) : null, fuel: null, fixedLb: null, ...extra };
  };
  const lbPerGal = fig('fuelLbPerGal') ?? { value: 6, source: null, note: 'assumed 6 lb/US gal (the POH figure was not extracted)' };
  const stations = [
    station('front', 'Pilot and front passenger', 'seat', 'frontSeatArmIn', null),
    station('rear', 'Rear passengers', 'seat', 'rearSeatArmIn', null),
    station('bag1', 'Baggage area 1', 'baggage', 'baggage1ArmIn', 'baggage1MaxLb'),
    station('bag2', 'Baggage area 2', 'baggage', 'baggage2ArmIn', 'baggage2MaxLb'),
    fig('fuelArmIn') && fig('fuelStandardUsableGal') ? station('fuel', 'Fuel (standard tanks)', 'fuel', 'fuelArmIn', null, { fuel: { usableGal: fig('fuelStandardUsableGal')!, lbPerGal } }) : null,
    fig('oilArmIn') && fig('oilWeightLb') ? station('oil', 'Oil', 'oil', 'oilArmIn', null, { fixedLb: fig('oilWeightLb') }) : null,
  ].filter((s): s is Station => s !== null);
  const envelope = (category: CgEnvelope['category'], maxName: string, aftName: string, fwd: string): CgEnvelope | null => {
    const maxWeightLb = fig(maxName);
    const aftArmIn = fig(aftName);
    const forward = points(fwd);
    return maxWeightLb && aftArmIn && forward.length ? { category, maxWeightLb, forward, aftArmIn } : null;
  };
  const envelopes = [envelope('normal', 'maxTakeoffWeightNormalLb', 'cgAftNormalIn', 'cgForwardNormal'), envelope('utility', 'maxTakeoffWeightUtilityLb', 'cgAftUtilityIn', 'cgForwardUtility')].filter((e): e is CgEnvelope => e !== null);
  const review: ReviewItem[] = fields
    .filter((f) => !f.verified)
    .map((f) => ({ field: f.name, description: f.description, proposed: f.value, page: f.page, citedText: f.context || f.quote, box: f.alignment.box, problem: f.alignment.problem ?? f.labelProblem ?? 'not backed by the quoted line' }));
  const sampleW = fig('sampleEmptyWeightLb');
  const sampleM = fig('sampleEmptyMomentPer1000');
  return {
    version: 1,
    aircraftType: type,
    source: { documentSha256: doc.sha256, filename: doc.filename, pages: [...pages] },
    stations,
    envelopes,
    maxLandingWeightLb: fig('maxLandingWeightLb'),
    maxRampWeightLb: fig('maxRampWeightLb'),
    baggageCombinedMaxLb: fig('baggageCombinedMaxLb'),
    demonstratedCrosswindKt: fig('demonstratedCrosswindKt'),
    sample: sampleW && sampleM ? { emptyWeightLb: sampleW, emptyMomentPer1000: sampleM, totalWeightLb: null, totalMomentPer1000: null } : null,
    review,
  };
}

export async function wbCommand(args: string[]): Promise<void> {
  const file = args[0];
  if (!file) usage();
  const spec = JSON.parse(readFileSync(file, 'utf8')) as WeightBalanceSpec;
  const num = (name: string, fallback: number | null): number | null => {
    const v = option(args, name);
    return v === null ? fallback : Number(v);
  };
  const empty = num('--empty', spec.sample?.emptyWeightLb.value ?? null);
  const emptyMoment = num('--empty-moment', spec.sample?.emptyMomentPer1000.value ?? null);
  if (empty === null || emptyMoment === null) {
    console.error('need --empty <lb> and --empty-moment <per1000> from the aircraft W&B record');
    process.exit(2);
  }
  const usingSample = option(args, '--empty') === null;
  const loading: Loading = {
    emptyWeightLb: empty,
    emptyMomentPer1000: emptyMoment,
    stations: { front: num('--front', 0)!, rear: num('--rear', 0)!, bag1: num('--bag1', 0)!, bag2: num('--bag2', 0)! },
    fuelGal: { fuel: num('--fuel', 0)! },
    category: args.includes('--utility') ? 'utility' : 'normal',
  };
  try {
    const r = computeLoading(spec, loading);
    if (usingSample) console.log(`(empty weight ${empty} lb / moment ${emptyMoment} is the POH SAMPLE airplane — pass --empty and --empty-moment from your aircraft's W&B record)\n`);
    console.log(args.includes('--json') ? JSON.stringify(r, null, 2) : loadingText(r));
  } catch (e) {
    if (e instanceof IncompleteSpecError) {
      console.error(`${basename(file)}: ${e.message}${spec.review.length ? `\n${spec.review.length} figures await review in the spec; see "review".` : ''}`);
      process.exit(1);
    }
    throw e;
  }
}
