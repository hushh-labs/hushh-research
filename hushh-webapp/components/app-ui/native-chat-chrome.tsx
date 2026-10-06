"use client";

import { Capacitor, type PluginListenerHandle } from "@capacitor/core";
import { XIcon } from "@/components/icons";
import { useCallback, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode, type Ref, type RefObject } from "react";
import { NativeChromeLease, chromeControlId, getNativeChromeCapabilities, hasOutstandingNativeChrome, supportsNativeChrome, nativeChrome, retireNativeChrome, type ChromeAgentSurface, type ChromeChoice, type ChromeOption, type ChromeControl } from "@/lib/capacitor/native-chrome";
import { nativeShellOverlayBlocked, useNativeShellOverlayBlocked } from "@/lib/capacitor/native-navigation";
import { subscribeNativeSessionPrivacy } from "@/lib/capacitor/session-privacy";
import { isCurrentNativeControlAppearance, NATIVE_CONTROL_CONTRACT_VERSION, useNativeControlAppearance } from "@/lib/capacitor/native-control-appearance";
import { isSessionChromeSuppressed, useSessionChromeSuppressed } from "@/lib/auth/use-session-chrome-suppression";
import { getVoiceSurfaceMetadata, useVoiceSurfaceMetadata } from "@/lib/voice/voice-surface-metadata";

