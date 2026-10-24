export function pause(signal: AbortSignal, milliseconds: number) {
  return new Promise<void>((resolve, reject) => {
    const abort = () => {
      clearTimeout(timer);
      reject(new DOMException("Aborted", "AbortError"));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", abort);
      resolve();
    }, milliseconds);
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
  });
}
/** A hidden tab does not poll; research resumes when the owner returns. */
export function whenVisible(signal: AbortSignal) {
  if (typeof document === "undefined" || !document.hidden)
    return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    const cleanup = () => {
      document.removeEventListener("visibilitychange", show);
      signal.removeEventListener("abort", abort);
    };
    const show = () => {
      if (document.hidden) return;
      cleanup();
      resolve();
    };
    const abort = () => {
      cleanup();
      reject(new DOMException("Aborted", "AbortError"));
    };
    document.addEventListener("visibilitychange", show);
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
  });
}
