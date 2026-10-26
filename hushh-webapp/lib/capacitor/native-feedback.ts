import type { PluginListenerHandle } from "@capacitor/core";
import { toast, type ToastT, type ExternalToast } from "sonner";
import type { NativeDrawerIdentity, NativeDrawerProjection } from "./native-drawers";
import { nativePrivacyCanInteract, nativePrivacyObservation } from "./session-privacy";

/** Private, memory-only status presentation. Sonner still owns the promise and
 * feature callbacks; UIKit owns the banner's placement and expiry. No operation
 * or arbitrary JSX crosses this boundary. */
export const NATIVE_FEEDBACK_TOASTER = "native-owned-feedback";
export type NativeFeedbackProjection = NativeDrawerIdentity & {
  privacyGeneration: number; feedbackId: string; feedbackRevision: number; feedbackSequence: number;
  destinationId: string | null; supportDestinationId: string | null; formScene: string | null; formRevision: number | null;
  message: string; tone: "normal" | "loading" | "success" | "error" | "warning" | "info";
  duration: number; dismissible: boolean;
};
export type NativeFeedbackEnd = Pick<NativeFeedbackProjection,
  keyof NativeDrawerIdentity | "privacyGeneration" | "feedbackId" | "feedbackRevision" | "feedbackSequence" | "destinationId" | "supportDestinationId" | "formScene" | "formRevision">;
export interface NativeFeedbackPort {
  applyFeedback?(state: NativeFeedbackProjection): Promise<{ applied: boolean }>;
  retireFeedback?(state: NativeFeedbackEnd): Promise<{ retired: boolean }>;
  addListener(event: "feedbackEnded", listener: (event: NativeFeedbackEnd) => void): Promise<PluginListenerHandle>;
}
type Owner = { state: () => NativeDrawerProjection | null; current: () => boolean; ready?: () => boolean; plugin: NativeFeedbackPort };
type Form = { identity: NativeDrawerIdentity; scene: string; destinationId?: string; current: () => boolean; ready: () => boolean };
type Context = Pick<NativeDrawerProjection, keyof NativeDrawerIdentity | "privacyGeneration" | "profileDestinationId" | "profileSupportDestinationId">;
type Entry = { owner: Owner; context: Context; form?: Form; sequence: number; revision: number; observed: boolean; fingerprint: string; retired: boolean };
const owners = new Set<Owner>();
const forms = new Set<Form>();
const entries = new Map<string, Entry>();
let consumers = 0;
let sequence = 0;
let latestToasts: readonly ToastT[] = [];

type Message = Parameters<typeof toast>[0];
type FeedbackOptions = { id?: string | number; toasterId?: string; description?: unknown;
  action?: unknown; cancel?: unknown; onDismiss?: unknown; onAutoClose?: unknown };
function feedbackOptions<T extends FeedbackOptions>(message: unknown, data?: T): T | { id: string; toasterId: string } | undefined {
  // Rich/actionable feedback keeps its authored presentation. Never discard a
  // callback or change the renderer of an explicitly addressed existing toast.
  if (data && ("id" in data || "toasterId" in data || data.action || data.cancel || data.onDismiss || data.onAutoClose)) return data;
  const native = nativeFeedbackOptions(message, data?.description);
  if (!native) return data;
  // Keep Sonner's settlement-time getters intact (notably the existing
  // isCurrent label fence). Spreading options would snapshot that authority.
  const copy = data ? Object.create(Object.getPrototypeOf(data), Object.getOwnPropertyDescriptors(data)) : {};
  return Object.assign(copy, native);
}
function textFeedback(method: (message: Message, data?: ExternalToast) => string | number, message: Message, data?: ExternalToast) {
  return method(message, feedbackOptions(message, data));
}
/** Local facade, not a patch of Sonner. Existing web formatting, callbacks and
 * promise semantics remain in their owners; only admitted text chooses native. */
export const nativeFeedbackToast: typeof toast = Object.assign(
  (message: Message, data?: ExternalToast) => textFeedback(toast, message, data), {
    ...toast,
    success: (message: Message, data?: ExternalToast) => textFeedback(toast.success, message, data),
    error: (message: Message, data?: ExternalToast) => textFeedback(toast.error, message, data),
    warning: (message: Message, data?: ExternalToast) => textFeedback(toast.warning, message, data),
    info: (message: Message, data?: ExternalToast) => textFeedback(toast.info, message, data),
    message: (message: Message, data?: ExternalToast) => textFeedback(toast.message, message, data),
    loading: (message: Message, data?: ExternalToast) => textFeedback(toast.loading, message, data),
    promise: <T>(promise: Promise<T> | (() => Promise<T>), data?: Parameters<typeof toast.promise<T>>[1]) =>
      toast.promise(promise, typeof data?.success === "string" && typeof data?.error === "string"
        ? feedbackOptions(data.loading, data) : data),
  },
);

export function retainNativeFeedbackForm(form: Form): () => void {
  forms.add(form);
  return () => {
    forms.delete(form);
    for (const [id, entry] of entries) if (entry.form === form) retire(id, entry);
  };
}
export function refreshNativeFeedback() { reconcileNativeFeedback(latestToasts); }

