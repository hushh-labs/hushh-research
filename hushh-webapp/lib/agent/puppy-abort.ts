/**
 * Give up on an operation the moment its signal aborts, whether or not the
 * operation itself listens for the signal.
 *
 * Several steps on the Puppy path (waking the private agent, for one) do not
 * take an abort signal yet. Racing them here is what keeps a deadline a
 * deadline: the caller stops waiting even while the step runs on. A late
 * result is discarded; nothing waits on it.
 */
export function whileNotAborted<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    operation.catch(() => undefined);
    return Promise.reject(signal.reason);
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason ?? new DOMException("aborted", "AbortError"));
    signal.addEventListener("abort", onAbort, { once: true });
    operation.then(
      (value) => { signal.removeEventListener("abort", onAbort); resolve(value); },
      (error) => { signal.removeEventListener("abort", onAbort); reject(error); },
    );
  });
}

/** A signal that aborts with a TimeoutError after `ms`, plus its cleanup. */
export function deadlineSignal(ms: number): { signal: AbortSignal; clear: () => void } {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new DOMException("deadline", "TimeoutError")), ms);
  return { signal: controller.signal, clear: () => clearTimeout(timer) };
}
