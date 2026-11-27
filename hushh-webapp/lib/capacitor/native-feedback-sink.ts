import { toast, type ToastT } from "sonner";

export const NATIVE_FEEDBACK_TOASTER_ID = "native-owned-feedback";
export type NativeFeedbackActionToken = "open-conversation" | "open-information-request" | "undo-feed-removal";
export type NativeFeedbackSinkEndReason = "user" | "expired" | "programmatic";
export type NativeFeedbackSinkAction = { token: NativeFeedbackActionToken; label: string; onClick: () => void };
export type NativeFeedbackSinkNotice = {
  id: string; action?: NativeFeedbackSinkAction; onEnd?: (reason: NativeFeedbackSinkEndReason) => void;
};
export type NativePresentationFeedback = {
  id: string; message: string; tone: "normal" | "loading" | "success" | "error" | "warning" | "info"; dismissible: boolean;
  actionToken: NativeFeedbackActionToken | null; actionLabel: string | null;
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
  retargetToWeb?: (id: string) => boolean;
};
type Entry = {
  sink: Sink; scope: NativeFeedbackScope; key: string; fingerprint: string; observed: boolean;
  loadingSeen: boolean; settled: boolean; retired: boolean; suspended?: boolean; presentation?: NativePresentationFeedback;
  notice?: NativeFeedbackSinkNotice;
  actionInvoked: boolean; dismissInvoked: boolean; autoCloseInvoked: boolean;
  timer?: ReturnType<typeof setTimeout>; timerDeadline?: number; remainingDuration?: number;
};
const sinks = new Set<Sink>(), entries = new Map<string, Entry>();
function nativeFeedbackTone(value: string): value is NativePresentationFeedback["tone"] {
  return value === "normal" || value === "loading" || value === "success" || value === "error" ||
    value === "warning" || value === "info";
}

function noteToastState(entry: Entry, value: ToastT | undefined) {
  if (!value) return;
  if (value.type === "loading") entry.loadingSeen = true;
  else entry.settled = true;
}

function pausePresentationTimer(entry: Entry) {
  if (entry.timer === undefined) return;
  clearTimeout(entry.timer);
  entry.timer = undefined;
  entry.remainingDuration = Math.max(0, (entry.timerDeadline ?? Date.now()) - Date.now());
  entry.timerDeadline = undefined;
}

function schedulePresentationTimer(id: string, entry: Entry) {
  const remaining = entry.remainingDuration;
  if (remaining === undefined || entry.retired) return;
  entry.remainingDuration = undefined;
  entry.timerDeadline = Date.now() + remaining;
  entry.timer = setTimeout(() => {
    entry.timer = undefined;
    entry.timerDeadline = undefined;
    dismissNativeSinkFeedback(id, "expired");
  }, remaining);
}

function resetPresentationTimer(entry: Entry, duration: number) {
  clearTimeout(entry.timer);
  entry.timer = undefined;
  entry.timerDeadline = undefined;
  entry.remainingDuration = duration > 0 ? duration : undefined;
}

function retireEntry(id: string, entry: Entry, endReason: NativeFeedbackSinkEndReason = "programmatic") {
  if (entry.retired) return;
  noteToastState(entry, toast.getToasts().find(value => String(value.id) === id));
  entry.retired = true;
  clearTimeout(entry.timer);
  entry.timer = undefined;
  entry.timerDeadline = undefined;
  entry.remainingDuration = undefined;
  entry.dismissInvoked = true;
  entry.autoCloseInvoked = true;
  try {
    entry.notice?.onEnd?.(endReason);
  } finally {
    entry.sink.hide(entry.key, id);
    toast.dismiss(id);
  }
  // Keep a tombstone while a promise is loading so its late settlement cannot
  // recreate this retired native notification. The sink release and consumer
  // cleanup below bound that lifetime if the promise never settles.
  if (entry.settled || !entry.loadingSeen) entries.delete(id);
}

/** Private text-only notifications for a complete retained presentation.
 * Sonner retains promise/outcome ownership. The owning scene renders the
 * banner inside its acknowledged native subtree, above covered chrome. */