export function retainNativeFeedbackOwner(owner: Owner): () => void {
  owners.add(owner);
  return () => {
    owners.delete(owner);
    for (const [id, entry] of entries) if (entry.owner === owner) retire(id, entry);
  };
}
function live(owner: Owner, state: Context): boolean {
  const privacy = nativePrivacyObservation().state;
  const current = owner.state();
  return owner.current() && !!current && current.open && current.profileDestinationId === state.profileDestinationId &&
    current.profileSupportDestinationId === state.profileSupportDestinationId &&
    nativePrivacyCanInteract(privacy) && privacy?.generation === state.privacyGeneration;
}
/** Select one renderer before publishing this toast. Older wrappers and rich
 * messages retain Sonner; a native receipt never changes an existing renderer. */
export function nativeFeedbackOptions(message: unknown, description?: unknown): { id: string; toasterId: string } | undefined {
  if (!consumers || typeof message !== "string" || description != null && typeof description !== "string") return;
  if (!message.trim() || message.length + String(description ?? "").length > 2048) return;
  for (const owner of [...owners].reverse()) {
    const state = owner.state();
    if (!state || !state.open || !live(owner, state)) continue;
    const form = [...forms].reverse().find(candidate => candidate.current() &&
      candidate.identity.documentId === state.documentId && candidate.identity.ownerEpoch === state.ownerEpoch &&
      candidate.identity.ownerGeneration === state.ownerGeneration && candidate.identity.family === state.family &&
      candidate.destinationId === (state.profileDestinationId ?? state.profileSupportDestinationId));
    if (state.profilePreparation?.formScene && form?.scene !== state.profilePreparation.formScene) continue;
    const id = `native-feedback-${crypto.randomUUID()}`;
    const { documentId, ownerEpoch, ownerGeneration, revision, family, privacyGeneration, profileDestinationId, profileSupportDestinationId } = state;
    entries.set(id, { owner, context: { documentId, ownerEpoch, ownerGeneration, revision, family, privacyGeneration,
      profileDestinationId, profileSupportDestinationId }, form, sequence: ++sequence, revision: 0, observed: false, fingerprint: "", retired: false });
    return { id, toasterId: NATIVE_FEEDBACK_TOASTER };
  }
  return undefined;
}
function identity(id: string, entry: Entry): NativeFeedbackEnd {
  const s = entry.context;
  return { documentId: s.documentId, ownerEpoch: s.ownerEpoch, ownerGeneration: s.ownerGeneration,
    revision: s.revision, family: s.family, privacyGeneration: s.privacyGeneration,
    destinationId: s.profileDestinationId ?? null, supportDestinationId: s.profileSupportDestinationId ?? null,
    formScene: entry.form?.scene ?? null,
    formRevision: entry.form?.identity.revision ?? null,
    feedbackId: id, feedbackRevision: entry.revision, feedbackSequence: entry.sequence };
}
function retire(id: string, entry: Entry) {
  if (entry.retired) return;
  entry.retired = true;
  entries.delete(id);
  // Targeted cleanup only. An uncertain apply is never replayed as a web toast.
  void entry.owner.plugin.retireFeedback?.(identity(id, entry)).catch(() => undefined);
  toast.dismiss(id);
}
export function receiveNativeFeedbackEnd(event: NativeFeedbackEnd) {
  const entry = entries.get(event.feedbackId);
  if (!entry || entry.retired) return;
  const expected = identity(event.feedbackId, entry);
  if (!(Object.keys(expected) as (keyof NativeFeedbackEnd)[]).every(key => expected[key] === event[key])) return;
  retire(event.feedbackId, entry);
}
export function retainNativeFeedbackConsumer(): () => void {
  consumers++;
  return () => {
    consumers--;
    if (!consumers) {
      latestToasts = [];
      for (const [id, entry] of entries) retire(id, entry);
    }
  };
}
export function reconcileNativeFeedback(toasts: readonly ToastT[]) {
  latestToasts = toasts.filter(t => t.toasterId === NATIVE_FEEDBACK_TOASTER);
  const active = new Set(toasts.filter(t => t.toasterId === NATIVE_FEEDBACK_TOASTER).map(t => String(t.id)));
  for (const [id, entry] of entries) if (entry.observed && !active.has(id)) retire(id, entry);
  for (const t of toasts) {
    if (t.toasterId !== NATIVE_FEEDBACK_TOASTER) continue;
    const id = String(t.id), entry = entries.get(id);
    if (!entry) { toast.dismiss(t.id); continue; }
    entry.observed = true;
    if (!live(entry.owner, entry.context) || entry.form && !entry.form.current() || typeof t.title !== "string" || t.description != null && typeof t.description !== "string") {
      retire(id, entry); continue;
    }
    // Compatible presentation updates may be in flight. Keep only the latest
    // Sonner state until actual admission; never discard a committed outcome.
    if (entry.owner.ready?.() === false || entry.form?.ready() === false) continue;
    const message = [t.title, t.description].filter(Boolean).join(" ");
    const tone = t.type === "default" || t.type === "action" || !t.type ? "normal" : t.type;
    const duration = tone === "loading" || t.duration === Infinity ? 0 : Math.max(1000, Math.min(30000, t.duration ?? 3600));
    const fingerprint = JSON.stringify([message, tone, duration, t.dismissible]);
    if (fingerprint === entry.fingerprint) continue;
    entry.fingerprint = fingerprint;
    entry.revision++;
    const state: NativeFeedbackProjection = { ...identity(id, entry), message, tone, duration, dismissible: t.dismissible !== false };
    const revision = entry.revision;
    void entry.owner.plugin.applyFeedback?.(state).then(receipt => {
      if (!entry.retired && entry.revision === revision && receipt.applied !== true) retire(id, entry);
    }).catch(() => { if (!entry.retired && entry.revision === revision) retire(id, entry); });
  }
}
