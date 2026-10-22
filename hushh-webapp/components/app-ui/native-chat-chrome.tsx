"use client";

import { NATIVE_PANEL_LAYOUT_EVENT } from "@/lib/capacitor/native-panel-presentation";
import { NativeChromeFocusCancelled } from "@/lib/capacitor/native-chrome";
import { customNativePresentationEnabled } from "@/lib/capacitor/native-presentation-policy";
import { appHaptic } from "@/lib/capacitor/app-haptics";

import { Capacitor, type PluginListenerHandle } from "@capacitor/core";
import { AnimatedMenuCrossIcon } from "@/components/agent/animated-menu-cross-icon";
import { ShellActionSurface } from "@/components/app-ui/shell-action-surface";
import { useCallback, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode, type Ref, type RefObject } from "react";
import { NativeChromeLease, chromeControlId, chromeOwnerEpoch, currentChromeInstallation, canResumeNativeChrome, suspendOwnedNativeChrome, peekNativeChromeCapabilities, getNativeChromeCapabilities, hasOutstandingNativeChrome, supportsNativeChrome, nativeChrome, retireNativeChrome, retireOwnedNativeChrome, measureNativeChromeGeometry, type ChromeAgentSurface, type ChromeChoice, type ChromeChoiceOutcome, type ChromeOption, type ChromeControl, type ChromeAccentPalette } from "@/lib/capacitor/native-chrome";
import { nativeShellOverlayBlocked, useNativeShellOverlayBlocked } from "@/lib/capacitor/native-navigation";
import { nativeDocumentId, subscribeNativeSessionPrivacy } from "@/lib/capacitor/session-privacy";
import { isCurrentNativeControlAppearance, NATIVE_CONTROL_CONTRACT_VERSION, useNativeControlAppearance } from "@/lib/capacitor/native-control-appearance";
import { isSessionChromeSuppressed, useSessionChromeSuppressed } from "@/lib/auth/use-session-chrome-suppression";
import { getVoiceSurfaceMetadata, useVoiceSurfaceMetadata } from "@/lib/kai/actions/voice-surface-metadata";

export type NativeChatChromeHandle = { restoreFocus: (preferNative?: boolean) => Promise<boolean> };
const rehearsalFailureCodes = new Set([
  "NATIVE_CHROME_ACK_UNCERTAIN", "NATIVE_CHROME_PREPARE_REFUSED",
  "NATIVE_CHROME_DOCUMENT_OR_GEOMETRY_STALE", "NATIVE_CHROME_OVERLAPPING_CONTROLS",
  "NATIVE_CHROME_OPTIONS_INVALID", "NATIVE_CHROME_LAYOUT_UNCONFIRMED",
  "NATIVE_CHROME_LAYOUT_RETIRED", "NATIVE_CHROME_ACTIVATE_REFUSED",
  "NATIVE_CHROME_ACTIVATE_UNCONFIRMED", "NATIVE_CHROME_RETIRE_UNCONFIRMED", "NATIVE_CHROME_RETIRE_STALE",
  "NATIVE_CHROME_UPDATE_INVALID", "NATIVE_CHROME_UPDATE_UNCONFIRMED",
  "NATIVE_CHROME_SUSPEND_REFUSED", "NATIVE_CHROME_SUSPEND_UNCONFIRMED",
]);
function rehearsalFailureCode(error: unknown): string {
  return error instanceof Error && rehearsalFailureCodes.has(error.message) ? error.message : "other";
}
type Props = {
  contentPane?: import("@/lib/capacitor/native-chrome").NativeContentPaneIdentity;
  owner: string | null;
  /** Parent-owned route/session context; include the vault epoch and motion admission. */
  context: string;
  /** True only for the visible, unlocked, stationary owning surface. */
  eligible: boolean;
  className: string;
  style?: CSSProperties;
  children: ReactNode;
  /** The authored fallback button (or selected radio), never an inferred DOM control. */
  focusRef: RefObject<HTMLElement | null>;
  /** Layout/activation receipt only; never permission to invoke an operation. */
  onPresentationReady?: () => void;
  /** Explicit feature layer; never inferred from a dialog or its DOM. */
  interactionLayer?: string;
  ref?: Ref<NativeChatChromeHandle>;
} & ({ kind: "close"; onActivate: () => void; label: string } |
  { kind: "profile-back"; onActivate: () => void; label: string } |
  { kind: "history"; onActivate: () => void; expanded?: boolean;
  /** Omission or any nonzero count retains the authored notification/badge DOM. Never bridged. */
  pendingAttention?: number } |
  { kind: "agent-surface"; value: ChromeAgentSurface; onValueChange: (value: ChromeAgentSurface) => void } |
  { kind: "appearance"; value: "light" | "dark" | "system"; onValueChange: (value: "light" | "dark" | "system") => void } |
  { kind: "accent"; value: "blue" | "gold"; fullTrigger?: boolean; palette?: ChromeAccentPalette; onValueChange: (value: "blue" | "gold") => void } |
  { kind: "more"; label: string; options: readonly ChromeOption[]; onValueChange: (value: string) => void } |
  { kind: "selection"; label: string; value: string; options: readonly ChromeOption[]; onValueChange: (value: string) => void } |
  { kind: "date"; label: string; value: string; minimum: string; maximum: string; onValueChange: (value: string) => void });

/** Opt-in presentation only. The caller retains its DOM control, layout and action
 * owner. History reserves 44x44; the two-option selector reserves 88..320 x 44.
 * New native families require --hushh-native-chat-chrome on a Debug iPhone.
 * Authored native/gesture dismissal can request acknowledged native focus;
 * DOM keyboard return keeps its fallback active until focus leaves the slot. */
