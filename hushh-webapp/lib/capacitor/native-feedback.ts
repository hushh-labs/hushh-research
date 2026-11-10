import { NATIVE_FEEDBACK_TOASTER_ID, nativeSinkFeedbackOptions, reconcileNativeSinkFeedback, isNativeSinkFeedback,
  clearNativeSinkFeedback, dismissNativeSinkFeedback, releaseNativeSinkFeedback, type NativeFeedbackActionToken,
  type NativeFeedbackSinkEndReason, type NativeFeedbackSinkNotice } from "./native-feedback-sink";
import type { PluginListenerHandle } from "@capacitor/core";
import { toast, type ToastT, type ToastToDismiss, type ExternalToast } from "sonner";
import type { NativeDrawerIdentity, NativeDrawerProjection } from "./native-drawers";
import { nativeShellFeedbackAvailable } from "./native-workspace-presence";
import { nativePrivacyCanInteract, nativePrivacyObservation } from "./session-privacy";

/** Private, memory-only status presentation. Sonner still owns the promise and
 * feature callbacks; UIKit owns the banner's placement and expiry. No operation
 * or arbitrary JSX crosses this boundary. */
export const NATIVE_FEEDBACK_TOASTER = NATIVE_FEEDBACK_TOASTER_ID;
export type { NativeFeedbackActionToken } from "./native-feedback-sink";
export type NativeFeedbackOwnerState = Omit<NativeDrawerProjection, "family"> & { family: NativeDrawerIdentity["family"] | "shell" };
export type NativeFeedbackProjection = Omit<NativeDrawerIdentity, "family"> & { family: NativeFeedbackOwnerState["family"];
  privacyGeneration: number; feedbackId: string; feedbackRevision: number; feedbackSequence: number;
  destinationId: string | null; supportDestinationId: string | null; formScene: string | null; formRevision: number | null;
  message: string; tone: "normal" | "loading" | "success" | "error" | "warning" | "info";
  duration: number; dismissible: boolean; actionToken: NativeFeedbackActionToken | null; actionLabel: string | null;
};
export type NativeFeedbackIdentity = Pick<NativeFeedbackProjection,
  keyof NativeDrawerIdentity | "privacyGeneration" | "feedbackId" | "feedbackRevision" | "feedbackSequence" | "destinationId" | "supportDestinationId" | "formScene" | "formRevision">;
export type NativeFeedbackEnd = NativeFeedbackIdentity & { endReason: "user" | "expired" | "programmatic" };
export type NativeFeedbackAction = NativeFeedbackIdentity & { actionToken: NativeFeedbackActionToken };
export interface NativeFeedbackPort {
  applyFeedback?(state: NativeFeedbackProjection): Promise<{ applied: boolean; pending?: boolean }>;
  retireFeedback?(state: NativeFeedbackIdentity): Promise<{ retired: boolean }>;
  addListener(event: "feedbackEnded", listener: (event: NativeFeedbackEnd) => void): Promise<PluginListenerHandle>;
  addListener(event: "feedbackAction", listener: (event: NativeFeedbackAction) => void): Promise<PluginListenerHandle>;
}
type Owner = { state: () => NativeFeedbackOwnerState | null; current: () => boolean; parentRetired: () => boolean;
  ready?: () => boolean; plugin: NativeFeedbackPort };
type Form = { identity: NativeDrawerIdentity; scene: string; destinationId?: string; current: () => boolean; ready: () => boolean };
type Context = Pick<NativeFeedbackOwnerState, keyof NativeDrawerIdentity | "privacyGeneration" | "profileDestinationId" | "profileSupportDestinationId">;
export type NativeFeedbackNoticeMode = "default" | "message" | "error" | "success";
export type NativeFeedbackTextNoticeOptions = {
  id: string;
  description?: string;
  duration?: number;
  dismissible?: boolean;
  closeButton?: boolean;
  icon?: ExternalToast["icon"];
  className?: ExternalToast["className"];
  classNames?: ExternalToast["classNames"];
  testId?: string;
  onDismiss?: (toast?: ToastT) => void;
  onAutoClose?: (toast?: ToastT) => void;
  action?: { token: NativeFeedbackActionToken; label: string; onClick: () => void };
};
type OptedNotice = { key: string; message: string; mode: NativeFeedbackNoticeMode; options: NativeFeedbackTextNoticeOptions;
  actionInvoked: boolean; dismissInvoked: boolean; autoCloseInvoked: boolean; terminalCallback?: NativeFeedbackSinkEndReason;
  toastId: string | number; sonnerType?: ToastT["type"]; webOptions?: ExternalToast; renderer?: "native" | "web" };
type Entry = { owner: Owner; context: Context; form?: Form; sequence: number; revision: number; observed: boolean;
  fingerprint: string; retired: boolean; childRetired?: boolean; toastId: string | number; notice?: OptedNotice; transferring?: true };