export function retainNativeFeedbackSink(sink: Sink) {
  sinks.add(sink);
  return (fallbackToWeb = false) => {
    sinks.delete(sink);
    for (const [id, entry] of entries) if (entry.sink === sink) {
      if (fallbackToWeb && sink.retargetToWeb?.(id)) releaseNativeSinkFeedback(id);
      else {
        dismissNativeSinkFeedback(id);
        entries.delete(id);
      }
    }
  };
}
export function nativeSinkFeedbackOptions(notice?: NativeFeedbackSinkNotice): { id: string; toasterId: string } | undefined {
  for (const sink of [...sinks].reverse()) {
    const key = sink.capture(captureScope); if (!key) continue;
    const id = notice?.id ?? `native-feedback-${crypto.randomUUID()}`;
    const existing = entries.get(id);
    if (existing && existing.sink === sink && existing.key === key && !existing.retired) {
      if (notice) existing.notice = notice;
      return { id, toasterId: NATIVE_FEEDBACK_TOASTER_ID };
    }
    if (existing?.loadingSeen && !existing.settled) return undefined;
    if (existing) dismissNativeSinkFeedback(id);
    for (const [olderId, entry] of entries) {
      if (olderId !== id && entry.sink === sink && entry.key === key) dismissNativeSinkFeedback(olderId);
    }
    entries.set(id, { sink, scope: captureScope, key, fingerprint: "", observed: false,
      loadingSeen: false, settled: false, retired: false, notice, actionInvoked: false, dismissInvoked: false, autoCloseInvoked: false });
    return { id, toasterId: NATIVE_FEEDBACK_TOASTER_ID };
  }
  return undefined;
}
export function isNativeSinkFeedback(id: string) { return entries.has(id); }
export function dismissNativeSinkFeedback(id: string, endReason: NativeFeedbackSinkEndReason = "programmatic") {
  const entry = entries.get(id); if (!entry) return;
  retireEntry(id, entry, endReason);
}
/** Release the native banner when Sonner retargets the same toast to Web.
 * The shared Sonner record remains live so its rich renderer and callbacks survive. */
export function releaseNativeSinkFeedback(id: string) {
  const entry = entries.get(id); if (!entry || entry.retired) return;
  entry.retired = true;
  clearTimeout(entry.timer);
  entry.timer = undefined;
  entry.timerDeadline = undefined;
  entry.remainingDuration = undefined;
  entry.dismissInvoked = true;
  entry.autoCloseInvoked = true;
  entry.sink.hide(entry.key, id);
  entries.delete(id);
}
export function activateNativeSinkFeedback(id: string, token: NativeFeedbackActionToken): boolean {
  const entry = entries.get(id), action = entry?.notice?.action;
  if (!entry || entry.retired || entry.actionInvoked || action?.token !== token) return false;
  entry.actionInvoked = true;
  retireEntry(id, entry);
  action.onClick();
  return true;
}
export function clearNativeSinkFeedback() {
  for (const id of [...entries.keys()]) {
    dismissNativeSinkFeedback(id);
    entries.delete(id);
  }
}
export function reconcileNativeSinkFeedback(toasts: readonly ToastT[]) {
  const current = new Map(toasts.filter(value => value.toasterId === NATIVE_FEEDBACK_TOASTER_ID).map(value => [String(value.id), value]));
  // useSonner publishes through a timer, so include the canonical store to
  // avoid briefly restoring a native banner from a stale hook snapshot.
  for (const [id, entry] of entries) {
    const value = current.get(id);
    noteToastState(entry, value);
    if (entry.retired) {
      if (value) toast.dismiss(id);
      if (entry.settled || !entry.loadingSeen && !value) entries.delete(id);
      continue;
    }
    if (entry.sink.capture(entry.scope) !== entry.key) { dismissNativeSinkFeedback(id); continue; }
    if (entry.observed && !value) {
      const retargeted = toasts.some(candidate => String(candidate.id) === id && candidate.toasterId !== NATIVE_FEEDBACK_TOASTER_ID);
      if (retargeted) releaseNativeSinkFeedback(id);
      else dismissNativeSinkFeedback(id);
      continue;
    }
    if (!value) continue;
    entry.observed = true;
    const wasSuspended = entry.suspended === true;
    const sinkReady = entry.sink.ready(entry.key);
    const presentationSuspended = !sinkReady;
    if (presentationSuspended) {
      if (!entry.suspended) {
        entry.sink.hide(entry.key, id);
        pausePresentationTimer(entry);
      }
      entry.suspended = true;
    }
    if (typeof value.title !== "string" || value.description != null && typeof value.description !== "string") { dismissNativeSinkFeedback(id); continue; }
    if (!sinkReady) continue;
    if (!presentationSuspended && entry.suspended) entry.suspended = false;
    const message = [value.title, value.description].filter(Boolean).join(" ");
    const tone = !value.type || value.type === "default" || value.type === "action" ? "normal" : value.type;
    if (!message.trim() || message.length > 2048 || !nativeFeedbackTone(tone)) { dismissNativeSinkFeedback(id); continue; }
    const duration = tone === "loading" || value.duration === Infinity ? 0 : Math.max(1000, Math.min(30000, value.duration ?? 3600));
    const actionToken = entry.notice?.action?.token ?? null;
    const actionLabel = entry.notice?.action?.label ?? null;
    const fingerprint = JSON.stringify([message, tone, duration, value.dismissible, actionToken, actionLabel]);
    if (fingerprint === entry.fingerprint) {
      if (!presentationSuspended && wasSuspended && entry.presentation) {
        entry.sink.show(entry.key, entry.presentation);
        schedulePresentationTimer(id, entry);
      }
      continue;
    }
    entry.fingerprint = fingerprint;
    entry.presentation = { id, message, tone, dismissible: value.dismissible !== false, actionToken, actionLabel };
    resetPresentationTimer(entry, duration);
    if (!presentationSuspended) {
      entry.sink.show(entry.key, entry.presentation);
      schedulePresentationTimer(id, entry);
    }
  }
}