export function NativeChatChrome(props: Props) {
  const { ref: handleRef, className, children } = props;
  const slot = useRef<HTMLDivElement>(null);
  const coherent = peekNativeChromeCapabilities()?.coherentPresentation === true;
  const kind = !coherent && props.kind === "history" && props.expanded && (peekNativeChromeCapabilities()?.panelPresentation || peekNativeChromeCapabilities()?.reservedPresentationRegions)
    ? "history-close" as const : props.kind;
  const controlId = chromeControlId(kind);
  // Only the current authored History layer may own Close. Anonymous/nested
  // overlays and the active drag still block it; Close is not globally exempt.
  const preference = kind === "appearance" || kind === "accent";
  const owningLayer = props.interactionLayer ?? (props.kind === "close" || props.kind === "profile-back" || preference ? "profile-pane" : !coherent && props.kind === "history" && props.expanded ? "chat-history" : undefined);
  const overlay = useNativeShellOverlayBlocked(owningLayer);
  const suppressed = useSessionChromeSuppressed();
  const surface = useVoiceSurfaceMetadata();
  const foreground = kind === "history" ? "secondary" : "accent";
  const theme = useNativeControlAppearance(foreground);
  const badgeAdmitted = props.kind !== "history" || props.pendingAttention === 0;
  const pilotCovered = !coherent && peekNativeChromeCapabilities()?.contentBackedPresentation === true && props.kind === "history" && props.expanded;
  // Coverage revokes actions, not presentation. The complete native drawer
  // isolates the retained base synchronously in its own view hierarchy.
  const allowed = !pilotCovered && badgeAdmitted && props.eligible && !!props.owner && !!theme && !suppressed &&
    (coherent || !overlay && surface?.interactionLayer?.blocksUnderlyingActions !== true);
  const [retainedControls, setRetainedControls] = useState(() => peekNativeChromeCapabilities()?.retainedControls === true);
  const epoch = useMemo(() => retainedControls ? chromeOwnerEpoch(props.owner, controlId) : crypto.randomUUID(), [props.owner, controlId, retainedControls]);
  const value = "value" in props ? props.value : undefined;
  // Labels/options/family are immutable for a lease; changing them retires it.
  const context = JSON.stringify([props.context, props.contentPane, owningLayer, "label" in props ? props.label : null,
    "options" in props ? props.options : null, props.kind === "date" ? [props.minimum, props.maximum] : null,
    props.kind === "accent" ? [props.fullTrigger, props.palette] : null]);
  const expanded = props.kind === "history" ? !coherent && (props.expanded ?? false) : undefined;
  const current = useRef({ allowed, epoch, context, value, props, owningLayer, theme, expanded });
  const lease = useRef<NativeChromeLease | null>(null);
  // Native invalidation removes the host, whereas local geometry/coverage
  // invalidation only revokes its binding. Never suspend/resume a removed host.
  const removedLease = useRef<NativeChromeLease | null>(null);
  const replacementCandidate = useRef<NativeChromeLease | null>(null);
  const heldFocus = useRef(false);
  const moving = useRef(false);
  const focusPending = useRef(false);
  const focusAttempt = useRef(0);
  const mounted = useRef(true);
  const [supported, setSupported] = useState(false);
  const [inPlaceUpdates, setInPlaceUpdates] = useState(false);
  const [historyReplacement, setHistoryReplacement] = useState(false);
  const [profileBackReplacement, setProfileBackReplacement] = useState(false);
  const [nativeFocusReturn, setNativeFocusReturn] = useState(false);
  type FocusRequest = { attempt: number; binding: NativeChromeLease | null; resolve: (restored: boolean) => void };
  const nativeFocusPending = useRef<FocusRequest | null>(null);
  const domFocusPending = useRef<FocusRequest | null>(null);
  const [, commitFocus] = useState(0);
  const [hidden, setHidden] = useState(() => customNativePresentationEnabled() && (hasOutstandingNativeChrome(controlId) ||
    (supportsNativeChrome(kind) || Capacitor.isNativePlatform() && Capacitor.getPlatform() === "ios" &&
      peekNativeChromeCapabilities() === undefined) &&
    badgeAdmitted && props.eligible && !!props.owner && !overlay && !suppressed));
  const [prepared, setPrepared] = useState<NativeChromeLease | null>(null);
  const notifiedReady = useRef<NativeChromeLease | null>(null);
  const notifyPresentationReady = useCallback((active: NativeChromeLease) => {
    const latest = current.current;
    // Staging readiness permits the originating menu to finish dismissal; it
    // does not grant touch authority over that still-covered destination.
    if (!mounted.current || lease.current !== active || !latest.allowed ||
        !active.admissionReady || !active.ownsInstallation || active.projection.documentId !== nativeDocumentId() ||
        active.projection.ownerEpoch !== latest.epoch || active.context !== latest.context ||
        !isCurrentNativeControlAppearance(active.projection, foreground) || notifiedReady.current === active ||
        !latest.props.onPresentationReady) return;
    notifiedReady.current = active;
    latest.props.onPresentationReady();
  }, [foreground]);
  const [measurement, remeasure] = useState(0);
  const rehearsalDiagnostics = useRef(false);
  const rehearsalChoice = useRef<ChromeChoiceOutcome | "none">("none");
  const [rehearsalStatus, setRehearsalStatus] = useState<string | null>(null);
  // Explicit Debug admission only. This memory-only public geometry probe has
  // no owner/document/context, protected content, response bodies or raw errors.
  const reportRehearsal = useCallback((stage: "skip" | "retire" | "prepare" | "activate" | "update",
    outcome: "pending" | "acknowledged" | "rejected", code = "none") => {
    if (!rehearsalDiagnostics.current) return;
    const frame = slot.current?.getBoundingClientRect();
    const dimension = (value: number | undefined) => value !== undefined && Number.isFinite(value)
      ? Math.max(0, Math.min(10000, Math.round(value))) : 0;
    setRehearsalStatus(JSON.stringify({ stage, outcome, code, choice: rehearsalChoice.current,
      eligible: current.current.props.eligible, supported, allowed: current.current.allowed,
      focusInside: !!slot.current?.contains(document.activeElement), heldFocus: heldFocus.current,
      overlayBlocked: nativeShellOverlayBlocked(current.current.owningLayer),
      inertBlocked: !!slot.current?.closest("[inert]"), moving: moving.current,
      suppressed: isSessionChromeSuppressed(),
      voiceBlocked: getVoiceSurfaceMetadata()?.interactionLayer?.blocksUnderlyingActions === true,
      documentHidden: document.visibilityState === "hidden",
      width: dimension(frame?.width), height: dimension(frame?.height),
      inViewport: !!frame && frame.left >= 0 && frame.top >= 0 && frame.right <= window.innerWidth && frame.bottom <= window.innerHeight }));
  }, [supported]);
  const reportChoice = useCallback((choice: ChromeChoiceOutcome) => {
    if (!rehearsalDiagnostics.current || !mounted.current) return;
    rehearsalChoice.current = choice;
    setRehearsalStatus(previous => previous ? JSON.stringify({ ...JSON.parse(previous), choice }) : previous);
  }, []);

  const canReachPresentation = useCallback(() => !nativeShellOverlayBlocked(current.current.owningLayer) &&
    !moving.current && !slot.current?.closest("[inert]") &&
    !isSessionChromeSuppressed() && !getVoiceSurfaceMetadata()?.interactionLayer?.blocksUnderlyingActions &&
    document.visibilityState !== "hidden", []);
  const canAct = useCallback(() => current.current.allowed && canReachPresentation(), [canReachPresentation]);
  // Preparing presentation grants no operation authority. A detail destination
  // is laid out while its native menu is still closing; rejecting preparation
  // solely for that coverage would expose a web Back or leave an empty slot.
  const canPrepare = useCallback(() => current.current.allowed && !moving.current &&
    !isSessionChromeSuppressed() && document.visibilityState !== "hidden" &&
    (peekNativeChromeCapabilities()?.coherentPresentation === true || canAct()), [canAct]);
  useLayoutEffect(() => {
    const old = current.current;
    if (old.allowed !== allowed || old.epoch !== epoch || old.context !== context || (!inPlaceUpdates && old.value !== value)) lease.current?.invalidate();
    if (old.epoch !== epoch || old.context !== context || !allowed) {
      focusAttempt.current += 1; heldFocus.current = false; focusPending.current = false;
      nativeFocusPending.current?.resolve(false); nativeFocusPending.current = null;
      domFocusPending.current?.resolve(false); domFocusPending.current = null;
    }
    current.current = { allowed, epoch, context, value, props, owningLayer, theme, expanded };
  });

  const restorePendingDomFocus = useCallback(() => {
    const pending = nativeFocusPending.current;
    nativeFocusPending.current = null;
    if (!pending) return;
    const allowed = mounted.current && pending.attempt === focusAttempt.current && canAct();
    if (!allowed) { pending.resolve(false); return; }
    heldFocus.current = true; focusPending.current = true;
    domFocusPending.current = pending;
    // Preparation already exposes fallback. A ref change and setHidden(false)
    // alone do not schedule the commit needed to apply its actual focus.
    commitFocus((count) => count + 1);
  }, [canAct]);
  const restoreNativeFocus = useCallback(async (active: NativeChromeLease) => {
    const pending = nativeFocusPending.current;
    if (!pending || pending.binding || lease.current !== active) return;
    pending.binding = active;
    const isCurrent = () => mounted.current && nativeFocusPending.current === pending &&
      focusAttempt.current === pending.attempt && pending.binding === active && lease.current === active &&
      active.projection.documentId === nativeDocumentId() &&
      active.projection.ownerEpoch === current.current.epoch && active.context === current.current.context &&
      isCurrentNativeControlAppearance(active.projection, foreground) && canAct();
    try {
      if (await active.restoreFocus(() => {
        const geometry = slot.current && measureNativeChromeGeometry(slot.current, kind);
        return isCurrent() && !!geometry && active.matchesGeometry(geometry);
      }) && isCurrent() && active.ownsInstallation) {
        nativeFocusPending.current = null; pending.resolve(true); return;
      }
    } catch (error) {
      if (error instanceof NativeChromeFocusCancelled) {
        if (nativeFocusPending.current === pending) {
          nativeFocusPending.current = null; pending.resolve(false);
        }
        return; // A confirmed keyboard cancellation retains the native host.
      }
      /* Unsupported/uncertain focus never replays an action. */
    }
    if (!isCurrent() || !active.ownsInstallation) {
      // Cleanup can rebind the same current attempt to a resized replacement.
      // Completion from its retired predecessor must not settle that request.
      if (nativeFocusPending.current === pending && pending.binding === active) {
        nativeFocusPending.current = null; pending.resolve(false);
      }
      return;
    }
    active.invalidate();
    try {
      await retireNativeChrome(active.projection.ownerEpoch, active.projection, controlId);
      if (!isCurrent() || hasOutstandingNativeChrome(controlId)) {
        if (nativeFocusPending.current === pending && pending.binding === active) {
          nativeFocusPending.current = null; pending.resolve(false);
        }
        return;
      }
      restorePendingDomFocus(); setPrepared(null); setHidden(false);
    } catch {
      if (nativeFocusPending.current === pending) nativeFocusPending.current = null;
      pending.resolve(false); // Remain quarantined until confirmed retirement.
    }
  }, [canAct, controlId, foreground, kind, restorePendingDomFocus]);
  useImperativeHandle(handleRef, () => ({ restoreFocus: async (preferNative = false) => {
    nativeFocusPending.current?.resolve(false); nativeFocusPending.current = null;
    domFocusPending.current?.resolve(false); domFocusPending.current = null;
    const request = current.current;
    const attempt = ++focusAttempt.current;
    const isCurrentAttempt = () => mounted.current && focusAttempt.current === attempt &&
      current.current.epoch === request.epoch && current.current.context === request.context;
    // Focus is not authority to retire a covered or moving presentation.
    // The owning admission effect reconciles it after the overlay releases.
    if (!canAct()) {
      // A usable authored web opener does not require native/vault admission.
      // Never transfer focus while an uncertain native instance can still own it.
      const target = request.props.focusRef.current;
      if (hidden || hasOutstandingNativeChrome(controlId) || !canReachPresentation() ||
          !isCurrentAttempt() || !target?.isConnected || target.matches(":disabled") ||
          target.closest("[inert]")) return false;
      target.focus({ preventScroll: true });
      return document.activeElement === target;
    }
    const active = lease.current;
    const geometry = slot.current && measureNativeChromeGeometry(slot.current, kind);
    if (preferNative && supported && nativeFocusReturn && canAct() && !heldFocus.current &&
        !slot.current?.contains(document.activeElement) && active?.focusReady && geometry &&
        active.projection.ownerEpoch === request.epoch && active.context === request.context &&
        active.matchesGeometry(geometry) && isCurrentNativeControlAppearance(active.projection, foreground)) {
      // Returning focus is not a new installation. Keep an already-active,
      // stationary control; the acknowledged focus path still fences failure,
      // resize, owner changes and stale completion before exposing fallback.
      const result = new Promise<boolean>((resolve) => { nativeFocusPending.current = { attempt, binding: null, resolve }; });
      void restoreNativeFocus(active);
      return result;
    }
    if (preferNative && supported && nativeFocusReturn && !heldFocus.current &&
        !slot.current?.contains(document.activeElement) && active && geometry &&
        active.projection.ownerEpoch === request.epoch && active.context === request.context &&
        active.canAwaitFocusAt(geometry) && isCurrentNativeControlAppearance(active.projection, foreground)) {
      // Preparation/activation already owns this exact slot. Do not invalidate
      // it just because Close's focus callback ran before its receipt.
      return new Promise<boolean>((resolve) => { nativeFocusPending.current = { attempt, binding: null, resolve }; });
    }
    heldFocus.current = true;
    lease.current?.invalidate();
    try {
      if (supported || hasOutstandingNativeChrome(controlId)) {
        // The authored Close can own this control ID while the retained opener
        // holds an older projection. Return must retire the current slot, not
        // mistake a stale-target no-op for confirmed removal.
        await retireNativeChrome(request.epoch, undefined, controlId);
      }
      if (!isCurrentAttempt() || !canAct()) {
        if (isCurrentAttempt()) {
          heldFocus.current = false; focusPending.current = false;
          remeasure((count) => count + 1);
        }
        return false;
      }
      if (preferNative && supported && nativeFocusReturn && canAct()) {
        // Only the authored native/gesture return path opts in. DOM keyboard
        // activation retains the existing focus hold rather than being hidden.
        heldFocus.current = false;
        const result = new Promise<boolean>((resolve) => { nativeFocusPending.current = { attempt, binding: null, resolve }; });
        setPrepared(null); setHidden(true); remeasure((count) => count + 1);
        return result;
      }
      focusPending.current = true;
      setPrepared(null);
      setHidden(false);
      remeasure((count) => count + 1);
      return true; // Focus is applied after React commits removal of inert/hidden.
    } catch {
      // Quarantine still requires confirmed retirement. A failed attempt must
      // not leave a focus hold when it never transferred focus to the fallback.
      if (isCurrentAttempt()) {
        heldFocus.current = false;
        focusPending.current = false;
        remeasure((count) => count + 1);
      }
      return false;
    }
  } }));
  useLayoutEffect(() => {
    if (!hidden && focusPending.current && canAct()) {
      focusPending.current = false;
      const target = props.focusRef.current;
      target?.focus({ preventScroll: true });
      const pending = domFocusPending.current;
      domFocusPending.current = null;
      pending?.resolve(pending.attempt === focusAttempt.current && !!target && document.activeElement === target);
    }
  });

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false; focusAttempt.current += 1;
      nativeFocusPending.current?.resolve(false); nativeFocusPending.current = null;
      domFocusPending.current?.resolve(false); domFocusPending.current = null;
    };
  }, []);
  useLayoutEffect(() => {
    if (!customNativePresentationEnabled() || !Capacitor.isNativePlatform() || Capacitor.getPlatform() !== "ios") return;
    let cancelled = false;
    let subscriptionsFailed = false;
    const handles: PluginListenerHandle[] = [];
    const recoveryDocument = nativeDocumentId(), recoveryEpoch = current.current.epoch;
    const recovering = lease.current;
    const retain = async (pending: Promise<PluginListenerHandle>) => {
      const handle = await pending;
      if (cancelled || subscriptionsFailed) await handle.remove(); else handles.push(handle);
    };
    const invalidate = () => { lease.current?.invalidate(); remeasure((count) => count + 1); };
    const invalidateRemoved = () => { removedLease.current = lease.current; invalidate(); };
    const readmit = () => {
      const active = lease.current, snapshot = current.current;
      if (cancelled || subscriptionsFailed || !active?.ownsInstallation || active.context !== snapshot.context || active.projection.ownerEpoch !== snapshot.epoch || !snapshot.theme) return;
      void active.update({ ...snapshot.theme, enabled: canAct(), value: snapshot.value, expanded: snapshot.expanded }, true).then(applied => {
        if (applied) notifyPresentationReady(active);
      }).catch(() => {
        const latest = current.current;
        if (!cancelled && !subscriptionsFailed && lease.current === active && active.projection.documentId === nativeDocumentId() &&
            active.projection.ownerEpoch === latest.epoch && active.context === latest.context) invalidate();
      });
    };
    const reconcileGeometry = () => {
      const geometry = slot.current && measureNativeChromeGeometry(slot.current, kind);
      if (geometry && canPrepare() && !heldFocus.current && lease.current?.matchesGeometry(geometry)) return;
      invalidate();
    };
    void (async () => {
      try {
        const capability = await getNativeChromeCapabilities();
        if (cancelled || !capability || capability.contractVersion !== NATIVE_CONTROL_CONTRACT_VERSION ||
            capability.independentControls !== true || !capability.families.includes(kind) ||
            current.current.props.kind === "accent" && current.current.props.fullTrigger && !capability.fullAccentTrigger) {
          // Capability discovery creates no installation. Keep the reserved
          // slot concealed until it settles, then expose unsupported fallback
          // only when no earlier lease still owns native presentation.
          if (!cancelled) setHidden(hasOutstandingNativeChrome(controlId));
          return;
        }
        rehearsalDiagnostics.current = capability.rehearsalDiagnostics === true;
        await Promise.all([retain(nativeChrome.addListener("choiceRequested", (event: ChromeChoice) => {
          if (event.controlId !== controlId) return;
          const active = lease.current;
          void active?.choose(event, () => lease.current === active && current.current.epoch === active.projection.ownerEpoch &&
            current.current.context === active.context && isCurrentNativeControlAppearance(active.projection, foreground) && canAct(), () => {
            const callback = current.current.props;
            if (callback.kind === "history" || callback.kind === "close" || callback.kind === "profile-back") {
              appHaptic("light", `${event.ownerEpoch}:${event.controlId}:${event.revision}:${event.sequence}`);
              callback.onActivate();
            }
            else if (callback.kind === "agent-surface") { if (event.value === "one" || event.value === "puppy") callback.onValueChange(event.value); }
            else if (callback.kind === "appearance") { if (event.value === "light" || event.value === "dark" || event.value === "system") callback.onValueChange(event.value); }
            else if (callback.kind === "accent") { if (event.value === "blue" || event.value === "gold") callback.onValueChange(event.value); }
            else if (event.value !== undefined) callback.onValueChange(event.value);
          }).then(outcome => {
            if (outcome && lease.current === active) reportChoice(outcome);
          }).catch(() => { if (lease.current === active) reportChoice("uncertain"); });
        })), retain(nativeChrome.addListener("invalidated", invalidateRemoved)),
        retain(nativeChrome.addListener("readmissionRequested", readmit)), retain(subscribeNativeSessionPrivacy(invalidateRemoved))]);
        if (!cancelled) {
          setInPlaceUpdates(capability.inPlaceUpdates === true);
          setRetainedControls(capability.retainedControls === true);
          setHistoryReplacement(capability.historyReplacement === true);
          setProfileBackReplacement(capability.profileBackReplacement === true);
          setNativeFocusReturn(capability.focusReturn === true && kind !== "agent-surface"); setSupported(true);
        }
      } catch {
        if (cancelled) return;
        subscriptionsFailed = true;
        handles.splice(0).forEach((handle) => { void handle.remove(); });
        if (nativeDocumentId() !== recoveryDocument || current.current.epoch !== recoveryEpoch) return;
        try {
          if (recovering) await retireOwnedNativeChrome(recovering.projection);
          else if (!hasOutstandingNativeChrome(controlId)) await retireNativeChrome(recoveryEpoch, undefined, controlId);
          if (!cancelled) setHidden(hasOutstandingNativeChrome(controlId));
        } catch { /* Retain quarantine until native retirement is confirmed. */ }
      }
    })();
    const releaseFocus = () => {
      if (!slot.current?.contains(document.activeElement) && heldFocus.current) {
        heldFocus.current = false;
        invalidate();
      }
    };
    const onFocusOut = () => { queueMicrotask(() => { if (!cancelled) releaseFocus(); }); };
    const node = slot.current;
    node?.addEventListener("focusout", onFocusOut);
    document.addEventListener("visibilitychange", invalidate);
    window.addEventListener("resize", reconcileGeometry);
    window.addEventListener(NATIVE_PANEL_LAYOUT_EVENT, reconcileGeometry);
    const observer = new ResizeObserver(reconcileGeometry);
    if (node) observer.observe(node);
    return () => {
      cancelled = true;
      rehearsalDiagnostics.current = false;
      handles.forEach((handle) => { void handle.remove(); });
      observer.disconnect();
      node?.removeEventListener("focusout", onFocusOut);
      document.removeEventListener("visibilitychange", invalidate);
      window.removeEventListener("resize", reconcileGeometry);
      window.removeEventListener(NATIVE_PANEL_LAYOUT_EVENT, reconcileGeometry);
      setSupported(false);
    };
  }, [kind, controlId, foreground, canAct, canPrepare, reportChoice, notifyPresentationReady]);

  // Content preferences are public, but their coordinates are not stationary
  // while a retained Profile stack or scroll root moves. Fence choices at the
  // event, publish only burst boundaries, and remeasure after settlement.
  useLayoutEffect(() => {
    if (!preference || !slot.current) return;
    const node = slot.current;
    const ancestors: HTMLElement[] = [];
    for (let parent = node.parentElement; parent; parent = parent.parentElement) ancestors.push(parent);
    let timer = 0;
    const transitions = new Set<EventTarget>();
    const animations = new Map<EventTarget, Set<string>>();
    const mirrored = (ancestor: HTMLElement) => peekNativeChromeCapabilities()?.panelPresentation && ancestor.hasAttribute("data-native-panel-group");
    const transformRunning = () => ancestors.some((ancestor) => !mirrored(ancestor) && ancestor.getAnimations?.().some((animation) =>
      animation.playState === "running" && animation.effect instanceof KeyframeEffect &&
      animation.effect.getKeyframes().some((frame) => "transform" in frame)));
    const settle = () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        // A 300ms pane transition must not be admitted after a 150ms quiet
        // interval. Also catch a transition already running when we mounted.
        if (transitions.size || animations.size || transformRunning()) { settle(); return; }
        moving.current = false; remeasure((count) => count + 1);
      }, 150);
    };
    const move = () => {
      if (!moving.current) { moving.current = true; lease.current?.invalidate(); remeasure((count) => count + 1); }
      settle();
    };
    const transition = (event: TransitionEvent) => {
      if (event.target !== event.currentTarget || event.propertyName !== "transform") return;
      if (mirrored(event.currentTarget as HTMLElement)) return;
      if (event.type === "transitionrun") transitions.add(event.currentTarget!);
      else transitions.delete(event.currentTarget!);
      move();
    };
    const animation = (event: AnimationEvent) => {
      if (event.target !== event.currentTarget || !event.currentTarget) return;
      if (mirrored(event.currentTarget as HTMLElement)) return;
      // This owned frame changes opacity only. Its controls sit outside the
      // translated body, so revoking their geometry would recreate the swap.
      if (["stationary-side-frame-enter", "stationary-side-frame-exit"].includes(event.animationName)) return;
      const names = animations.get(event.currentTarget) ?? new Set<string>();
      if (event.type === "animationstart") names.add(event.animationName);
      else names.delete(event.animationName);
      if (names.size) animations.set(event.currentTarget, names);
      else animations.delete(event.currentTarget);
      move();
    };
    for (const ancestor of ancestors) {
      ancestor.addEventListener("scroll", move, { passive: true });
      ancestor.addEventListener("transitionrun", transition);
      ancestor.addEventListener("transitionend", transition);
      ancestor.addEventListener("transitioncancel", transition);
      ancestor.addEventListener("animationstart", animation);
      ancestor.addEventListener("animationend", animation);
      ancestor.addEventListener("animationcancel", animation);
    }
    // A valid, already stationary slot does not need an artificial admission
    // delay. Preserve recovery for unmeasurable geometry, unknown animation
    // inspection and a transform that began before listeners were installed.
    if (ancestors.some((ancestor) => typeof ancestor.getAnimations !== "function") ||
        transformRunning() || !measureNativeChromeGeometry(node, kind)) move();
    return () => {
      window.clearTimeout(timer);
      moving.current = false;
      for (const ancestor of ancestors) {
        ancestor.removeEventListener("scroll", move);
        ancestor.removeEventListener("transitionrun", transition);
        ancestor.removeEventListener("transitionend", transition);
        ancestor.removeEventListener("transitioncancel", transition);
        ancestor.removeEventListener("animationstart", animation);
        ancestor.removeEventListener("animationend", animation);
        ancestor.removeEventListener("animationcancel", animation);
      }
    };
  }, [preference, context, kind]);

  // Legacy wrappers reinstall; capable wrappers preserve containment and focus.
  const installationPresentation = inPlaceUpdates ? "in-place" : JSON.stringify({ theme, value, expanded });
  useLayoutEffect(() => {
    if (!supported) return;
    let cancelled = false;
    let owned: NativeChromeLease | null = null;
    let inactive = false;
    const previous = replacementCandidate.current;
    replacementCandidate.current = null;
    const retiring = lease.current;
    const capturedInstallation = currentChromeInstallation(controlId);
    lease.current?.invalidate();
    void (async () => {
      let stage: "retire" | "prepare" = "retire";
      try {
        const { theme, expanded, value, props } = current.current;
        inactive = !allowed || !theme || !canPrepare() || heldFocus.current || !slot.current;
        let geometry = allowed && theme && canPrepare() && !heldFocus.current && slot.current &&
          !slot.current.contains(document.activeElement) ? measureNativeChromeGeometry(slot.current, kind) : null;
        const control: ChromeControl & { label: string } =
          props.kind === "close" || props.kind === "profile-back" ? { kind: props.kind, label: props.label } :
          props.kind === "history" ? { kind: kind === "history-close" ? "history-close" : "history", expanded, label: expanded ? "Close chat history" : "Chat history" } :
          props.kind === "agent-surface" ? { kind: "agent-surface", value: props.value, label: "Agent" } :
          props.kind === "appearance" ? { kind: "appearance", value: props.value, label: "Appearance" } :
          props.kind === "accent" ? { kind: "accent", value: props.value, fullTrigger: props.fullTrigger, palette: props.palette, label: "App accent color" } :
          props.kind === "date" ? { kind: "date", value: props.value, minimum: props.minimum, maximum: props.maximum, label: props.label } :
          props.kind === "selection" ? { kind: "selection", value: props.value, options: props.options, label: props.label } :
          { kind: "more", options: props.options, label: props.label };
        const retainHost = peekNativeChromeCapabilities()?.retainedControls === true &&
          props.eligible && badgeAdmitted && !!props.owner && !isSessionChromeSuppressed() &&
          retiring !== removedLease.current && retiring?.projection.ownerEpoch === epoch;
        // A compatible active handoff must stay visible. Suspension belongs to
        // an actually inactive surface, not a route/action revision change.
        // The native replacement contract fences interaction until activation.
        const replacing = !inactive && previous && theme && geometry && (
          historyReplacement && kind === "history" && props.kind === "history" &&
            previous.canReplaceHistoryWith({ kind: "history", expanded, label: "Chat history", enabled: true, ...theme, ...geometry }, epoch, context) ||
          profileBackReplacement && props.kind === "profile-back" &&
            previous.canReplaceBackWith({ kind: "profile-back", label: props.label, enabled: true, ...theme, ...geometry,
              ...(props.contentPane ? { contentPane: props.contentPane } : {}) }, epoch, context));
        if (!replacing && retainHost && retiring) await suspendOwnedNativeChrome(retiring);
        if (cancelled) return;
        const resuming = !replacing && retiring !== removedLease.current && peekNativeChromeCapabilities()?.retainedControls === true && theme && geometry &&
          await canResumeNativeChrome({ ...control, enabled: true, ...theme, ...geometry,
            ...(props.contentPane ? { contentPane: props.contentPane } : {}) }, epoch);
        if (cancelled || current.current.epoch !== epoch || current.current.context !== context) return;
        if (!replacing && !resuming && !(inactive && retainHost)) {
          // Qualified warm geometry must not expose its web replacement while
          // the bridge acknowledges strict retirement. Focused/moving fallback
          // controls remain with their existing interaction owner.
          if (geometry && retiring?.ownsInstallation) setHidden(true);
          reportRehearsal(stage, "pending");
          // An inactive retained instance owns only its previous installation,
          // not a newer authored control sharing this presentation slot.
          if (inactive) {
            if (retiring) await retireOwnedNativeChrome(retiring.projection);
          } else if (retiring) await retireOwnedNativeChrome(retiring.projection);
          else if (capturedInstallation) await retireNativeChrome(epoch, capturedInstallation, controlId);
          else if (!hasOutstandingNativeChrome(controlId)) await retireNativeChrome(epoch, undefined, controlId);
          if (cancelled) return;
          if (!inactive && hasOutstandingNativeChrome(controlId)) {
            // Newer slot ownership survived this older removal fence. Do not
            // mint a fresh lease merely because its acknowledgement arrived.
            setPrepared(null); setHidden(true);
            nativeFocusPending.current?.resolve(false); nativeFocusPending.current = null;
            return;
          }
        }
        setPrepared(null);
        if (!allowed || !theme || !canPrepare() || heldFocus.current || !slot.current) {
          setHidden(hasOutstandingNativeChrome(controlId));
          nativeFocusPending.current?.resolve(false); nativeFocusPending.current = null;
          reportRehearsal("skip", "acknowledged", "not-admitted"); return;
        }
        // Preserve keyboard focus rather than hiding a focused fallback.
        if (slot.current.contains(document.activeElement)) {
          setHidden(false);
          heldFocus.current = true; nativeFocusPending.current?.resolve(false); nativeFocusPending.current = null;
          reportRehearsal("skip", "acknowledged", "focused"); return;
        }
        // Strict removal can wait across a DOM-only position change. Its
        // pre-removal measurement qualifies a handoff, not a new installation.
        if (!replacing) geometry = measureNativeChromeGeometry(slot.current, kind);
        if (!geometry) {
          setHidden(hasOutstandingNativeChrome(controlId));
          nativeFocusPending.current?.resolve(false); nativeFocusPending.current = null;
          reportRehearsal("skip", "acknowledged", "geometry"); return;
        }
        if (kind === "agent-surface" && value === undefined) { setHidden(false); return; }
        const next = new NativeChromeLease({ ...control,
          enabled: true, ...theme, ...geometry, ...(props.contentPane ? { contentPane: props.contentPane } : {}) }, epoch, context, inPlaceUpdates);
        owned = next;
        lease.current = next;
        stage = "prepare";
        // Keep the same reserved slot concealed across a native-to-native
        // handoff. Do not paint an intermediate, clickable web replacement.
        setHidden(true);
        reportRehearsal(stage, "pending");
        const ready = replacing && previous
          ? props.kind === "profile-back" ? await next.prepareBackReplacement(previous) : await next.prepareHistoryReplacement(previous)
          : await next.prepare();
        if (ready && !cancelled) { reportRehearsal(stage, "acknowledged"); setHidden(true); setPrepared(next); }
      } catch (error) {
        if (cancelled || (owned && lease.current !== owned)) return;
        reportRehearsal(stage, "rejected", rehearsalFailureCode(error));
        owned?.invalidate();
        try {
          // Failure is not authority over a newer mounted control. Preserve
          // cleanup of either revision of this lease's uncertain handoff.
          const recovery = owned ?? retiring;
          if (recovery) await retireOwnedNativeChrome(recovery.projection);
          else if (!inactive && !hasOutstandingNativeChrome(controlId)) await retireNativeChrome(epoch, undefined, controlId);
          if (!cancelled) {
            const occupied = hasOutstandingNativeChrome(controlId);
            setHidden(occupied);
            if (!occupied) restorePendingDomFocus();
            else { nativeFocusPending.current?.resolve(false); nativeFocusPending.current = null; }
          }
        }
        catch {
          if (!cancelled) {
            nativeFocusPending.current?.resolve(false); nativeFocusPending.current = null;
            setHidden(true);
          }
        }
      }
    })();
    return () => {
      cancelled = true;
      replacementCandidate.current = (kind === "history" || kind === "profile-back") && owned?.replacementReady ? owned : null;
      owned?.invalidate();
      if (owned && nativeFocusPending.current?.binding === owned) nativeFocusPending.current.binding = null;
      // The next committed layout explicitly replaces or hard-retires this
      // slot. Actual unmount has its own strict removal below.
    };
  }, [supported, allowed, badgeAdmitted, epoch, context, controlId, kind, preference, measurement, installationPresentation, inPlaceUpdates, historyReplacement, profileBackReplacement, canAct, canPrepare, reportRehearsal, restorePendingDomFocus]);

  useLayoutEffect(() => () => {
    replacementCandidate.current = null;
    const active = lease.current;
    active?.invalidate();
    // Removal reserves its revision before another mounted slot can prepare.
    // A pending handoff may still own its predecessor, so remove either one.
    if (active) {
      // An absent React owner is not an overlay. Suspension intentionally
      // preserves visible pixels beneath native drawers, so it would leak
      // Chat-only controls onto the next route. Covered mounted owners retain;
      // actual unmount must acknowledge removal of this exact installation.
      void retireOwnedNativeChrome(active.projection).catch(() => undefined);
    }
  }, [controlId, kind]);

  useLayoutEffect(() => {
    if (!prepared || !hidden) return;
    reportRehearsal("activate", "pending");
    void prepared.activate().then(() => {
      if (!prepared.admissionReady) return;
      if (lease.current === prepared) {
        reportRehearsal("activate", "acknowledged");
        notifyPresentationReady(prepared);
        if (!inPlaceUpdates) void restoreNativeFocus(prepared);
      }
    }).catch(async (error) => {
      const isCurrent = () => mounted.current && lease.current === prepared && prepared.projection.documentId === nativeDocumentId() &&
        prepared.projection.ownerEpoch === current.current.epoch && prepared.context === current.current.context;
      if (!isCurrent()) return;
      reportRehearsal("activate", "rejected", rehearsalFailureCode(error));
      prepared.invalidate();
      try {
        await retireNativeChrome(prepared.projection.ownerEpoch, prepared.projection);
        if (!isCurrent()) return;
        const occupied = hasOutstandingNativeChrome(controlId);
        if (!occupied) restorePendingDomFocus();
        else { nativeFocusPending.current?.resolve(false); nativeFocusPending.current = null; }
        setPrepared(null); setHidden(occupied);
      } catch {
        if (lease.current === prepared) { nativeFocusPending.current?.resolve(false); nativeFocusPending.current = null; }
        // Quarantine until confirmed retirement.
      }
    });
  }, [prepared, hidden, controlId, reportRehearsal, inPlaceUpdates, restoreNativeFocus, restorePendingDomFocus, notifyPresentationReady]);

  useLayoutEffect(() => {
    if (!prepared || !hidden || !inPlaceUpdates || !theme) return;
    reportRehearsal("update", "pending");
    void prepared.update({ ...theme, enabled: canAct(), ...(value === undefined ? {} : { value }), ...(expanded === undefined ? {} : { expanded }) }).then((applied) => {
      if (applied && lease.current === prepared) {
        reportRehearsal("update", "acknowledged"); notifyPresentationReady(prepared); void restoreNativeFocus(prepared);
      }
    }).catch(async (error) => {
      const isCurrent = () => mounted.current && lease.current === prepared && prepared.projection.documentId === nativeDocumentId() &&
        prepared.projection.ownerEpoch === current.current.epoch && prepared.context === current.current.context;
      if (!isCurrent()) return;
      reportRehearsal("update", "rejected", rehearsalFailureCode(error));
      prepared.invalidate();
      try {
        await retireNativeChrome(prepared.projection.ownerEpoch, prepared.projection);
        if (!isCurrent()) return;
        const occupied = hasOutstandingNativeChrome(controlId);
        if (!occupied) restorePendingDomFocus();
        else { nativeFocusPending.current?.resolve(false); nativeFocusPending.current = null; }
        setPrepared(null); setHidden(occupied);
      } catch {
        if (lease.current === prepared) { nativeFocusPending.current?.resolve(false); nativeFocusPending.current = null; }
        // Uncertain updates cannot restore a duplicate DOM control.
      }
    });
  }, [prepared, hidden, controlId, inPlaceUpdates, theme, value, expanded, overlay, suppressed, surface, canAct, reportRehearsal, restoreNativeFocus, restorePendingDomFocus, notifyPresentationReady]);

  return <div ref={slot} className={className} style={props.style} data-native-chrome-slot={controlId}>
    <div inert={hidden} aria-hidden={hidden || undefined} style={{ visibility: hidden ? "hidden" : undefined }}>{children}</div>
    {rehearsalStatus && <span id={kind === "agent-surface" ? "native-selector-rehearsal-status" : `native-control-status-${controlId}`}
      className="sr-only" role="status" aria-live="off" data-testid={kind === "agent-surface" ? "native-selector-rehearsal-status" : `native-control-status-${controlId}`}>NATIVE_SELECTOR_STATUS {rehearsalStatus}</span>}
  </div>;
}