const owners = new Set<Owner>();
const forms = new Set<Form>();
const entries = new Map<string, Entry>();
const optedNotices = new Map<string, OptedNotice>();
const noticesNeedingFreshToastId = new Set<string>();
const nativeSinkWebFallbackIds = new Set<string>();
let consumers = 0;
let sequence = 0;
let latestToasts: readonly ToastT[] = [];

type Message = Parameters<typeof toast>[0];
type FeedbackOptions = { id?: string | number; toasterId?: string; description?: unknown;
  icon?: unknown; action?: unknown; cancel?: unknown; onDismiss?: unknown; onAutoClose?: unknown };
type TextPromiseData<T> = Omit<NonNullable<Parameters<typeof toast.promise<T>>[1]>, "loading" | "success" | "error"> & {
  loading: string;
  success?: string | ((value: T) => string | null);
  error?: string | ((error: unknown) => string | null);
};
function feedbackOptions<T extends FeedbackOptions>(message: unknown, data?: T): T | { id: string; toasterId: string } | undefined {
  // Rich/actionable feedback keeps its authored presentation. Never discard a
  // callback or change the renderer of an explicitly addressed existing toast.
  if (data && ("id" in data || "toasterId" in data || data.icon != null || data.action || data.cancel || data.onDismiss || data.onAutoClose)) return data;
  const native = nativeFeedbackOptions(message, data?.description);
  if (!native) return data;
  // Keep Sonner's settlement-time getters intact (notably the existing
  // isCurrent label fence). Spreading options would snapshot that authority.
  const copy = data ? Object.create(Object.getPrototypeOf(data), Object.getOwnPropertyDescriptors(data)) : {};
  Object.assign(copy, native);
  const nativeId = String(native.id);
  Object.defineProperty(copy, "toasterId", { configurable: true, enumerable: true,
    get: () => nativeSinkWebFallbackIds.has(nativeId) ? undefined : native.toasterId });
  return copy;
}
function textFeedback(method: (message: Message, data?: ExternalToast) => string | number, message: Message, data?: ExternalToast) {
  const options = feedbackOptions(message, data);
  return options === undefined ? method(message) : method(message, options);
}
function noticeMethod(mode: NativeFeedbackNoticeMode, sonnerType?: ToastT["type"]) {
  if (mode === "success" || sonnerType === "success") return toast.success;
  if (sonnerType === "warning") return toast.warning;
  if (sonnerType === "info") return toast.info;
  if (sonnerType === "loading") return toast.loading;
  if (sonnerType === "error") return toast.error;
  if (sonnerType === "normal" || sonnerType === "default") return toast.message;
  return mode === "message" ? toast.message : mode === "error" ? toast.error : toast;
}
/** Keep a same-ID text notice visible in Sonner if native admission is refused.
 * Rich JSX never enters the native sink, so its authored renderer stays intact. */
