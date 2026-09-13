import { createCanvas, loadImage } from '@napi-rs/canvas';

export interface Box {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

/**
 * A region of a page image with the cited words boxed — what a reviewer
 * looks at to decide whether a figure was read right. Padding gives the
 * words their row and column; the frame marks exactly what was cited.
 */
export async function cropPageImage(png: Buffer, box: Box, padPx = 60): Promise<Buffer> {
  const img = await loadImage(png);
  const x0 = Math.max(0, Math.floor(box.x - padPx));
  const y0 = Math.max(0, Math.floor(box.y - padPx));
  const x1 = Math.min(img.width, Math.ceil(box.x + box.w + padPx));
  const y1 = Math.min(img.height, Math.ceil(box.y + box.h + padPx));
  const canvas = createCanvas(Math.max(1, x1 - x0), Math.max(1, y1 - y0));
  const ctx = canvas.getContext('2d');
  ctx.drawImage(img, x0, y0, canvas.width, canvas.height, 0, 0, canvas.width, canvas.height);
  ctx.strokeStyle = 'rgba(200, 30, 30, 0.9)';
  ctx.lineWidth = 3;
  ctx.strokeRect(box.x - x0 - 3, box.y - y0 - 3, box.w + 6, box.h + 6);
  return canvas.toBuffer('image/png');
}

/**
 * A page image small enough for a vision model to read in reasonable
 * time. The OCR ran on the full-resolution page; the model only needs to
 * see the layout and the figures, and it reads a 1,000-pixel-wide page of
 * typewritten text without trouble.
 */
export async function downscalePng(png: Buffer, maxSidePx: number): Promise<Buffer> {
  const img = await loadImage(png);
  const scale = Math.min(1, maxSidePx / Math.max(img.width, img.height));
  if (scale >= 1) return png;
  const canvas = createCanvas(Math.round(img.width * scale), Math.round(img.height * scale));
  const ctx = canvas.getContext('2d');
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
  return canvas.toBuffer('image/png');
}
