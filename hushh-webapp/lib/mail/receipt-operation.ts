/** A deadline revokes publication as well as releasing the caller. Late crypto
 * and IndexedDB work still sees the expired signal through the store guard. */
export async function withReceiptBudget<T>(work: (signal: AbortSignal) => Promise<T>, controller: AbortController, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  let abort: () => void = () => {};
  const stopped = new Promise<never>((_, reject) => {
    abort = () => reject(new DOMException("Mail update paused. Your saved receipts are safe.", "AbortError"));
    controller.signal.addEventListener("abort", abort, { once: true });
    timer = setTimeout(() => controller.abort(), ms);
  });
  try { return await Promise.race([Promise.resolve().then(() => work(controller.signal)), stopped]); }
  finally { clearTimeout(timer!); controller.signal.removeEventListener("abort", abort); }
}

