// The drawing under the plan: an image or a PDF page, placed and scaled in plan metres.
// The picture itself is kept in the browser (IndexedDB) so it survives a reload; where it sits
// (its transform) is part of the plan, in plan.source.

export interface UnderlayImage {
  blob: Blob;
  url: string;
  /** Pixel size. */
  width: number;
  height: number;
  name: string;
  page?: number;
  kind: 'image' | 'pdf';
}

/** Image pixel (x, y down) → plan metres: x' = e + s·x, y' = f − s·y. Stored as [s, 0, 0, −s, e, f]. */
export type UnderlayTransform = [number, number, number, number, number, number];

export function defaultTransform(width: number): UnderlayTransform {
  // a typical flat plan sheet shows about 15 m across; calibration fixes the real scale
  const s = 15 / Math.max(1, width);
  return [s, 0, 0, -s, 0, 0];
}

export const toPlan = (t: UnderlayTransform, x: number, y: number): [number, number] => [t[4] + t[0] * x, t[5] + t[3] * y];

const PDF_TARGET = 3000; // pixels along the longer side of a rendered PDF page

export async function readUnderlayFile(file: File, page = 1): Promise<UnderlayImage> {
  const isPdf = file.type === 'application/pdf' || /\.pdf$/i.test(file.name);
  if (isPdf) return renderPdf(file, page);
  const blob = file.slice(0, file.size, file.type);
  const { width, height } = await imageSize(blob);
  return { blob, url: URL.createObjectURL(blob), width, height, name: file.name, kind: 'image' };
}

export async function pdfPageCount(file: Blob): Promise<number> {
  const pdfjs = await loadPdfJs();
  const task = pdfjs.getDocument({ data: new Uint8Array(await file.arrayBuffer()) });
  const n = (await task.promise).numPages;
  await task.destroy();
  return n;
}

async function loadPdfJs() {
  const pdfjs = await import('pdfjs-dist');
  const worker = await import('pdfjs-dist/build/pdf.worker.min.mjs?url');
  pdfjs.GlobalWorkerOptions.workerSrc = worker.default;
  return pdfjs;
}

async function renderPdf(file: File, pageNo: number): Promise<UnderlayImage> {
  const pdfjs = await loadPdfJs();
  const task = pdfjs.getDocument({ data: new Uint8Array(await file.arrayBuffer()) });
  const doc = await task.promise;
  const page = await doc.getPage(Math.min(Math.max(1, pageNo), doc.numPages));
  const base = page.getViewport({ scale: 1 });
  const scale = PDF_TARGET / Math.max(base.width, base.height);
  const viewport = page.getViewport({ scale });
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(viewport.width);
  canvas.height = Math.round(viewport.height);
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  await page.render({ canvas, canvasContext: ctx, viewport }).promise;
  await task.destroy();
  const blob = await new Promise<Blob>((res, rej) => canvas.toBlob((b) => (b ? res(b) : rej(new Error('render failed'))), 'image/png'));
  return { blob, url: URL.createObjectURL(blob), width: canvas.width, height: canvas.height, name: file.name, page: pageNo, kind: 'pdf' };
}

function imageSize(blob: Blob): Promise<{ width: number; height: number }> {
  return new Promise((res, rej) => {
    const img = new Image();
    const url = URL.createObjectURL(blob);
    img.onload = () => { res({ width: img.naturalWidth, height: img.naturalHeight }); URL.revokeObjectURL(url); };
    img.onerror = () => { rej(new Error('not an image')); URL.revokeObjectURL(url); };
    img.src = url;
  });
}

// ---------------------------------------------------------------- browser storage

const DB = 'layout';
const STORE = 'underlay';

function db(): Promise<IDBDatabase> {
  return new Promise((res, rej) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => res(req.result);
    req.onerror = () => rej(req.error);
  });
}

export async function saveUnderlay(u: UnderlayImage | null): Promise<void> {
  try {
    const d = await db();
    const tx = d.transaction(STORE, 'readwrite');
    const s = tx.objectStore(STORE);
    if (u) s.put({ blob: u.blob, width: u.width, height: u.height, name: u.name, page: u.page, kind: u.kind }, 'current');
    else s.delete('current');
    await new Promise((res, rej) => { tx.oncomplete = res; tx.onerror = () => rej(tx.error); });
    d.close();
  } catch {
    /* private mode or storage blocked: the underlay just won't survive a reload */
  }
}

export async function restoreUnderlay(): Promise<UnderlayImage | null> {
  try {
    const d = await db();
    const tx = d.transaction(STORE, 'readonly');
    const req = tx.objectStore(STORE).get('current');
    const v = await new Promise<{ blob: Blob; width: number; height: number; name: string; page?: number; kind: 'image' | 'pdf' } | undefined>((res, rej) => {
      req.onsuccess = () => res(req.result);
      req.onerror = () => rej(req.error);
    });
    d.close();
    if (!v) return null;
    return { ...v, url: URL.createObjectURL(v.blob) };
  } catch {
    return null;
  }
}
