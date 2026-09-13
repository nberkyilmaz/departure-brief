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
import { alignWbExtraction, buildWbRequest, findFigureOnPage, findFigureOnPages, pageLines, validateWbExtraction, WB_FIELDS, WB_PROMPT_VERSION, wbContextHash, type ExtractedField, type WbFieldSpec } from '../docs/extract/wb.js';
import { downscalePng } from '../docs/crop.js';
import { ingestPdf, pageImagePath, readCachedDocument } from '../docs/reader/ingest.js';
import type { DocumentOcr } from '../docs/types.js';
import { llmFromEnv } from '../llm/env.js';
import { requestKey } from '../llm/provider.js';
import { assembleWeightBalance, isCgPointName, missingFrom, type NamedFigure } from '../wb/assemble.js';
import { computeLoading, IncompleteSpecError, loadingText } from '../wb/compute.js';
import type { DocumentCitation, Loading, ReviewItem, WeightBalanceSpec } from '../wb/types.js';

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
  console.error(
    [
      'usage:',
      '  holdshort doc ingest|find|page <pdf> ...',
      '  holdshort doc wb <pdf> --pages 17,18 --type C172 [--out aircraft/c172.wb.json] [--no-image] [--image-px 900]',
      '  holdshort wb <spec.json> --empty <lb> --empty-moment <per1000> [--front lb] [--rear lb] [--bag1 lb] [--bag2 lb] [--fuel gal] [--utility] [--json]',
      '  holdshort wb confirm <spec.json> <field>=<value> [...] [--pages 17,18] [--on-my-word]',
      '        a CG limit point is written weight@arm, such as cgForwardNormal[1]=2300@38.5',
    ].join('\n'),
  );
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
  const existing = existsSync(out) ? (JSON.parse(readFileSync(out, 'utf8')) as WeightBalanceSpec) : null;
  // A figure the owner already confirmed is not re-proposed away by a new run.
  const carried = (existing?.figures ?? []).filter((f) => (f.note ?? '').startsWith(CONFIRMED_NOTE));
  const spec = specFrom(type, doc, pages, fields, carried);
  writeFileSync(out, JSON.stringify(spec, null, 2) + '\n');
  const verified = fields.filter((f) => f.verified).length;
  console.log(`${summaries.join('\n')}\n${verified} of ${fields.length} figures verified against the page; ${spec.review.length} for review. Written to ${out} (prompt v${WB_PROMPT_VERSION}, ${llm.model}).`);
  if (spec.review.length) console.log(`review: ${spec.review.map((r) => r.field).join(', ')}`);
}

/** Everything verified becomes a figure; everything else becomes a review item. */
function specFrom(type: string, doc: DocumentOcr, pages: readonly number[], fields: readonly ExtractedField[], carried: readonly NamedFigure[] = []): WeightBalanceSpec {
  const cite = (f: ExtractedField): DocumentCitation => ({ documentSha256: doc.sha256, filename: doc.filename, page: f.page, box: f.alignment.box, citedText: f.context || f.alignment.citedText });
  const found: NamedFigure[] = fields
    .filter((f) => f.verified)
    .map((f) => ({ name: f.name, value: f.value, source: cite(f), note: f.alignment.match === 'normalised' ? `read through OCR correction from "${f.alignment.citedText}"` : null }));
  const review: ReviewItem[] = fields
    .filter((f) => !f.verified)
    .map((f) => ({ field: f.name, description: f.description, proposed: f.value, page: f.page, citedText: f.context || f.quote, box: f.alignment.box, problem: f.alignment.problem ?? f.labelProblem ?? 'not backed by the quoted line' }));
  // Carried figures go last, so a confirmation by the owner outranks a fresh reading.
  return assembleWeightBalance(
    type,
    { documentSha256: doc.sha256, filename: doc.filename, pages: [...pages] },
    [...found, ...carried],
    review.filter((r) => !carried.some((c) => c.name === r.field)),
  );
}

const CONFIRMED_NOTE = 'confirmed by hand against the handbook';

/**
 * Confirm a figure the extraction could not. The owner reads the page and
 * says what it states; the handbook still has to agree. Same three checks,
 * with the owner as the proposer instead of a model.
 *
 *   holdshort wb confirm aircraft/c172.wb.json cgAftNormalIn=47.3 frontSeatArmIn=37
 *   holdshort wb confirm aircraft/c172.wb.json cgForwardNormal[1]=2300@38.5
 */
