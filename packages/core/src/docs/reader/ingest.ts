/**
 * A PDF in, a content-addressed `DocumentOcr` out. Every page is rendered
 * and recognised once; the result and the page images live under
 * `<cacheDir>/<sha256>/` so a second run of any command over the same file
 * is a read. Scanned documents are the norm here (the POH is 148 page
 * images with no text layer), so OCR is always the path.
 *
 * A run may read the whole document or a few pages of it, may be
 * interrupted, and may be resumed. Whatever it does, it only ever adds: a
 * page another run already read is carried through untouched, and a
 * checkpoint written half way through a long run cannot downgrade a page
 * that was already read.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { groupLines } from '../lines.js';
import { DOC_READER_VERSION, PAGE_ID_STRIDE, type DocumentOcr, type PageOcr } from '../types.js';
import { createOcrEngine } from './ocr.js';
import { openPdf } from './render.js';

export interface IngestOptions {
  readonly cacheDir: string;
  /** Render scale over 72 dpi; 3 ≈ 216 dpi, what OCR of typewritten pages wants. */
  readonly scale?: number;
  readonly workers?: number;
  /** Only these 1-based pages; the rest are left for another run. */
  readonly pages?: readonly number[] | null;
  readonly onPage?: (page: number, ofPages: number, words: number, meanConfidence: number, rotation: number, status: PageOcr['status']) => void;
}

export function documentDir(cacheDir: string, sha256: string): string {
  return join(cacheDir, sha256);
}

export function pageImagePath(cacheDir: string, sha256: string, page: number): string {
  return join(documentDir(cacheDir, sha256), 'pages', `p${String(page).padStart(3, '0')}.png`);
}

/** A page nobody has successfully read yet, and that a later run should try. */
export function isPending(p: PageOcr | undefined): boolean {
  return !p || p.status === 'pending' || p.status === 'failed';
}

export function readCachedDocument(cacheDir: string, sha256: string): DocumentOcr | null {
  const p = join(documentDir(cacheDir, sha256), 'ocr.json');
  if (!existsSync(p)) return null;
  try {
    const doc = JSON.parse(readFileSync(p, 'utf8')) as DocumentOcr;
    return doc.reader?.readerVersion === DOC_READER_VERSION ? doc : null;
  } catch {
    // A cache damaged by an interrupted write is no cache; read the PDF again.
    return null;
  }
}

export function sha256Of(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

const PENDING_PAGE = (page: number): PageOcr => ({ page, widthPx: 0, heightPx: 0, words: [], lines: [], meanConfidence: 0, rotation: 0, status: 'pending', error: null });

/** Replace `ocr.json` in one step, so an interrupt leaves the old file intact. */
function writeDocument(dir: string, doc: DocumentOcr): void {
  const tmp = join(dir, 'ocr.json.tmp');
  writeFileSync(tmp, JSON.stringify(doc));
  renameSync(tmp, join(dir, 'ocr.json'));
}

export async function ingestPdf(path: string, opts: IngestOptions): Promise<DocumentOcr> {
  const bytes = new Uint8Array(readFileSync(path));
  const sha256 = sha256Of(bytes);
  const cached = readCachedDocument(opts.cacheDir, sha256);
  const wanted = opts.pages ? new Set(opts.pages) : null;
  if (cached) {
    const outstanding = (wanted ? [...wanted] : cached.pages.map((p) => p.page)).filter((p) => isPending(cached.pages[p - 1]));
    if (outstanding.length === 0) return cached;
  }

  const scale = opts.scale ?? 3;
  const dir = documentDir(opts.cacheDir, sha256);
  mkdirSync(join(dir, 'pages'), { recursive: true });
  const pdf = await openPdf(bytes);
  const ocr = await createOcrEngine({ workers: opts.workers ?? 2, cachePath: join(opts.cacheDir, 'tessdata'), dpi: 72 * scale });
  try {
    // Start from what is already known, so nothing this run does can lose it.
    const pages: PageOcr[] = Array.from({ length: pdf.pageCount }, (_, i) => cached?.pages[i] ?? PENDING_PAGE(i + 1));
    const document = (): DocumentOcr => ({
      sha256,
      filename: basename(path),
      pageCount: pdf.pageCount,
      reader: { engine: 'tesseract.js', version: ocr.version, lang: ocr.lang, scale, readerVersion: DOC_READER_VERSION },
      pages,
    });

    let since = 0;
    for (let page = 1; page <= pdf.pageCount; page++) {
      if (wanted && !wanted.has(page)) continue;
      if (!isPending(pages[page - 1])) continue;
      try {
        const r = await pdf.renderPage(page, scale);
        writeFileSync(pageImagePath(opts.cacheDir, sha256, page), r.png);
        const read = await ocr.readPage(r.png, page, page * PAGE_ID_STRIDE);
        if (read.words.length >= PAGE_ID_STRIDE) throw new Error(`page ${page} has ${read.words.length} words, more than the ${PAGE_ID_STRIDE} one id stride allows`);
        pages[page - 1] = {
          page,
          widthPx: r.widthPx,
          heightPx: r.heightPx,
          words: read.words,
          lines: groupLines(read.words, read.rotation, r.widthPx, r.heightPx),
          meanConfidence: read.meanConfidence,
          rotation: read.rotation,
          status: read.words.length > 0 ? 'read' : 'blank',
          error: null,
        };
      } catch (e) {
        // One bad page must not cost the other 147.
        pages[page - 1] = { ...PENDING_PAGE(page), status: 'failed', error: (e as Error).message };
      }
      const p = pages[page - 1]!;
      opts.onPage?.(page, pdf.pageCount, p.words.length, p.meanConfidence, p.rotation, p.status);
      if (++since >= 10) {
        writeDocument(dir, document());
        since = 0;
      }
    }
    const doc = document();
    writeDocument(dir, doc);
    return doc;
  } finally {
    await ocr.close();
    await pdf.close();
  }
}