export function retargetNativeSinkToastToWeb(id: string): boolean {
  const current = toast.getToasts().find(value => String(value.id) === id);
  if (!current || "dismiss" in current || typeof current.title !== "string" ||
      current.description != null && typeof current.description !== "string" || current.jsx != null) return false;
  const notice = [...optedNotices.values()].find(value => String(value.toastId) === id);
  const successor = nativeShellFeedbackAvailable() ? feedbackOwner(current.title,
    typeof current.description === "string" ? current.description : undefined) : undefined;
  if (successor) {
    if (notice) notice.renderer = "native";
    entries.set(notice?.key ?? id, { owner: successor.owner, context: feedbackContext(successor.state),
      form: successor.form, sequence: ++sequence, revision: 0, observed: false, fingerprint: "", retired: false,
      toastId: current.id, notice });
    return true;
  }
  if (notice) notice.renderer = "web";
  nativeSinkWebFallbackIds.add(id);
  const { id: toastId, title, type, toasterId: _toasterId, jsx: _jsx, promise: _promise, delete: _delete, ...options } = current;
  noticeMethod(notice?.mode ?? "default", notice?.sonnerType ?? type)(title, { ...options, id: toastId, toasterId: undefined });
  return true;
}
function noticeEndCallback(notice: OptedNotice, reason: NativeFeedbackSinkEndReason, value?: ToastT): (() => void) | undefined {
  if (reason === "user") {
    if ((notice.terminalCallback && notice.terminalCallback !== "user") || notice.dismissInvoked) return;
    notice.terminalCallback = "user";
    notice.dismissInvoked = true; notice.autoCloseInvoked = true;
    return () => notice.options.onDismiss?.(value);
  }
  if (reason === "expired") {
    if ((notice.terminalCallback && notice.terminalCallback !== "expired") || notice.autoCloseInvoked) return;
    notice.terminalCallback = "expired";
    notice.autoCloseInvoked = true; notice.dismissInvoked = true;
    return () => notice.options.onAutoClose?.(value);
  }
  suppressNoticeCallbacks(notice);
  return undefined;
}
function invokeNoticeDismiss(notice: OptedNotice, value?: ToastT) {
  noticeEndCallback(notice, "user", value)?.();
}
function invokeNoticeAutoClose(notice: OptedNotice, value?: ToastT) {
  noticeEndCallback(notice, "expired", value)?.();
}
function suppressNoticeCallbacks(notice: OptedNotice) {
  notice.terminalCallback ??= "programmatic";
  notice.dismissInvoked = true; notice.autoCloseInvoked = true;
}
function nextNoticeToastId(): string { return `native-feedback-${crypto.randomUUID()}`; }
function transferredNotice(notice: OptedNotice): OptedNotice {
  return { ...notice, toastId: nextNoticeToastId(), actionInvoked: false, dismissInvoked: false,
    autoCloseInvoked: false, terminalCallback: undefined };
}
function dismissNoticeToast(notice: OptedNotice, rotateNext = true) {
  if (rotateNext) noticesNeedingFreshToastId.add(notice.key);
  suppressNoticeCallbacks(notice);
  toast.dismiss(notice.toastId);
}
function noticeActionCallback(notice: OptedNotice): (() => void) | undefined {
  if (notice.actionInvoked) return undefined;
  const action = notice.options.action;
  if (!action) return undefined;
  notice.actionInvoked = true;
  return () => action.onClick();
}
function invokeNoticeAction(notice: OptedNotice) {
  noticeActionCallback(notice)?.();
}
function callNotice(notice: OptedNotice, toasterId?: string, clearToaster = false) {
  const { action, onDismiss, onAutoClose, ...authored } = notice.options;
  const webFallback = nativeSinkWebFallbackIds.has(String(notice.toastId));
  const data: ExternalToast = {
    ...(notice.webOptions ?? {}),
    ...authored,
    id: notice.toastId,
    ...(onDismiss ? { onDismiss: (value: ToastT) => invokeNoticeDismiss(notice, value) } : {}),
    ...(onAutoClose ? { onAutoClose: (value: ToastT) => invokeNoticeAutoClose(notice, value) } : {}),
    ...(action ? { action: { label: action.label, onClick: () => invokeNoticeAction(notice) } } : {}),
    ...(toasterId && !webFallback ? { toasterId } : clearToaster || webFallback ? { toasterId: undefined } : {}),
  };
  return noticeMethod(notice.mode, notice.sonnerType)(notice.message, data);
}
function nativeSinkNoticeOptions(notice: OptedNotice) {
  const sinkNotice: NativeFeedbackSinkNotice = {
    id: String(notice.toastId),
    ...(notice.options.action ? { action: { ...notice.options.action, onClick: () => invokeNoticeAction(notice) } } : {}),
    onEnd: (reason: NativeFeedbackSinkEndReason) => {
      noticesNeedingFreshToastId.add(notice.key);
      if (reason === "user") invokeNoticeDismiss(notice);
      else if (reason === "expired") invokeNoticeAutoClose(notice);
      else suppressNoticeCallbacks(notice);
    },
  };
  return nativeSinkFeedbackOptions(sinkNotice);
}
function validNotice(notice: OptedNotice): boolean {
  const { id, description, duration, dismissible, closeButton, testId, onDismiss, onAutoClose, action } = notice.options;
  const optionKeys = ["id", "description", "duration", "dismissible", "closeButton", "icon", "className", "classNames", "testId", "onDismiss", "onAutoClose", "action"];
  const actionKeys = ["token", "label", "onClick"];
  const closed = (value: object, allowed: readonly string[]) => Object.keys(value).every(key => allowed.includes(key));
  return /^[A-Za-z0-9_-]{1,128}$/.test(id) && typeof notice.message === "string" && !!notice.message.trim() &&
    closed(notice.options, optionKeys) &&
    (description === undefined || typeof description === "string") &&
    notice.message.length + (description?.length ?? 0) <= 2048 &&
    (duration === undefined || duration === Infinity || Number.isFinite(duration) && duration >= 0) &&
    (dismissible === undefined || typeof dismissible === "boolean") &&
    (closeButton === undefined || typeof closeButton === "boolean") &&
    (testId === undefined || typeof testId === "string") &&
    (onDismiss === undefined || typeof onDismiss === "function") &&
    (onAutoClose === undefined || typeof onAutoClose === "function") &&
    (!action || (closed(action, actionKeys) && (action.token === "open-conversation" || action.token === "open-information-request" || action.token === "undo-feed-removal") &&
      typeof action.label === "string" && !!action.label.trim() && action.label.length <= 48 && typeof action.onClick === "function"));
}
function callRawNotice(message: string, options: NativeFeedbackTextNoticeOptions, mode: NativeFeedbackNoticeMode) {
  return noticeMethod(mode)(message, options);
}
function feedbackContext(state: NativeFeedbackOwnerState): Context {
  const { documentId, ownerEpoch, ownerGeneration, revision, family, privacyGeneration,
    profileDestinationId, profileSupportDestinationId } = state;
  return { documentId, ownerEpoch, ownerGeneration, revision, family, privacyGeneration,
    profileDestinationId, profileSupportDestinationId };
}
function entryContextMatches(entry: Entry, owner: Owner, state: NativeFeedbackOwnerState, form?: Form) {
  const next = feedbackContext(state), current = entry.context;
  return entry.owner === owner && entry.form === form && current.documentId === next.documentId &&
    current.ownerEpoch === next.ownerEpoch && current.ownerGeneration === next.ownerGeneration &&
    current.revision === next.revision && current.family === next.family && current.privacyGeneration === next.privacyGeneration &&
    current.profileDestinationId === next.profileDestinationId && current.profileSupportDestinationId === next.profileSupportDestinationId;
}
function feedbackOwner(message: string, description?: string): { owner: Owner; state: NativeFeedbackOwnerState; form?: Form } | undefined {
  if (!consumers || typeof message !== "string" || description != null && typeof description !== "string" ||
      !message.trim() || message.length + String(description ?? "").length > 2048) return;
  for (const owner of [...owners].reverse().sort((a, b) => Number(a.state()?.family === "shell") - Number(b.state()?.family === "shell"))) {
    const state = owner.state();
    if (!state || !state.open || !live(owner, state)) continue;
    const form = [...forms].reverse().find(candidate => candidate.current() &&
      candidate.identity.documentId === state.documentId && candidate.identity.ownerEpoch === state.ownerEpoch &&
      candidate.identity.ownerGeneration === state.ownerGeneration && candidate.identity.family === state.family &&
      candidate.destinationId === (state.profileDestinationId ?? state.profileSupportDestinationId));
    if (state.profilePreparation?.formScene && form?.scene !== state.profilePreparation.formScene) continue;
    if (typeof owner.plugin.applyFeedback !== "function" || typeof owner.plugin.retireFeedback !== "function") continue;
    return { owner, state, form };
  }
  return undefined;
}
function nativeNoticeOptions(notice: OptedNotice): { id: string; toasterId: string } | undefined {
  if (!validNotice(notice) || notice.renderer === "web") return;
  const sink = nativeSinkNoticeOptions(notice);
  if (sink) return sink;
  // Claim the same-ID toast as soon as the live owner is open. The headless
  // consumer holds native application until its readiness fence opens, so a
  // toast created during admission never flashes in the covered Web renderer.
  const selected = feedbackOwner(notice.message, notice.options.description);
  if (selected) {
    const existing = entries.get(notice.key);
    if (existing && entryContextMatches(existing, selected.owner, selected.state, selected.form) && !existing.retired) {
      existing.notice = notice;
      existing.toastId = notice.toastId;
      return { id: String(notice.toastId), toasterId: NATIVE_FEEDBACK_TOASTER };
    }
    if (existing) retire(notice.key, existing, false);
    entries.set(notice.key, { owner: selected.owner, context: feedbackContext(selected.state), form: selected.form,
      sequence: ++sequence, revision: 0, observed: false, fingerprint: "", retired: false,
      toastId: notice.toastId, notice });
    return { id: String(notice.toastId), toasterId: NATIVE_FEEDBACK_TOASTER };
  }
  const existing = entries.get(notice.key);
  if (existing && existing.notice && !existing.retired && !existing.transferring && live(existing.owner, existing.context)) {
    existing.notice = notice;
    return { id: String(notice.toastId), toasterId: NATIVE_FEEDBACK_TOASTER };
  }
  return;
}
function resumeNativeNoticeTransfer(id: string, entry: Entry, notice: OptedNotice) {
  if (entries.get(id) !== entry || !entry.childRetired) return;
  const current = toast.getToasts().find(value => String(value.id) === String(entry.toastId));
  if (!current) {
    entries.delete(id); optedNotices.delete(id); return;
  }
  const privacy = nativePrivacyObservation().state;
  if (!nativePrivacyCanInteract(privacy) || privacy?.generation !== entry.context.privacyGeneration) {
    entries.delete(id); optedNotices.delete(id); dismissNoticeToast(notice); return;
  }
  const successor = transferredNotice(notice);
  entry.notice = successor;
  entries.delete(id);
  const route = nativeNoticeOptions(successor);
  if (route) {
    optedNotices.set(id, successor);
    callNotice(successor, route.toasterId);
    dismissNoticeToast(notice, false);
    return;
  }
  entries.delete(id);
  optedNotices.delete(id);
  dismissNoticeToast(notice);
}
function transferNativeNotice(id: string, entry: Entry) {
  if (entry.childRetired) {
    if (entry.notice) resumeNativeNoticeTransfer(id, entry, optedNotices.get(id) ?? entry.notice);
    return;
  }
  if (entry.retired || entry.transferring || !entry.notice) return;
  entry.transferring = true;
  const retireNative = entry.owner.plugin.retireFeedback?.(identity(id, entry));
  if (!retireNative) {
    entries.delete(id); entry.retired = true; optedNotices.delete(id); dismissNoticeToast(entry.notice); return;
  }
  void retireNative.then(receipt => {
    if (entries.get(id) !== entry || entry.retired) return;
    const notice = optedNotices.get(id) ?? entry.notice;
    if (!notice) {
      entries.delete(id); entry.retired = true; entry.transferring = undefined;
      optedNotices.delete(id); toast.dismiss(entry.toastId); return;
    }
    const current = toast.getToasts().find(value => String(value.id) === String(entry.toastId));
    if (!current || receipt.retired !== true) {
      entries.delete(id); entry.retired = true; entry.transferring = undefined;
      optedNotices.delete(id);
      if (current) dismissNoticeToast(notice);
      return;
    }
    entry.retired = true; entry.childRetired = true; entry.transferring = undefined;
    resumeNativeNoticeTransfer(id, entry, notice);
  }).catch(() => {
    if (entries.get(id) !== entry || entry.retired) return;
    entries.delete(id); entry.retired = true; entry.childRetired = undefined; entry.transferring = undefined;
    optedNotices.delete(id);
    if (entry.notice) dismissNoticeToast(entry.notice);
    else toast.dismiss(entry.toastId);
  });
}
function optedTextNotice(message: string, options: NativeFeedbackTextNoticeOptions, mode: NativeFeedbackNoticeMode = "default", sonnerType?: ToastT["type"]) {
  const key = typeof options?.id === "string" ? options.id : "";
  const previous = key ? optedNotices.get(key) : undefined;
  const rotate = key && noticesNeedingFreshToastId.delete(key);
  const toastId = rotate || previous?.terminalCallback ? nextNoticeToastId() : previous?.toastId ?? options?.id ?? nextNoticeToastId();
  const notice: OptedNotice = { key, message, mode, options, toastId, sonnerType, renderer: previous?.renderer,
    actionInvoked: false, dismissInvoked: false, autoCloseInvoked: false };
  if (!options || !validNotice(notice)) return callRawNotice(message, options, mode);
  if (!key) {
    const route = nativeNoticeOptions(notice);
    notice.renderer = route ? "native" : "web";
    return callNotice(notice, route?.toasterId);
  }
  optedNotices.set(key, notice);
  while (optedNotices.size > 128) optedNotices.delete(optedNotices.keys().next().value as string);
  const route = notice.renderer === "web" ? undefined : nativeNoticeOptions(notice);
  if (route) { notice.renderer = "native"; optedNotices.set(key, notice); callNotice(notice, route.toasterId); return options.id; }
  const existing = entries.get(key);
  if (existing?.notice && !existing.retired && !existing.transferring) {
    if (live(existing.owner, existing.context)) {
      notice.renderer = "native";
      existing.notice = notice;
      callNotice(notice, NATIVE_FEEDBACK_TOASTER);
      return options.id;
    }
    transferNativeNotice(key, existing);
    return options.id;
  }
  if (notice.renderer === "native") {
    const current = toast.getToasts().find(value => String(value.id) === String(previous?.toastId ?? notice.toastId));
    if (current && "toasterId" in current && current.toasterId === NATIVE_FEEDBACK_TOASTER) {
      optedNotices.set(key, notice);
      callNotice(notice, NATIVE_FEEDBACK_TOASTER);
    } else {
      optedNotices.delete(key);
      if (current) toast.dismiss(current.id);
    }
    return options.id;
  }
  notice.renderer = "web";
  optedNotices.set(key, notice);
  callNotice(notice);
  return options.id;
}
function nativeTextOutcome<T>(value: unknown, data: TextPromiseData<T>): unknown {
  if (value === undefined) return undefined;
  if (value === null || typeof value === "string" && !value.trim()) return null;
  if (typeof value === "string") return value;
  // The opted-in API is text-only. If a runtime caller violates its type and
  // returns rich content, move the same Sonner handle back to its DOM renderer
  // with the authored toast callbacks and presentation options intact.
  const { id: _id, toasterId: _toasterId, loading: _loading, success: _success, error: _error,
    description: _description, finally: _finally, ...toastOptions } = data;
  return { ...toastOptions, message: value, toasterId: undefined };
}
function withNativeTextOutcomes<T>(data: TextPromiseData<T>) {
  const copy = Object.create(Object.getPrototypeOf(data), Object.getOwnPropertyDescriptors(data)) as TextPromiseData<T>;
  for (const key of ["success", "error"] as const) {
    const descriptor = Object.getOwnPropertyDescriptor(data, key);
    Object.defineProperty(copy, key, {
      configurable: true,
      enumerable: descriptor?.enumerable ?? true,
      get() {
        const outcome = descriptor?.get ? descriptor.get.call(data) : descriptor?.value;
        if (typeof outcome === "function") {
          return (...args: unknown[]) => nativeTextOutcome(outcome(...args), data);
        }
        return nativeTextOutcome(outcome, data);
      },
    });
  }
  return copy;
}
/** Local facade, not a patch of Sonner. Existing web formatting, callbacks and
 * promise semantics remain in their owners; only admitted text chooses native. */