async function confirmFigures(args: string[]): Promise<void> {
  const file = args[0];
  if (!file || !existsSync(file)) usage();
  const spec = JSON.parse(readFileSync(file, 'utf8')) as WeightBalanceSpec;
  if (!spec.source) {
    console.error(`${basename(file)} was not read from a document, so there is nothing to check a figure against`);
    process.exit(2);
  }
  const doc = readCachedDocument(CACHE_DIR, spec.source.documentSha256);
  if (!doc) {
    console.error(`${spec.source.filename} is not in ${CACHE_DIR}; run "holdshort doc ingest ${spec.source.filename}" first`);
    process.exit(2);
  }
  /*
   * Search the pages the data was read from, not the whole handbook. Asked
   * for the fuel arm across all 148 pages, the first line printing 48 beside
   * the word "tank" was "Total Usable: 48 gallons" — the right number, the
   * wrong ink. A citation that points at the wrong figure is worse than none.
   */
  const pagesArg = option(args, '--pages');
  const namedPages = pagesArg ? pagesArg.split(',').map(Number).filter(Number.isInteger) : null;
  const searchPages = namedPages ?? spec.source.pages;
  const onMyWord = args.includes('--on-my-word');

  const kept: NamedFigure[] = [...spec.figures];
  const stillReview = [...spec.review];
  let changed = 0;
  for (const arg of args.slice(1).filter((a) => a.includes('='))) {
    const name = arg.slice(0, arg.indexOf('='));
    const raw = arg.slice(arg.indexOf('=') + 1);
    const point = /^(-?[\d.]+)@(-?[\d.]+)$/.exec(raw);
    const numbers = point ? [Number(point[1]), Number(point[2])] : [Number(raw)];
    if (numbers.some((n) => !Number.isFinite(n))) {
      console.error(`  ?? ${name}: "${raw}" is not a number${point ? '' : ' (a CG point is written weight@arm, such as 2300@38.5)'}`);
      continue;
    }
    const fieldSpec: WbFieldSpec | undefined = isCgPointName(name)
      ? {
          description: `${name.startsWith('cgForwardNormal') ? 'normal' : 'utility'} category forward CG limit point (weight lb, arm in)`,
          keywords: [['forward', 'variation', 'inches']],
          category: name.startsWith('cgForwardNormal') ? 'normal' : 'utility',
        }
      : WB_FIELDS[name as keyof typeof WB_FIELDS];
    if (!fieldSpec) {
      console.error(`  ?? ${name}: not a figure this understands. Known: ${Object.keys(WB_FIELDS).join(', ')}, cgForwardNormal[n], cgForwardUtility[n]`);
      continue;
    }
    let found = findFigureOnPages(doc, searchPages, name, fieldSpec, numbers);
    // Only where the owner names a page does the weaker check apply: the
    // handbook prints some figures in diagrams, where no label shares the row.
    if (!found && namedPages) {
      for (const page of namedPages) {
        found = findFigureOnPage(doc, page, name, fieldSpec, numbers);
        if (found) break;
      }
    }
    if (!found && !onMyWord) {
      const where = namedPages ? `page ${namedPages.join(' or ')}` : `pages ${searchPages.join(', ')} of ${doc.filename}`;
      console.error(
        `  ?? ${name} = ${raw}: ${where} does not print that${namedPages ? '' : ` beside words naming ${name}. Name the page with --pages if you have read it there.`}` +
          `${namedPages ? ' — if the scan is too poor to read there, repeat with --on-my-word and it will be recorded as your figure, not the handbook\'s.' : ''}`,
      );
      continue;
    }
    /*
     * Three strengths, and the spec records which. The handbook states it
     * beside a label; the handbook prints it on a page the owner names; or
     * the owner states it and the scan cannot corroborate — which is the
     * honest answer for figures printed in a diagram, where this handbook
     * OCRs to nothing usable.
     */
    const citation: DocumentCitation | null = found
      ? { documentSha256: doc.sha256, filename: doc.filename, page: found.page, box: found.alignment.box, citedText: found.context }
      : null;
    const onOwnersWord = !found || found.labelProblem !== null;
    const value = found ? found.value : numbers.length === 2 ? { weightLb: numbers[0]!, armIn: numbers[1]! } : numbers[0]!;
    const note = !found
      ? `entered by hand from the page image; the scan of ${doc.filename} does not print this legibly, so nothing here corroborates it — check it against your handbook`
      : `${CONFIRMED_NOTE}, ${doc.filename} p.${found.page}${found.labelProblem !== null ? ' (the page prints the figure, but nothing on its line names the field)' : ''}`;
    const figure: NamedFigure = { name, value, source: citation, note };
    const at = kept.findIndex((f) => f.name === name);
    if (at >= 0) kept[at] = figure;
    else kept.push(figure);
    const r = stillReview.findIndex((x) => x.field === name);
    if (r >= 0) stillReview.splice(r, 1);
    changed++;
    console.log(
      found
        ? `  ${onOwnersWord ? 'ok?' : 'ok '} ${name} = ${raw}  p.${found.page}  "${found.context.slice(0, 58)}"${onOwnersWord ? '  (your word: no label on that line)' : ''}`
        : `  ok? ${name} = ${raw}  your figure; the scan cannot corroborate it`,
    );
  }

  if (changed === 0) {
    console.error('nothing confirmed');
    process.exit(1);
  }
  const next = assembleWeightBalance(spec.aircraftType, spec.source, kept, stillReview);
  writeFileSync(file, JSON.stringify(next, null, 2) + '\n');
  const missing = missingFrom(next);
  console.log(`${changed} confirmed; ${next.figures.length} figures now, ${next.review.length} still in review. Written to ${file}.`);
  console.log(missing.length === 0 ? 'The loading computation now has everything it needs.' : `Still missing:\n${missing.map((m) => `  - ${m}`).join('\n')}`);
}

export async function wbCommand(args: string[]): Promise<void> {
  if (args[0] === 'confirm') return confirmFigures(args.slice(1));
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
