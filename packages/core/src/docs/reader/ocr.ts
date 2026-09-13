/**
 * Word boxes from a page image, via tesseract.js (WebAssembly; no system
 * Tesseract needed). Language data is fetched once and cached on disk.
 *
 * Scanned manuals print their tables and charts sideways, so a page is
 * recognised as it is and, when that reads badly, rotated both ways and
 * the best reading kept. Boxes are always reported in the coordinates of
 * the page as scanned, so a highlight lands on the right ink either way.
 */
import { createCanvas, loadImage } from '@napi-rs/canvas';
import { createRequire } from 'node:module';
import { createScheduler, createWorker, type Scheduler } from 'tesseract.js';
import type { WordBox } from '../types.js';

/** Degrees the image was turned clockwise before it read well. */
export type Rotation = 0 | 90 | 270;

export interface PageReading {
  readonly words: WordBox[];
  readonly rotation: Rotation;
  readonly meanConfidence: number;
}

export interface OcrEngine {
  readonly version: string;
  readonly lang: string;
  /** Recognise one page, trying rotations when the upright reading is poor. */
  readPage(png: Buffer, page: number, firstId: number): Promise<PageReading>;
  close(): Promise<void>;
}

interface TessWord {
  text: string;
  confidence: number;
  bbox: { x0: number; y0: number; x1: number; y1: number };
}
interface TessBlock {
  paragraphs: { lines: { words: TessWord[] }[] }[];
}

/** Below this mean confidence the upright reading is suspect enough to try the page sideways. */
const ROTATE_BELOW = 75;

export async function rotatePng(png: Buffer, rotation: Rotation): Promise<{ png: Buffer; width: number; height: number }> {
  const img = await loadImage(png);
  if (rotation === 0) return { png, width: img.width, height: img.height };
  const canvas = createCanvas(img.height, img.width);
  const ctx = canvas.getContext('2d');
  ctx.translate(canvas.width / 2, canvas.height / 2);
  ctx.rotate((rotation * Math.PI) / 180);
  ctx.drawImage(img, -img.width / 2, -img.height / 2);
  return { png: canvas.toBuffer('image/png'), width: canvas.width, height: canvas.height };
}

/** A box in the rotated image, back into the coordinates of the page as scanned (W × H). */
export function unrotateBox(b: { x: number; y: number; w: number; h: number }, rotation: Rotation, W: number, H: number): { x: number; y: number; w: number; h: number } {
  switch (rotation) {
    case 0:
      return b;
    case 90:
      // Clockwise: scanned (x, y) went to (H - y, x).
      return { x: b.y, y: H - (b.x + b.w), w: b.h, h: b.w };
    case 270:
      // Counter-clockwise: scanned (x, y) went to (y, W - x).
      return { x: W - (b.y + b.h), y: b.x, w: b.h, h: b.w };
  }
}

export async function createOcrEngine(opts: { lang?: string; workers?: number; cachePath: string; dpi: number }): Promise<OcrEngine> {
  const lang = opts.lang ?? 'eng';
  const n = Math.max(1, opts.workers ?? 2);
  const scheduler: Scheduler = createScheduler();
  for (let i = 0; i < n; i++) {
    const worker = await createWorker(lang, 1, { cachePath: opts.cachePath });
    /*
     * Rendered PNGs carry no resolution, and Tesseract then assumes 70 dpi
     * and mis-sizes everything. Telling it the real figure was worth more
     * than any other setting on the POH scan: 12 of 18 key numbers on the
     * sample loading page read correctly, against 4 to 8 without it.
     * Page segmentation stays automatic (mode 3), which beat the
     * single-block and sparse modes on the same page.
     */
    await worker.setParameters({ user_defined_dpi: String(Math.round(opts.dpi)), tessedit_pageseg_mode: '3' as never });
    scheduler.addWorker(worker);
  }
  const require = createRequire(import.meta.url);
  const version = (require('tesseract.js/package.json') as { version: string }).version;

  async function recognise(png: Buffer): Promise<TessWord[]> {
    const result = (await scheduler.addJob('recognize', png, {}, { blocks: true, text: false })) as { data: { blocks: TessBlock[] | null } };
    const out: TessWord[] = [];
    for (const b of result.data.blocks ?? []) for (const para of b.paragraphs) for (const line of para.lines) for (const w of line.words) if (w.text.trim()) out.push(w);
    return out;
  }

  const meanOf = (ws: TessWord[]) => (ws.length ? ws.reduce((s, w) => s + w.confidence, 0) / ws.length : 0);
  // A handful of confident words must not beat a full page of good ones.
  const score = (ws: TessWord[]) => meanOf(ws) * Math.min(1, ws.length / 40);

  return {
    version,
    lang,
    async readPage(png, page, firstId) {
      const upright = await rotatePng(png, 0);
      const W = upright.width;
      const H = upright.height;
      const candidates: { rotation: Rotation; words: TessWord[] }[] = [{ rotation: 0, words: await recognise(png) }];
      if (meanOf(candidates[0]!.words) < ROTATE_BELOW || candidates[0]!.words.length < 20) {
        for (const rotation of [90, 270] as const) {
          const r = await rotatePng(png, rotation);
          candidates.push({ rotation, words: await recognise(r.png) });
        }
      }
      const best = candidates.reduce((a, b) => (score(b.words) > score(a.words) ? b : a));
      let id = firstId;
      const words: WordBox[] = best.words.map((w) => {
        const box = unrotateBox({ x: w.bbox.x0, y: w.bbox.y0, w: w.bbox.x1 - w.bbox.x0, h: w.bbox.y1 - w.bbox.y0 }, best.rotation, W, H);
        return { id: id++, page, text: w.text.trim(), ...box, confidence: Math.round(w.confidence * 10) / 10 };
      });
      return { words, rotation: best.rotation, meanConfidence: Math.round(meanOf(best.words) * 10) / 10 };
    },
    async close() {
      await scheduler.terminate();
    },
  };
}