export const nativeFeedbackToast: typeof toast & {
  promiseText<T>(promise: Promise<T> | (() => Promise<T>), data: TextPromiseData<T>): ReturnType<typeof toast.promise>;
  noticeText(message: string, options: NativeFeedbackTextNoticeOptions, mode?: NativeFeedbackNoticeMode): string | number;
} = Object.assign(
  (message: Message, data?: ExternalToast) => textFeedback(toast, message, data), {
    ...toast,
    dismiss: (id?: string | number) => {
      if (id === undefined) return toast.dismiss(id);
      const requestedId = String(id);
      const notice = optedNotices.get(requestedId) ?? [...optedNotices.values()].find(value => String(value.toastId) === requestedId);
      if (!notice) return toast.dismiss(id);
      const physicalId = String(notice.toastId);
      if (isNativeSinkFeedback(physicalId)) dismissNativeSinkFeedback(physicalId, "programmatic");
      else {
        const entry = entries.get(notice.key);
        if (entry?.notice === notice || entry?.toastId === notice.toastId) retire(notice.key, entry);
        else dismissNoticeToast(notice);
      }
      return id;
    },
    success: (message: Message, data?: ExternalToast) => textFeedback(toast.success, message, data),
    error: (message: Message, data?: ExternalToast) => textFeedback(toast.error, message, data),
    warning: (message: Message, data?: ExternalToast) => textFeedback(toast.warning, message, data),
    info: (message: Message, data?: ExternalToast) => textFeedback(toast.info, message, data),
    message: (message: Message, data?: ExternalToast) => textFeedback(toast.message, message, data),
    loading: (message: Message, data?: ExternalToast) => textFeedback(toast.loading, message, data),
    noticeText: optedTextNotice,
    promise: <T>(promise: Promise<T> | (() => Promise<T>), data?: Parameters<typeof toast.promise<T>>[1]) =>
      toast.promise(promise, typeof data?.success === "string" && typeof data?.error === "string"
        ? feedbackOptions(data.loading, data) : data),
    promiseText: <T>(promise: Promise<T> | (() => Promise<T>), data: TextPromiseData<T>) => {
      const routed = feedbackOptions(data.loading, data);
      const source = routed ?? data;
      const routedData = Object.create(Object.getPrototypeOf(source), Object.getOwnPropertyDescriptors(source)) as TextPromiseData<T>;
      return toast.promise(promise, withNativeTextOutcomes(routedData));
    },
  },
);

