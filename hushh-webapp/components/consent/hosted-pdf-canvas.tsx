"use client";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Button } from "@/lib/morphy-ux/button";
import { HelperText } from "@/components/app-ui/typography";
import { loadHostedPdf, renderHostedPdfPage } from "@/lib/consent/document-hosting-pdf";

export function HostedPdfCanvas({ bytes, signal, onRendered }: { bytes: Uint8Array; signal: AbortSignal; onRendered: () => void }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const [page, setPage] = useState(1); const [pages, setPages] = useState(0); const [error, setError] = useState(false);
  const callback = useRef(onRendered);
  useLayoutEffect(() => { callback.current = onRendered; }, [onRendered]);
  useEffect(() => {
    const controller = new AbortController();
    const element = canvas.current;
    const abort = () => controller.abort(); signal.addEventListener("abort", abort, { once: true });
    let pdf: Awaited<ReturnType<typeof loadHostedPdf>> | null = null;
    setError(false);
    void (async () => {
      pdf = await loadHostedPdf(bytes, controller.signal);
      if (controller.signal.aborted) { await pdf.loadingTask.destroy(); return; }
      setPages(pdf.numPages);
      if (element) await renderHostedPdfPage(pdf, page, element, controller.signal);
      if (!controller.signal.aborted) callback.current();
    })().catch(() => { if (!controller.signal.aborted) setError(true); });
    return () => { controller.abort(); signal.removeEventListener("abort", abort); void pdf?.loadingTask.destroy(); if (element) { element.width = 0; element.height = 0; } };
  }, [bytes, signal, page]);
  return <div className="min-w-0 space-y-3">
    {error ? <HelperText role="alert">Preview unavailable. Download the file.</HelperText> : null}
    <canvas ref={canvas} aria-label={`Document preview, page ${page}`} className="mx-auto h-auto max-w-full bg-white" />
    {pages > 1 ? <div className="flex items-center justify-center gap-3">
      <Button size="compact" variant="none" disabled={page <= 1} onClick={() => setPage(value => value - 1)}>Previous page</Button>
      <HelperText>{page} of {pages}</HelperText>
      <Button size="compact" variant="none" disabled={page >= pages} onClick={() => setPage(value => value + 1)}>Next page</Button>
    </div> : null}
  </div>;
}