/** The authored opener shares the Close family's presentation and focus contract. */
export function NativeHistoryOpener({ owner, context, eligible, open, pendingAttention, showAttentionDot,
  focusRef, ref, onActivate }: {
  owner: string | null; context: string; eligible: boolean; open: boolean;
  pendingAttention: number; showAttentionDot: boolean;
  focusRef: RefObject<HTMLButtonElement | null>; ref?: Ref<NativeChatChromeHandle>;
  onActivate: (preferNativeFocus: boolean, trigger?: HTMLButtonElement) => void;
}) {
  const label = open ? "Close chat history" : "Open chat history";
  const retainedBase = customNativePresentationEnabled() && (peekNativeChromeCapabilities()?.reservedPresentationRegions === true || peekNativeChromeCapabilities()?.coherentPresentation === true);
  return <NativeChatChrome kind="history" owner={owner} pendingAttention={pendingAttention}
    context={context} eligible={eligible && (retainedBase || !open)} style={{ visibility: open && !retainedBase ? "hidden" : undefined }}
    onActivate={() => onActivate(true)} focusRef={focusRef} ref={ref}
    className="relative z-[540] flex h-11 w-11 shrink-0 items-center justify-center">
    <ShellActionSurface variant="icon" id="one-chat-history-trigger" ref={focusRef}
      // Pointer entry may return to acknowledged native focus. Keyboard and
      // ambiguous activation retain the DOM focus target until explicit blur.
      onClick={(event) => { appHaptic("light"); onActivate(event.detail > 0, event.currentTarget); }}
      aria-label={`${label}${pendingAttention > 0 && !open
        ? `, ${pendingAttention} Drive ${pendingAttention === 1 ? "review needs" : "reviews need"} you` : ""}`}
      title={label} aria-expanded={open} className="relative z-[540] size-11">
      <AnimatedMenuCrossIcon isOpen={open} />
      {pendingAttention > 0 && !open && showAttentionDot
        ? <span aria-hidden="true" className="pointer-events-none absolute right-0 top-0 size-2 rounded-full bg-[color:var(--app-warning)]" /> : null}
    </ShellActionSurface>
  </NativeChatChrome>;
}

/** The moving drawer owns a React Close for its entire lifetime. It must not
 * borrow the stationary opener's native identity or switch after settlement. */
export function NativeHistoryClose({ onClose }: {
  owner: string | null; context: string; onClose: () => void; stationary?: boolean;
}) {
  return <span className="relative flex size-11 shrink-0 items-center justify-center">
    <ShellActionSurface variant="icon" aria-label="Close chat history" title="Close chat history"
      onClick={() => { appHaptic("light"); onClose(); }} className="size-11">
      <AnimatedMenuCrossIcon isOpen />
    </ShellActionSurface>
  </span>;
}