export function retainNativeFeedbackForm(form: Form): () => void {
  forms.add(form);
  refreshNativeFeedback();
  return () => {
    forms.delete(form);
    for (const [id, entry] of entries) if (entry.form === form) retireUnavailable(id, entry);
    refreshNativeFeedback();
  };
}
export function refreshNativeFeedback() { reconcileNativeFeedback(latestToasts); }

export function retainNativeFeedbackOwner(owner: Owner): () => void {
  owners.add(owner);
  refreshNativeFeedback();
  return () => {
    owners.delete(owner);
    for (const [id, entry] of entries) if (entry.owner === owner) {
      if (entry.notice && toast.getToasts().some(value => String(value.id) === String(entry.toastId))) {
        transferNativeNotice(id, entry);
      } else retire(id, entry);
    }
  };
}
function isNativeFeedbackToast(value: ToastT | ToastToDismiss): value is ToastT {
  return "toasterId" in value && value.toasterId === NATIVE_FEEDBACK_TOASTER;
}
function live(owner: Owner, state: Context): boolean {
  const privacy = nativePrivacyObservation().state;
  const current = owner.state();
  return owner.current() && !!current && current.open && current.documentId === state.documentId &&
    current.ownerEpoch === state.ownerEpoch && current.ownerGeneration === state.ownerGeneration &&
    current.revision === state.revision && current.family === state.family &&
    current.profileDestinationId === state.profileDestinationId &&
    current.profileSupportDestinationId === state.profileSupportDestinationId &&
    nativePrivacyCanInteract(privacy) && privacy?.generation === state.privacyGeneration;
}
/** Select one renderer before publishing this toast. Older wrappers and rich
 * messages retain Sonner; a native receipt never changes an existing renderer. */
