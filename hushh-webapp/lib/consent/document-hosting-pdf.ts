import { DOCUMENT_FILE_LIMIT, documentHash } from "./document-hosting-crypto";
import type { PDFDocumentProxy } from "pdfjs-dist";

export const DOCUMENT_PDF_MAX_PAGES = 40;
const MAX_PAGE_PIXELS = 4_000_000;
export async function loadHostedPdf(bytes: Uint8Array, signal: AbortSignal): Promise<PDFDocumentProxy> {
  signal.throwIfAborted();
  if (!bytes.length || bytes.length > DOCUMENT_FILE_LIMIT || new TextDecoder().decode(bytes.subarray(0, 5)) !== "%PDF-")
    throw new Error("document_pdf_unsupported");
  const pdfjs = await import("pdfjs-dist");
  signal.throwIfAborted();
  pdfjs.GlobalWorkerOptions.workerSrc = new URL("pdfjs-dist/build/pdf.worker.min.mjs", import.meta.url).toString();
  const loading = pdfjs.getDocument({ data: new Uint8Array(bytes), enableXfa: false, useWasm: false, verbosity: 0, stopAtErrors: true });
  const abort = () => { void loading.destroy(); };
  signal.addEventListener("abort", abort, { once: true });
  try {
    const pdf = await loading.promise;
    signal.throwIfAborted();
    if (pdf.numPages < 1 || pdf.numPages > DOCUMENT_PDF_MAX_PAGES) { await pdf.loadingTask.destroy(); throw new Error("document_pdf_page_limit"); }
    return pdf;
  } finally { signal.removeEventListener("abort", abort); }
}
export async function renderHostedPdfPage(pdf: PDFDocumentProxy, pageNumber: number, canvas: HTMLCanvasElement, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  const page = await pdf.getPage(pageNumber);
  const original = page.getViewport({ scale: 1 });
  const scale = Math.min(1.5, Math.sqrt(MAX_PAGE_PIXELS / (original.width * original.height)));
  const viewport = page.getViewport({ scale });
  if (!Number.isFinite(viewport.width) || !Number.isFinite(viewport.height) || viewport.width <= 0 || viewport.height <= 0)
    throw new Error("document_pdf_page_invalid");
  canvas.width = Math.ceil(viewport.width); canvas.height = Math.ceil(viewport.height);
  const context = canvas.getContext("2d");
  if (!context) throw new Error("document_preview_unavailable");
  const task = page.render({ canvas, canvasContext: context, viewport });
  const abort = () => task.cancel(); signal.addEventListener("abort", abort, { once: true });
  try { await task.promise; signal.throwIfAborted(); }
  finally { signal.removeEventListener("abort", abort); page.cleanup(); }
}

/** Raster preview on a NEW PDF: never edits the source or its digital signatures. */
export async function prepareHostedPdf(original: Uint8Array, watermark: string, signal: AbortSignal, onPage?: (done: number, total: number) => void): Promise<{ originalHash: string; watermarked: Uint8Array }> {
  const pdf = await loadHostedPdf(original, signal);
  const canvas = document.createElement("canvas");
  try {
    const { PDFDocument, StandardFonts, rgb, degrees } = await import("pdf-lib");
    const derivative = await PDFDocument.create();
    const font = await derivative.embedFont(StandardFonts.Helvetica);
    const label = watermark.replace(/[^\x20-\x7e]/g, "?").slice(0, 140);
    for (let index = 1; index <= pdf.numPages; index++) {
      signal.throwIfAborted();
      await renderHostedPdfPage(pdf, index, canvas, signal);
      const blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob(value => value ? resolve(value) : reject(new Error("document_preview_unavailable")), "image/png"));
      signal.throwIfAborted();
      const image = await derivative.embedPng(await blob.arrayBuffer());
      const page = derivative.addPage([canvas.width, canvas.height]);
      page.drawImage(image, { x: 0, y: 0, width: canvas.width, height: canvas.height });
      const size = Math.max(10, Math.min(18, canvas.width / 45));
      for (let y = 40; y < canvas.height; y += Math.max(160, canvas.height / 4))
        page.drawText(label, { x: 20, y, size, font, color: rgb(0.25, 0.25, 0.25), opacity: 0.22, rotate: degrees(12), maxWidth: canvas.width - 40 });
      onPage?.(index, pdf.numPages);
      canvas.width = 0; canvas.height = 0;
    }
    const watermarked = await derivative.save();
    signal.throwIfAborted();
    if (watermarked.length > DOCUMENT_FILE_LIMIT) { watermarked.fill(0); throw new Error("document_preview_size_limit"); }
    return { originalHash: await documentHash(original), watermarked };
  } finally { canvas.width = 0; canvas.height = 0; canvas.remove(); await pdf.loadingTask.destroy(); }
}
