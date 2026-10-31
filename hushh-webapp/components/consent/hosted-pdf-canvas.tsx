"use client";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Button } from "@/lib/morphy-ux/button";
import { HelperText } from "@/components/app-ui/typography";
import { loadHostedPdf, renderHostedPdfPage } from "@/lib/consent/document-hosting-pdf";

export function HostedPdfCanvas({ bytes, signal, onRendered }: { bytes: Uint8Array; signal: AbortSignal; onRendered: () => void }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const [page, setPage] = useState(1); const [pages, setPages] = useState(0); const [error, setError] = useState(false);
  const [loaded, setLoaded] = useState<{ bytes: Uint8Array; signal: AbortSignal; pdf: Awaited<ReturnType<typeof loadHostedPdf>> } | null>(null);
  const [rendering, setRendering] = useState(true);
  const renderWork = useRef<Promise<void>>(Promise.resolve());
  const callback = useRef(onRendered);
  useLayoutEffect(() => { callback.current = onRendered; }, [onRendered]);
  useEffect(() => {
    const controller = new AbortController();
    const element = canvas.current;
    let pdf: Awaited<ReturnType<typeof loadHostedPdf>> | null = null;
    const abort = () => {
      if (controller.signal.aborted) return;
      controller.abort();
      void pdf?.loadingTask.destroy();
      if (element) { element.width = 0; element.height = 0; }
    };
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    setLoaded(null); setPage(1); setPages(0); setError(false); setRendering(true);
    void (async () => {
      pdf = await loadHostedPdf(bytes, controller.signal);
      if (controller.signal.aborted) { await pdf.loadingTask.destroy(); return; }
      setPages(pdf.numPages);
      setLoaded({ bytes, signal, pdf });
    })().catch(() => { if (!controller.signal.aborted) { setError(true); setRendering(false); } });
    return () => { signal.removeEventListener("abort", abort); abort(); };
  }, [bytes, signal]);
  useEffect(() => {
    if (!loaded || loaded.bytes !== bytes || loaded.signal !== signal || signal.aborted) return;
    const element = canvas.current;
    if (!element) return;
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal.addEventListener("abort", abort, { once: true });
    setRendering(true); setError(false);
    // Reuse the parsed document; finish cancellation before reusing its canvas.
    const render = renderWork.current.catch(() => {}).then(async () => {
      if (controller.signal.aborted) return;
      await renderHostedPdfPage(loaded.pdf, page, element, controller.signal);
      if (!controller.signal.aborted) { setRendering(false); callback.current(); }
    }).catch(() => {
      if (!controller.signal.aborted) {
        element.width = 0; element.height = 0;
        setError(true); setRendering(false);
      }
    });
    renderWork.current = render;
    return () => { controller.abort(); signal.removeEventListener("abort", abort); };
  }, [loaded, bytes, signal, page]);
  return <div className="min-w-0 space-y-3" aria-busy={rendering}>
    {error ? <HelperText role="alert">Preview unavailable. Download the file.</HelperText> : null}
    <div className="min-h-64">
      <HelperText role={rendering ? "status" : undefined} aria-hidden={!rendering}>{rendering ? "Opening preview…" : " "}</HelperText>
      <canvas ref={canvas} aria-label={`Document preview, page ${page}`} className="mx-auto h-auto max-w-full bg-white" />
    </div>
    {pages > 1 ? <div className="flex items-center justify-center gap-3">
      <Button size="compact" variant="none" disabled={rendering || page <= 1} onClick={() => setPage(value => value - 1)}>Previous page</Button>
      <HelperText>{page} of {pages}</HelperText>
      <Button size="compact" variant="none" disabled={rendering || page >= pages} onClick={() => setPage(value => value + 1)}>Next page</Button>
    </div> : null}
  </div>;
}