export function nativeFeedbackOptions(message: unknown, description?: unknown): { id: string; toasterId: string } | undefined {
  if (!consumers || typeof message !== "string" || description != null && typeof description !== "string") return;
  if (!message.trim() || message.length + String(description ?? "").length > 2048) return;
  const sink = nativeSinkFeedbackOptions();
  if (sink) return sink;
  const selected = feedbackOwner(message, typeof description === "string" ? description : undefined);
  if (selected) {
    const id = `native-feedback-${crypto.randomUUID()}`;
    entries.set(id, { owner: selected.owner, context: feedbackContext(selected.state), form: selected.form,
      sequence: ++sequence, revision: 0, observed: false, fingerprint: "", retired: false, toastId: id });
    return { id, toasterId: NATIVE_FEEDBACK_TOASTER };
  }
  return undefined;
}
function identity(id: string, entry: Entry): NativeFeedbackIdentity {
  const s = entry.context;
  return { documentId: s.documentId, ownerEpoch: s.ownerEpoch, ownerGeneration: s.ownerGeneration,
    revision: s.revision, family: s.family, privacyGeneration: s.privacyGeneration,
    destinationId: s.profileDestinationId ?? null, supportDestinationId: s.profileSupportDestinationId ?? null,
    formScene: entry.form?.scene ?? null,
    formRevision: entry.form?.identity.revision ?? null,
    feedbackId: id, feedbackRevision: entry.revision, feedbackSequence: entry.sequence };
}
function retire(id: string, entry: Entry, dismissToast = true) {
  if (entry.retired) return;
  entry.retired = true;
  entries.delete(id);
  if (entry.notice) {
    noticesNeedingFreshToastId.add(entry.notice.key);
    suppressNoticeCallbacks(entry.notice);
    optedNotices.delete(id);
  }
  // Targeted cleanup only. An uncertain apply is never replayed as a web toast.
  void entry.owner.plugin.retireFeedback?.(identity(id, entry)).catch(() => undefined);
  if (dismissToast) toast.dismiss(entry.toastId);
}
function retireUnavailable(id: string, entry: Entry) {
  if (entry.notice && toast.getToasts().some(value => String(value.id) === String(entry.toastId))) transferNativeNotice(id, entry);
  else retire(id, entry);
}
export function receiveNativeFeedbackEnd(event: NativeFeedbackEnd) {
  const entry = entries.get(event.feedbackId);
  if (!entry || entry.retired) return;
  if (entry.transferring) return;
  const expected = identity(event.feedbackId, entry);
  if ((event.endReason !== "user" && event.endReason !== "expired" && event.endReason !== "programmatic") ||
      Object.keys(event).length !== Object.keys(expected).length + 1 ||
      !(Object.keys(expected) as (keyof NativeFeedbackIdentity)[]).every(key => expected[key] === event[key])) return;
  const notice = entry.notice;
  const callback = notice ? noticeEndCallback(notice, event.endReason) : undefined;
  retire(event.feedbackId, entry);
  callback?.();
}
export function receiveNativeFeedbackAction(event: NativeFeedbackAction) {
  const entry = entries.get(event.feedbackId);
  if (!entry || entry.retired || entry.transferring || !entry.notice || entry.notice.actionInvoked) return;
  const expected = identity(event.feedbackId, entry);
  if (Object.keys(event).length !== Object.keys(expected).length + 1 ||
      !(Object.keys(expected) as (keyof NativeFeedbackIdentity)[]).every(key => expected[key] === event[key]) ||
      entry.notice.options.action?.token !== event.actionToken || !live(entry.owner, entry.context) ||
      entry.owner.ready?.() === false || entry.form && (!entry.form.current() || !entry.form.ready())) return;
  const active = toast.getToasts().some(value => String(value.id) === String(entry.toastId) &&
    isNativeFeedbackToast(value) && !value.delete);
  if (!active) return;
  const callback = noticeActionCallback(entry.notice);
  if (!callback) return;
  retire(event.feedbackId, entry);
  callback();
}
export function retainNativeFeedbackConsumer(): () => void {
  consumers++;
  return () => {
    consumers--;
    if (!consumers) {
      latestToasts = []; clearNativeSinkFeedback();
      for (const [id, entry] of entries) {
        if (entry.notice && toast.getToasts().some(value => String(value.id) === String(entry.toastId))) transferNativeNotice(id, entry);
        else retire(id, entry);
      }
    }
  };
}
/** Adopt ordinary text records into the native presenter. The canonical Sonner
 * record remains intact, including promise settlement and terminal callbacks. */
