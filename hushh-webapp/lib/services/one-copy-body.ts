import { withDeadline } from "@/lib/utils/with-deadline";
import { requireDocumentSession, type DocumentSession } from "./document-hosting-service";

/** Headers, body, hash and final entitlement share this budget before native handoff. */
export const ONE_COPY_OPEN_BUDGET_MS = 60_000;
export async function withOneCopyDeadline<T>(signal: AbortSignal, deadline: number, read: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  const abort = () => controller.abort(signal.reason);
  signal.addEventListener("abort", abort, { once: true });
  if (signal.aborted) abort();
  try { return await withDeadline(read(controller.signal), deadline); }
  finally { controller.abort(); signal.removeEventListener("abort", abort); }
}

/** Fetch's header timeout does not own its body. Keep this reader cancellable until complete. */
export async function readOneCopyBytes(response: Response, session: DocumentSession, signal: AbortSignal, deadline: number): Promise<Uint8Array> {
  requireDocumentSession(session, signal);
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader(); const chunks: Uint8Array[] = [];
  let retired = false; let length = 0; let rejectAbort!: (reason: unknown) => void;
  const stopped = new Promise<never>((_, reject) => { rejectAbort = reject; });
  const cancel = () => { void reader.cancel().catch(() => undefined); };
  const abort = () => { cancel(); rejectAbort(new DOMException("Read cancelled", "AbortError")); };
  signal.addEventListener("abort", abort, { once: true });
  if (signal.aborted) abort();
  const timer = setInterval(() => { if (!session.isCurrent()) abort(); }, 1000);
  const read = async () => {
    for (;;) {
      const chunk = await reader.read();
      if (retired || signal.aborted || !session.isCurrent()) { chunk.value?.fill(0); throw new DOMException("Read cancelled", "AbortError"); }
      if (chunk.done) break;
      chunks.push(chunk.value); length += chunk.value.byteLength;
    }
    requireDocumentSession(session, signal);
    const bytes = new Uint8Array(length); let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    return bytes;
  };
  try { return await withDeadline(Promise.race([read(), stopped]), deadline); }
  finally {
    retired = true; clearInterval(timer); signal.removeEventListener("abort", abort);
    chunks.forEach(chunk => chunk.fill(0)); cancel();
    try { reader.releaseLock(); } catch { /* A non-abortable bridge may still settle; read() erases its late chunk. */ }
  }
}
export async function readOneCopyJson(response: Response, session: DocumentSession, signal?: AbortSignal, deadline = Date.now() + ONE_COPY_OPEN_BUDGET_MS) {
  const bytes = await readOneCopyBytes(response, session, signal ?? new AbortController().signal, deadline);
  try { return JSON.parse(new TextDecoder().decode(bytes)); }
  finally { bytes.fill(0); }
}