export type NativeChatChromeHandle = { restoreFocus: (preferNative?: boolean) => Promise<boolean> };
const rehearsalFailureCodes = new Set([
  "NATIVE_CHROME_ACK_UNCERTAIN", "NATIVE_CHROME_PREPARE_REFUSED",
  "NATIVE_CHROME_DOCUMENT_OR_GEOMETRY_STALE", "NATIVE_CHROME_OVERLAPPING_CONTROLS",
  "NATIVE_CHROME_OPTIONS_INVALID", "NATIVE_CHROME_LAYOUT_UNCONFIRMED",
  "NATIVE_CHROME_LAYOUT_RETIRED", "NATIVE_CHROME_ACTIVATE_REFUSED",
  "NATIVE_CHROME_ACTIVATE_UNCONFIRMED", "NATIVE_CHROME_RETIRE_UNCONFIRMED",
  "NATIVE_CHROME_UPDATE_INVALID", "NATIVE_CHROME_UPDATE_UNCONFIRMED",
]);
function rehearsalFailureCode(error: unknown): string {
  return error instanceof Error && rehearsalFailureCodes.has(error.message) ? error.message : "other";
}
type Props = {
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
  ref?: Ref<NativeChatChromeHandle>;
} & ({ kind: "close"; onActivate: () => void; label: string } |
  { kind: "history"; onActivate: () => void; expanded?: boolean;
  /** Omission or any nonzero count retains the authored notification/badge DOM. Never bridged. */
  pendingAttention?: number } |
  { kind: "agent-surface"; value: ChromeAgentSurface; onValueChange: (value: ChromeAgentSurface) => void } |
  { kind: "appearance"; value: "light" | "dark" | "system"; onValueChange: (value: "light" | "dark" | "system") => void } |
  { kind: "accent"; value: "blue" | "gold"; onValueChange: (value: "blue" | "gold") => void } |
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
  const kind = props.kind;
  const controlId = chromeControlId(kind);
  // Only the current authored History layer may own Close. Anonymous/nested
  // overlays and the active drag still block it; Close is not globally exempt.
  const preference = kind === "appearance" || kind === "accent";
  const owningLayer = props.kind === "close" || preference ? "profile-pane" : props.kind === "history" && props.expanded ? "chat-history" : undefined;
  const overlay = useNativeShellOverlayBlocked(owningLayer);
  const suppressed = useSessionChromeSuppressed();
  const surface = useVoiceSurfaceMetadata();
  const foreground = kind === "history" ? "secondary" : "accent";
  const theme = useNativeControlAppearance(foreground);
  const badgeAdmitted = props.kind !== "history" || props.pendingAttention === 0;
  const allowed = badgeAdmitted && props.eligible && !!props.owner && !!theme && !overlay && !suppressed &&
    surface?.interactionLayer?.blocksUnderlyingActions !== true;
  const identity = useMemo(() => ({ owner: props.owner, controlId, epoch: crypto.randomUUID() }), [props.owner, controlId]);
  const epoch = identity.epoch;
  const value = "value" in props ? props.value : undefined;
  // Labels/options/family are immutable for a lease; changing them retires it.
  const context = JSON.stringify([props.context, "label" in props ? props.label : null,
    "options" in props ? props.options : null, props.kind === "date" ? [props.minimum, props.maximum] : null]);
  const expanded = props.kind === "history" ? props.expanded ?? false : undefined;
  const current = useRef({ allowed, epoch, context, value, props, owningLayer, theme, expanded });
  const lease = useRef<NativeChromeLease | null>(null);
  const heldFocus = useRef(false);
  const moving = useRef(false);
  const focusPending = useRef(false);
  const focusAttempt = useRef(0);
  const mounted = useRef(true);
  const [supported, setSupported] = useState(false);
  const [inPlaceUpdates, setInPlaceUpdates] = useState(false);
  const [nativeFocusReturn, setNativeFocusReturn] = useState(false);
  type FocusRequest = { attempt: number; binding: NativeChromeLease | null; resolve: (restored: boolean) => void };
  const nativeFocusPending = useRef<FocusRequest | null>(null);
  const domFocusPending = useRef<FocusRequest | null>(null);
  const [, commitFocus] = useState(0);
  const [hidden, setHidden] = useState(() => hasOutstandingNativeChrome(controlId) ||
    supportsNativeChrome(kind) && badgeAdmitted && props.eligible && !!props.owner && !overlay && !suppressed);
  const [prepared, setPrepared] = useState<NativeChromeLease | null>(null);
  const [measurement, remeasure] = useState(0);
  const rehearsalDiagnostics = useRef(false);
  const [rehearsalStatus, setRehearsalStatus] = useState<string | null>(null);
  // Explicit Debug admission only. This memory-only public geometry probe has
  // no owner/document/context, protected content, response bodies or raw errors.
  const reportRehearsal = useCallback((stage: "skip" | "retire" | "prepare" | "activate" | "update",
    outcome: "pending" | "acknowledged" | "rejected", code = "none") => {
    if (!rehearsalDiagnostics.current || kind !== "agent-surface") return;
    const frame = slot.current?.getBoundingClientRect();
    const dimension = (value: number | undefined) => value !== undefined && Number.isFinite(value)
      ? Math.max(0, Math.min(10000, Math.round(value))) : 0;
    setRehearsalStatus(JSON.stringify({ stage, outcome, code,
      eligible: current.current.props.eligible, supported, allowed: current.current.allowed,
      focusInside: !!slot.current?.contains(document.activeElement), heldFocus: heldFocus.current,
      width: dimension(frame?.width), height: dimension(frame?.height),
      inViewport: !!frame && frame.left >= 0 && frame.top >= 0 && frame.right <= window.innerWidth && frame.bottom <= window.innerHeight }));
  }, [kind, supported]);

  const canAct = useCallback(() => current.current.allowed && !nativeShellOverlayBlocked(current.current.owningLayer) &&
    !moving.current && !slot.current?.closest("[inert]") &&
    !isSessionChromeSuppressed() && !getVoiceSurfaceMetadata()?.interactionLayer?.blocksUnderlyingActions &&
    document.visibilityState !== "hidden", []);
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

  useImperativeHandle(handleRef, () => ({ restoreFocus: async (preferNative = false) => {
    nativeFocusPending.current?.resolve(false); nativeFocusPending.current = null;
    domFocusPending.current?.resolve(false); domFocusPending.current = null;
    const request = current.current;
    const attempt = ++focusAttempt.current;
    const isCurrentAttempt = () => mounted.current && focusAttempt.current === attempt &&
      current.current.epoch === request.epoch && current.current.context === request.context;
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
        if (isCurrentAttempt()) { heldFocus.current = false; focusPending.current = false; }
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
      focusAttempt.current === pending.attempt && pending.binding === active && lease.current === active && canAct();
    try {
      if (await active.restoreFocus(isCurrent) && isCurrent()) {
        nativeFocusPending.current = null; pending.resolve(true); return;
      }
    } catch { /* Unsupported/uncertain focus never replays an action. */ }
    if (!isCurrent()) {
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
      if (!isCurrent()) {
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
  }, [canAct, controlId, restorePendingDomFocus]);
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
    if (!Capacitor.isNativePlatform() || Capacitor.getPlatform() !== "ios") return;
    let cancelled = false;
    let subscriptionsFailed = false;
    const handles: PluginListenerHandle[] = [];
    const retain = async (pending: Promise<PluginListenerHandle>) => {
      const handle = await pending;
      if (cancelled || subscriptionsFailed) await handle.remove(); else handles.push(handle);
    };
    const invalidate = () => { lease.current?.invalidate(); remeasure((count) => count + 1); };
    void (async () => {
      try {
        const capability = await getNativeChromeCapabilities();
        if (cancelled || !capability || capability.contractVersion !== NATIVE_CONTROL_CONTRACT_VERSION ||
            capability.independentControls !== true || !capability.families.includes(kind)) return;
        rehearsalDiagnostics.current = capability.rehearsalDiagnostics === true;
        await Promise.all([retain(nativeChrome.addListener("choiceRequested", (event: ChromeChoice) => {
          const active = lease.current;
          void active?.choose(event, () => lease.current === active && current.current.epoch === active.projection.ownerEpoch &&
            current.current.context === active.context && isCurrentNativeControlAppearance(active.projection, foreground) && canAct(), () => {
            const callback = current.current.props;
            if (callback.kind === "history" || callback.kind === "close") callback.onActivate();
            else if (callback.kind === "agent-surface") { if (event.value === "one" || event.value === "puppy") callback.onValueChange(event.value); }
            else if (callback.kind === "appearance") { if (event.value === "light" || event.value === "dark" || event.value === "system") callback.onValueChange(event.value); }
            else if (callback.kind === "accent") { if (event.value === "blue" || event.value === "gold") callback.onValueChange(event.value); }
            else if (event.value !== undefined) callback.onValueChange(event.value);
          }).catch(() => undefined);
        })), retain(nativeChrome.addListener("invalidated", invalidate)), retain(subscribeNativeSessionPrivacy(invalidate))]);
        if (!cancelled) {
          setInPlaceUpdates(capability.inPlaceUpdates === true);
          setNativeFocusReturn(capability.focusReturn === true && kind !== "agent-surface"); setSupported(true);
        }
      } catch {
        if (cancelled) return;
        subscriptionsFailed = true;
        handles.splice(0).forEach((handle) => { void handle.remove(); });
        try {
          await retireNativeChrome(current.current.epoch, undefined, controlId);
          if (!cancelled) setHidden(false);
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
    window.addEventListener("resize", invalidate);
    const observer = new ResizeObserver(invalidate);
    if (node) observer.observe(node);
    return () => {
      cancelled = true;
      rehearsalDiagnostics.current = false;
      handles.forEach((handle) => { void handle.remove(); });
      observer.disconnect();
      node?.removeEventListener("focusout", onFocusOut);
      document.removeEventListener("visibilitychange", invalidate);
      window.removeEventListener("resize", invalidate);
      setSupported(false);
    };
  }, [kind, controlId, foreground, canAct]);

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
    const transformRunning = () => ancestors.some((ancestor) => ancestor.getAnimations?.().some((animation) =>
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
      if (event.type === "transitionrun") transitions.add(event.currentTarget!);
      else transitions.delete(event.currentTarget!);
      move();
    };
    const animation = (event: AnimationEvent) => {
      if (event.target !== event.currentTarget || !event.currentTarget) return;
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
    move(); // Account for the owning pane/stack's first settlement, not just resize.
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
  }, [preference, context]);

  // Legacy wrappers reinstall; capable wrappers preserve containment and focus.
  const installationPresentation = inPlaceUpdates ? "in-place" : JSON.stringify({ theme, value, expanded });
  useLayoutEffect(() => {
    if (!supported) return;
    let cancelled = false;
    let owned: NativeChromeLease | null = null;
    lease.current?.invalidate();
    void (async () => {
      let stage: "retire" | "prepare" = "retire";
      try {
        reportRehearsal(stage, "pending");
        await retireNativeChrome(epoch, undefined, controlId);
        if (cancelled) return;
        const { theme, expanded, value, props } = current.current;
        setPrepared(null);
        if (!allowed || !theme || !canAct() || heldFocus.current || !slot.current) {
          setHidden(false);
          nativeFocusPending.current?.resolve(false); nativeFocusPending.current = null;
          reportRehearsal("skip", "acknowledged", "not-admitted"); return;
        }
        // Preserve keyboard focus rather than hiding a focused fallback.
        if (slot.current.contains(document.activeElement)) {
          setHidden(false);
          heldFocus.current = true; nativeFocusPending.current?.resolve(false); nativeFocusPending.current = null;
          reportRehearsal("skip", "acknowledged", "focused"); return;
        }
        const frame = slot.current.getBoundingClientRect();
        const minimumWidth = kind === "appearance" ? 132 : kind === "agent-surface" ? 88 : 44;
        const widthAdmitted = kind === "agent-surface" || kind === "appearance" ? frame.width >= minimumWidth && frame.width <= 320 : frame.width === 44;
        let clipped = !!slot.current.closest("[inert]");
        if (preference) {
          for (let parent = slot.current.parentElement; parent; parent = parent.parentElement) {
            const style = getComputedStyle(parent);
            const bounds = parent.getBoundingClientRect();
            if (/(auto|scroll|hidden|clip)/.test(style.overflowY) && (frame.top < bounds.top || frame.bottom > bounds.bottom) ||
                /(auto|scroll|hidden|clip)/.test(style.overflowX) && (frame.left < bounds.left || frame.right > bounds.right)) clipped = true;
          }
        }
        if (frame.height !== 44 || !widthAdmitted || clipped) {
          setHidden(false);
          nativeFocusPending.current?.resolve(false); nativeFocusPending.current = null;
          reportRehearsal("skip", "acknowledged", "geometry"); return;
        }
        if (kind === "agent-surface" && value === undefined) { setHidden(false); return; }
        const control: ChromeControl & { label: string } =
          props.kind === "close" ? { kind: "close", label: props.label } :
          props.kind === "history" ? { kind: "history", expanded, label: "Chat history" } :
          props.kind === "agent-surface" ? { kind: "agent-surface", value: props.value, label: "Agent" } :
          props.kind === "appearance" ? { kind: "appearance", value: props.value, label: "Appearance" } :
          props.kind === "accent" ? { kind: "accent", value: props.value, label: "App accent color" } :
          props.kind === "date" ? { kind: "date", value: props.value, minimum: props.minimum, maximum: props.maximum, label: props.label } :
          props.kind === "selection" ? { kind: "selection", value: props.value, options: props.options, label: props.label } :
          { kind: "more", options: props.options, label: props.label };
        const next = new NativeChromeLease({ ...control,
          enabled: true, ...theme, frame: { x: frame.x, y: frame.y, width: frame.width, height: frame.height },
          viewport: { width: window.innerWidth, height: window.innerHeight } }, epoch, context, inPlaceUpdates);
        owned = next;
        lease.current = next;
        stage = "prepare";
        // Keep the same reserved slot concealed across a native-to-native
        // handoff. Do not paint an intermediate, clickable web replacement.
        setHidden(true);
        reportRehearsal(stage, "pending");
        if (await next.prepare() && !cancelled) { reportRehearsal(stage, "acknowledged"); setHidden(true); setPrepared(next); }
      } catch (error) {
        if (cancelled || (owned && lease.current !== owned)) return;
        reportRehearsal(stage, "rejected", rehearsalFailureCode(error));
        owned?.invalidate();
        try {
          await retireNativeChrome(epoch, owned?.projection, controlId);
          if (!cancelled) {
            setHidden(false);
            restorePendingDomFocus();
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
      owned?.invalidate();
      if (owned && nativeFocusPending.current?.binding === owned) nativeFocusPending.current.binding = null;
      if (owned) void retireNativeChrome(epoch, owned.projection, controlId).catch(() => undefined);
    };
  }, [supported, allowed, epoch, context, controlId, kind, preference, measurement, installationPresentation, inPlaceUpdates, canAct, reportRehearsal, restorePendingDomFocus]);

  useLayoutEffect(() => {
    if (!prepared || !hidden) return;
    reportRehearsal("activate", "pending");
    void prepared.activate().then(() => {
      if (lease.current === prepared) {
        reportRehearsal("activate", "acknowledged");
        if (!inPlaceUpdates) void restoreNativeFocus(prepared);
      }
    }).catch(async (error) => {
      if (lease.current !== prepared) return;
      reportRehearsal("activate", "rejected", rehearsalFailureCode(error));
      prepared.invalidate();
      try {
        await retireNativeChrome(prepared.projection.ownerEpoch, prepared.projection);
        if (lease.current === prepared) { restorePendingDomFocus(); setPrepared(null); setHidden(false); }
      } catch {
        if (lease.current === prepared) { nativeFocusPending.current?.resolve(false); nativeFocusPending.current = null; }
        // Quarantine until confirmed retirement.
      }
    });
  }, [prepared, hidden, reportRehearsal, inPlaceUpdates, restoreNativeFocus, restorePendingDomFocus]);

  useLayoutEffect(() => {
    if (!prepared || !hidden || !inPlaceUpdates || !theme) return;
    reportRehearsal("update", "pending");
    void prepared.update({ ...theme, enabled: true, ...(value === undefined ? {} : { value }), ...(expanded === undefined ? {} : { expanded }) }).then((applied) => {
      if (applied && lease.current === prepared) {
        reportRehearsal("update", "acknowledged"); void restoreNativeFocus(prepared);
      }
    }).catch(async (error) => {
      if (lease.current !== prepared) return;
      reportRehearsal("update", "rejected", rehearsalFailureCode(error));
      prepared.invalidate();
      try {
        await retireNativeChrome(prepared.projection.ownerEpoch, prepared.projection);
        if (lease.current === prepared) { restorePendingDomFocus(); setPrepared(null); setHidden(false); }
      } catch {
        if (lease.current === prepared) { nativeFocusPending.current?.resolve(false); nativeFocusPending.current = null; }
        // Uncertain updates cannot restore a duplicate DOM control.
      }
    });
  }, [prepared, hidden, inPlaceUpdates, theme, value, expanded, reportRehearsal, restoreNativeFocus, restorePendingDomFocus]);

  return <div ref={slot} className={className} style={props.style} data-native-chrome-slot={controlId}>
    <div inert={hidden} aria-hidden={hidden || undefined} style={{ visibility: hidden ? "hidden" : undefined }}>{children}</div>
    {rehearsalStatus && <span id="native-selector-rehearsal-status" className="sr-only" role="status" aria-live="off" data-testid="native-selector-rehearsal-status">NATIVE_SELECTOR_STATUS {rehearsalStatus}</span>}
  </div>;
}

/** Same History control identity, relocated to the modal's authored Close
 * slot. Geometry changes retire the old lease; no underlying-overlay bypass. */
export function NativeHistoryClose({ owner, context, onClose }: { owner: string | null; context: string; onClose: () => void }) {
  const focusRef = useRef<HTMLButtonElement>(null);
  const key = JSON.stringify([owner, context]);
  const [stationaryKey, setStationaryKey] = useState<string | null>(null);
  useEffect(() => {
    const duration = getComputedStyle(document.documentElement).getPropertyValue("--motion-sheet-enter-duration").trim();
    const delay = window.matchMedia("(prefers-reduced-motion: reduce)").matches ? 0 :
      Number.parseFloat(duration) * (duration.endsWith("ms") ? 1 : 1000);
    const timer = window.setTimeout(() => setStationaryKey(key), Number.isFinite(delay) ? delay : 300);
    return () => window.clearTimeout(timer);
  }, [key]);
  return <NativeChatChrome kind="history" expanded pendingAttention={0} owner={owner} context={context}
    eligible={stationaryKey === key} onActivate={onClose} focusRef={focusRef} className="relative flex size-11 shrink-0 items-center justify-center">
    <button ref={focusRef} type="button" aria-label="Close chat history" onClick={onClose}
      className="inline-flex size-11 items-center justify-center rounded-full text-muted-foreground hover:bg-muted">
      <XIcon className="size-4" aria-hidden />
    </button>
  </NativeChatChrome>;
}