function admitOrdinaryNotices(toasts: readonly ToastT[]) {
  if (!nativeShellFeedbackAvailable()) return toasts;
  let adopted = false;
  for (const value of toasts) {
    if (value.delete || value.toasterId || value.jsx || typeof value.title !== "string" ||
        value.description != null && typeof value.description !== "string" || value.action || value.cancel) continue;
    const key = String(value.id);
    if (entries.has(key) || isNativeSinkFeedback(key) || optedNotices.get(key)?.renderer === "web" || nativeSinkWebFallbackIds.has(key)) continue;
    const notice: OptedNotice = { key, message: value.title, mode: "default", sonnerType: value.type,
      toastId: value.id, actionInvoked: false, dismissInvoked: false, autoCloseInvoked: false,
      options: { id: key, description: value.description as string | undefined, duration: value.duration,
        dismissible: value.dismissible, closeButton: value.closeButton,
        onDismiss: value.onDismiss ? record => value.onDismiss?.(record ?? value) : undefined,
        onAutoClose: value.onAutoClose ? record => value.onAutoClose?.(record ?? value) : undefined } };
    if (!validNotice(notice)) continue;
    const route = nativeNoticeOptions(notice);
    if (!route) continue;
    notice.renderer = "native"; optedNotices.set(key, notice);
    // Same-ID patch; do not recreate a promise or copy its settlement getters.
    noticeMethod("default", value.type)(value.title, { id: value.id, toasterId: route.toasterId });
    adopted = true;
  }
  return adopted ? toast.getToasts() : toasts;
}

