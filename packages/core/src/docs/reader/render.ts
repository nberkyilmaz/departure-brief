/**
 * PDF pages to PNG bytes. Uses pdf.js for the rendering and @napi-rs/canvas
 * for the pixels; both are pure prebuilt packages, no native compile step.
 */
import { createCanvas } from '@napi-rs/canvas';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { PDFDocumentProxy, PDFPageProxy } from 'pdfjs-dist/legacy/build/pdf.mjs';

/**
 * Scanned documents are usually JBIG2 or CCITT images, and pdf.js decodes
 * JBIG2 with a WebAssembly module it has to be told where to find.
 */
const WASM_URL = pathToFileURL(join(dirname(createRequire(import.meta.url).resolve('pdfjs-dist/package.json')), 'wasm')).href + '/';

type RenderParameters = Parameters<PDFPageProxy['render']>[0];

export interface OpenedPdf {
  readonly pageCount: number;
  renderPage(page: number, scale: number): Promise<{ png: Buffer; widthPx: number; heightPx: number }>;
  close(): Promise<void>;
}

export async function openPdf(bytes: Uint8Array): Promise<OpenedPdf> {
  /*
   * Loaded here rather than at the top of the file: pdf.js costs about
   * 108 MB of resident memory and a third of a second to import, and the
   * API — which imports this package transitively — never opens a PDF. On a
   * host with 512 MB that is a third of the budget for nothing.
   */
  const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const doc: PDFDocumentProxy = await getDocument({ data: bytes, useSystemFonts: false, wasmUrl: WASM_URL, verbosity: 0 }).promise;
  return {
    pageCount: doc.numPages,
    async renderPage(page, scale) {
      const p = await doc.getPage(page);
      const viewport = p.getViewport({ scale });
      const widthPx = Math.ceil(viewport.width);
      const heightPx = Math.ceil(viewport.height);
      const canvas = createCanvas(widthPx, heightPx);
      const ctx = canvas.getContext('2d');
      // pdf.js's canvas types are the DOM's; @napi-rs/canvas implements the same surface.
      const params = { canvasContext: ctx, viewport, canvas } as unknown as RenderParameters;
      await p.render(params).promise;
      p.cleanup();
      return { png: canvas.toBuffer('image/png'), widthPx, heightPx };
    },
    async close() {
      await doc.cleanup();
    },
  };
}
