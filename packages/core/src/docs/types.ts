/**
 * Documents a pilot owns as scans or photos — the POH, maintenance
 * logbook pages, weight-and-balance records — read into word boxes so
 * that anything extracted from them can be traced back to the exact
 * marks on the page. Nothing in this module interprets; it transcribes
 * what the OCR engine saw, with its own confidence, and keeps the geometry.
 */

/**
 * Word ids are `page * PAGE_ID_STRIDE + index`, so a page's words always
 * carry the same ids no matter which pages a run happened to read. An id
 * derived from a running counter would depend on run order, and reading
 * page 90 alone and then page 88 alone would hand both pages the same ids.
 */
export const PAGE_ID_STRIDE = 100_000;

/** One recognised word on one page, in pixels of the rendered page image. */
export interface WordBox {
  /** Unique within the document, and stable across runs: see `PAGE_ID_STRIDE`. */
  readonly id: number;
  readonly page: number;
  readonly text: string;
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
  /** The engine's own 0–100 confidence in this word. */
  readonly confidence: number;
}

/** Words grouped into a reading line by their vertical position, left to right. */
export interface TextLine {
  readonly page: number;
  readonly y: number;
  readonly wordIds: readonly number[];
  readonly text: string;
}

export interface PageOcr {
  /** 1-based, as a reader would cite it. */
  readonly page: number;
  readonly widthPx: number;
  readonly heightPx: number;
  readonly words: readonly WordBox[];
  readonly lines: readonly TextLine[];
  /** Mean word confidence, 0–100; the page-level "how much to trust this" number. */
  readonly meanConfidence: number;
  /** Degrees the page was turned clockwise to read it; boxes are in the unturned page's pixels regardless. */
  readonly rotation: 0 | 90 | 270;
  /**
   * How the page ended up in this state. `pending` is a page no run has
   * reached yet; `blank` is one that rendered but yielded no words, which a
   * separator page legitimately does and a bad render also does; `failed`
   * carries the error. Only `read` and `blank` count as done, so a failure
   * is retried rather than cached as an empty page forever.
   */
  readonly status: 'read' | 'blank' | 'failed' | 'pending';
  readonly error: string | null;
}

export interface DocumentOcr {
  /** Of the PDF bytes; the document's identity everywhere. */
  readonly sha256: string;
  readonly filename: string;
  readonly pageCount: number;
  readonly reader: {
    readonly engine: 'tesseract.js';
    readonly version: string;
    readonly lang: string;
    /** Render scale relative to PDF points (1 = 72 dpi). */
    readonly scale: number;
    readonly readerVersion: number;
  };
  readonly pages: readonly PageOcr[];
}

/** Bump when the rendering or OCR settings change in a way that changes word boxes. */
export const DOC_READER_VERSION = 2;