export function reconcileNativeFeedback(toasts: readonly ToastT[]) {
  toasts = admitOrdinaryNotices(toasts);
  reconcileNativeSinkFeedback(toasts);
  const currentIds = new Set(toasts.map(t => String(t.id)));
  for (const id of nativeSinkWebFallbackIds) if (!currentIds.has(id)) nativeSinkWebFallbackIds.delete(id);
  for (const [id, notice] of optedNotices) {
    const toastId = String(notice.toastId);
    if (!currentIds.has(toastId)) { if (!entries.has(id)) optedNotices.delete(id); continue; }
  }
  latestToasts = toasts;
  const active = new Set(toasts.filter(t => t.toasterId === NATIVE_FEEDBACK_TOASTER).map(t => String(t.id)));
  const allActive = new Set(toasts.map(t => String(t.id)));
  for (const [id, entry] of entries) {
    const toastId = String(entry.toastId);
    if (entry.transferring) continue;
    if (active.has(toastId)) {
      if (entry.notice && !entry.owner.current()) transferNativeNotice(id, entry);
      continue;
    }
    if (allActive.has(toastId)) {
      const current = toasts.find(value => String(value.id) === toastId);
      const dismissed = current && "dismiss" in current && Boolean(current.dismiss);
      if (entry.notice && !dismissed) transferNativeNotice(id, entry);
      else retire(id, entry, false);
    } else if (entry.observed) retire(id, entry);
  }
  for (const t of toasts) {
    if (t.toasterId !== NATIVE_FEEDBACK_TOASTER) continue;
    const toastId = String(t.id), match = [...entries].find(([, candidate]) => String(candidate.toastId) === toastId);
    const [id, entry] = match ?? [];
    if (!entry || !id) { if (!isNativeSinkFeedback(toastId)) toast.dismiss(t.id); continue; }
    entry.observed = true;
    if (!live(entry.owner, entry.context) || entry.form && !entry.form.current() || typeof t.title !== "string" || t.description != null && typeof t.description !== "string") {
      retireUnavailable(id, entry); continue;
    }
    // Compatible presentation updates may be in flight. Keep only the latest
    // Sonner state until actual admission; never discard a committed outcome.
    if (entry.owner.ready?.() === false || entry.form?.ready() === false) continue;
    const message = [t.title, t.description].filter(Boolean).join(" ");
    const tone = t.type === "default" || t.type === "action" || !t.type ? "normal" : t.type;
    const duration = tone === "loading" || t.duration === Infinity ? 0 : Math.max(1000, Math.min(30000, t.duration ?? 3600));
    const actionToken = entry.notice?.options.action?.token ?? null;
    const actionLabel = entry.notice?.options.action?.label ?? null;
    const fingerprint = JSON.stringify([message, tone, duration, t.dismissible, actionToken, actionLabel]);
    if (fingerprint === entry.fingerprint) continue;
    entry.fingerprint = fingerprint;
    entry.revision++;
    const state: NativeFeedbackProjection = { ...identity(id, entry), message, tone, duration, dismissible: t.dismissible !== false,
      actionToken, actionLabel };
    const revision = entry.revision;
    void entry.owner.plugin.applyFeedback?.(state).then(receipt => {
      if (!entry.retired && entry.revision === revision && receipt.applied !== true) {
        if (receipt.pending === true) entry.fingerprint = "";
        else retireUnavailable(id, entry);
      }
    }).catch(() => { if (!entry.retired && entry.revision === revision) retireUnavailable(id, entry); });
  }
}
