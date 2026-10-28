import { toast, type ToastT } from "sonner";

export const NATIVE_FEEDBACK_TOASTER_ID = "native-owned-feedback";
export type NativePresentationFeedback = {
  id: string; message: string; tone: "normal" | "loading" | "success" | "error" | "warning" | "info"; dismissible: boolean;
};
export type NativeFeedbackScope = "presentation" | "workspace";
let captureScope: NativeFeedbackScope = "presentation";
/** The operation owner may explicitly outlive a child sheet, within this route. */
export function withNativeFeedbackScope<T>(scope: NativeFeedbackScope, create: () => T): T {
  const previous = captureScope; captureScope = scope;
  try { return create(); } finally { captureScope = previous; }
}
type Sink = {
  capture: (scope: NativeFeedbackScope) => string | null; ready: (key: string) => boolean;
  show: (key: string, message: NativePresentationFeedback) => void;
  hide: (key: string, id: string) => void;
};
type Entry = { sink: Sink; scope: NativeFeedbackScope; key: string; fingerprint: string; observed: boolean; timer?: ReturnType<typeof setTimeout> };
const sinks = new Set<Sink>(), entries = new Map<string, Entry>();

/** Private text-only notifications for a complete retained presentation.
 * Sonner retains promise/outcome ownership. The owning scene renders the
 * banner inside its acknowledged native subtree, above covered chrome. */
export function retainNativeFeedbackSink(sink: Sink) {
  sinks.add(sink);
  return () => { sinks.delete(sink); for (const [id, entry] of entries) if (entry.sink === sink) dismissNativeSinkFeedback(id); };
}
export function nativeSinkFeedbackOptions(): { id: string; toasterId: string } | undefined {
  for (const sink of [...sinks].reverse()) {
    const key = sink.capture(captureScope); if (!key) continue;
    const id = `native-feedback-${crypto.randomUUID()}`;
    entries.set(id, { sink, scope: captureScope, key, fingerprint: "", observed: false });
    return { id, toasterId: NATIVE_FEEDBACK_TOASTER_ID };
  }
  return undefined;
}
export function isNativeSinkFeedback(id: string) { return entries.has(id); }
export function dismissNativeSinkFeedback(id: string) {
  const entry = entries.get(id); if (!entry) return;
  entries.delete(id); clearTimeout(entry.timer); entry.sink.hide(entry.key, id); toast.dismiss(id);
}
export function clearNativeSinkFeedback() { for (const id of [...entries.keys()]) dismissNativeSinkFeedback(id); }
export function reconcileNativeSinkFeedback(toasts: readonly ToastT[]) {
  const current = new Map(toasts.filter(value => value.toasterId === NATIVE_FEEDBACK_TOASTER_ID).map(value => [String(value.id), value]));
  for (const [id, entry] of entries) {
    const value = current.get(id);
    if (entry.sink.capture(entry.scope) !== entry.key || entry.observed && !value) { dismissNativeSinkFeedback(id); continue; }
    if (!value) continue;
    entry.observed = true;
    if (typeof value.title !== "string" || value.description != null && typeof value.description !== "string") { dismissNativeSinkFeedback(id); continue; }
    if (!entry.sink.ready(entry.key)) continue;
    const message = [value.title, value.description].filter(Boolean).join(" ");
    const tone = !value.type || value.type === "default" || value.type === "action" ? "normal" : value.type;
    if (!message.trim() || message.length > 2048 || !["normal", "loading", "success", "error", "warning", "info"].includes(tone)) { dismissNativeSinkFeedback(id); continue; }
    const duration = tone === "loading" || value.duration === Infinity ? 0 : Math.max(1000, Math.min(30000, value.duration ?? 3600));
    const fingerprint = JSON.stringify([message, tone, duration, value.dismissible]);
    if (fingerprint === entry.fingerprint) continue;
    entry.fingerprint = fingerprint; clearTimeout(entry.timer);
    entry.sink.show(entry.key, { id, message, tone: tone as NativePresentationFeedback["tone"], dismissible: value.dismissible !== false });
    if (duration) entry.timer = setTimeout(() => dismissNativeSinkFeedback(id), duration);
  }
}
