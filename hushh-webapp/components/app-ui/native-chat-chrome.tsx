"use client";

import { Capacitor, type PluginListenerHandle } from "@capacitor/core";
import { XIcon } from "@/components/icons";
import { useCallback, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode, type Ref, type RefObject } from "react";
import { NativeChromeLease, chromeControlId, hasOutstandingNativeChrome, nativeChrome, retireNativeChrome, type ChromeAgentSurface, type ChromeChoice, type ChromeOption, type ChromeControl } from "@/lib/capacitor/native-chrome";
import { nativeShellOverlayBlocked, useNativeShellOverlayBlocked } from "@/lib/capacitor/native-navigation";
import { subscribeNativeSessionPrivacy } from "@/lib/capacitor/session-privacy";
import { isCurrentNativeControlAppearance, NATIVE_CONTROL_CONTRACT_VERSION, useNativeControlAppearance } from "@/lib/capacitor/native-control-appearance";
import { isSessionChromeSuppressed, useSessionChromeSuppressed } from "@/lib/auth/use-session-chrome-suppression";
import { getVoiceSurfaceMetadata, useVoiceSurfaceMetadata } from "@/lib/voice/voice-surface-metadata";

export type NativeChatChromeHandle = { restoreFocus: () => Promise<boolean> };
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
  { kind: "more"; label: string; options: readonly ChromeOption[]; onValueChange: (value: string) => void } |
  { kind: "selection"; label: string; value: string; options: readonly ChromeOption[]; onValueChange: (value: string) => void } |
  { kind: "date"; label: string; value: string; minimum: string; maximum: string; onValueChange: (value: string) => void });

/** Opt-in presentation only. The caller retains its DOM control, layout and action
 * owner. History reserves 44x44; the two-option selector reserves 88..320 x 44.
 * New native families require --hushh-native-chat-chrome on a Debug iPhone.
 * Use restoreFocus after drawer dismissal: confirmed retirement restores DOM
 * focus and keeps that fallback active until focus leaves the authored slot. */
export function NativeChatChrome(props: Props) {
  const { ref: handleRef, className, children } = props;
  const slot = useRef<HTMLDivElement>(null);
  const kind = props.kind;
  const controlId = chromeControlId(kind);
  // Only the current authored History layer may own Close. Anonymous/nested
  // overlays and the active drag still block it; Close is not globally exempt.
  const owningLayer = props.kind === "close" ? "profile-pane" : props.kind === "history" && props.expanded ? "chat-history" : undefined;
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
  const current = useRef({ allowed, epoch, context, value, props, owningLayer });
  const lease = useRef<NativeChromeLease | null>(null);
  const heldFocus = useRef(false);
  const focusPending = useRef(false);
  const mounted = useRef(true);
  const [supported, setSupported] = useState(false);
  const [inPlaceUpdates, setInPlaceUpdates] = useState(false);
  const [hidden, setHidden] = useState(() => hasOutstandingNativeChrome(controlId));
  const [prepared, setPrepared] = useState<NativeChromeLease | null>(null);
  const [measurement, remeasure] = useState(0);

  const canAct = useCallback(() => current.current.allowed && !nativeShellOverlayBlocked(current.current.owningLayer) &&
    !isSessionChromeSuppressed() && !getVoiceSurfaceMetadata()?.interactionLayer?.blocksUnderlyingActions &&
    document.visibilityState !== "hidden", []);
  useLayoutEffect(() => {
    const old = current.current;
    if (old.allowed !== allowed || old.epoch !== epoch || old.context !== context || (!inPlaceUpdates && old.value !== value)) lease.current?.invalidate();
    if (old.epoch !== epoch || old.context !== context) { heldFocus.current = false; focusPending.current = false; }
    current.current = { allowed, epoch, context, value, props, owningLayer };
  });

  useImperativeHandle(handleRef, () => ({ restoreFocus: async () => {
    const request = current.current;
    heldFocus.current = true;
    lease.current?.invalidate();
    remeasure((count) => count + 1);
    try {
      if (supported || hasOutstandingNativeChrome(controlId)) {
        await retireNativeChrome(request.epoch, lease.current?.projection, controlId);
      }
      if (!mounted.current || current.current.epoch !== request.epoch || current.current.context !== request.context || !canAct()) {
        if (current.current.epoch === request.epoch && current.current.context === request.context) heldFocus.current = false;
        return false;
      }
      focusPending.current = true;
      setPrepared(null);
      setHidden(false);
      remeasure((count) => count + 1);
      return true; // Focus is applied after React commits removal of inert/hidden.
    } catch { return false; } // Never focus a duplicate control after uncertain removal.
  } }));
  useLayoutEffect(() => {
    if (!hidden && focusPending.current && canAct()) {
      focusPending.current = false;
      props.focusRef.current?.focus({ preventScroll: true });
    }
  });

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  useEffect(() => {
    if (!Capacitor.isNativePlatform() || Capacitor.getPlatform() !== "ios") return;
    let cancelled = false;
    const handles: PluginListenerHandle[] = [];
    const retain = async (pending: Promise<PluginListenerHandle>) => {
      const handle = await pending;
      if (cancelled) await handle.remove(); else handles.push(handle);
    };
    const invalidate = () => { lease.current?.invalidate(); remeasure((count) => count + 1); };
    void (async () => {
      try {
        const capability = await nativeChrome.getCapabilities();
        if (cancelled || capability.contractVersion !== NATIVE_CONTROL_CONTRACT_VERSION ||
            capability.independentControls !== true || !capability.families.includes(kind)) return;
        await retain(nativeChrome.addListener("choiceRequested", (event: ChromeChoice) => {
          const active = lease.current;
          void active?.choose(event, () => lease.current === active && current.current.epoch === active.projection.ownerEpoch &&
            current.current.context === active.context && isCurrentNativeControlAppearance(active.projection, foreground) && canAct(), () => {
            const callback = current.current.props;
            if (callback.kind === "history" || callback.kind === "close") callback.onActivate();
            else if (callback.kind === "agent-surface") { if (event.value === "one" || event.value === "puppy") callback.onValueChange(event.value); }
            else if (event.value !== undefined) callback.onValueChange(event.value);
          }).catch(() => undefined);
        }));
        await retain(nativeChrome.addListener("invalidated", invalidate));
        await retain(subscribeNativeSessionPrivacy(invalidate));
        if (!cancelled) { setInPlaceUpdates(capability.inPlaceUpdates === true); setSupported(true); }
      } catch { /* Unsupported wrappers keep the authored DOM control. */ }
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
      handles.forEach((handle) => { void handle.remove(); });
      observer.disconnect();
      node?.removeEventListener("focusout", onFocusOut);
      document.removeEventListener("visibilitychange", invalidate);
      window.removeEventListener("resize", invalidate);
      setSupported(false);
    };
  }, [kind, foreground, canAct]);

  // Legacy wrappers reinstall; capable wrappers preserve containment and focus.
  const installationPresentation = inPlaceUpdates ? "in-place" : JSON.stringify({ theme, value, expanded });
  useLayoutEffect(() => {
    if (!supported) return;
    let cancelled = false;
    let owned: NativeChromeLease | null = null;
    lease.current?.invalidate();
    void (async () => {
      try {
        await retireNativeChrome(epoch, undefined, controlId);
        if (cancelled) return;
        setPrepared(null);
        setHidden(false);
        if (!allowed || !theme || !canAct() || heldFocus.current || !slot.current) return;
        // Preserve keyboard focus rather than hiding a focused fallback.
        if (slot.current.contains(document.activeElement)) { heldFocus.current = true; return; }
        const frame = slot.current.getBoundingClientRect();
        if (frame.height !== 44 || (kind === "agent-surface" ? frame.width < 88 || frame.width > 320 : frame.width !== 44)) return;
        if (kind === "agent-surface" && value === undefined) return;
        const control: ChromeControl & { label: string } =
          props.kind === "close" ? { kind: "close", label: props.label } :
          props.kind === "history" ? { kind: "history", expanded, label: "Chat history" } :
          props.kind === "agent-surface" ? { kind: "agent-surface", value: props.value, label: "Agent" } :
          props.kind === "date" ? { kind: "date", value: props.value, minimum: props.minimum, maximum: props.maximum, label: props.label } :
          props.kind === "selection" ? { kind: "selection", value: props.value, options: props.options, label: props.label } :
          { kind: "more", options: props.options, label: props.label };
        const next = new NativeChromeLease({ ...control,
          enabled: true, ...theme, frame: { x: frame.x, y: frame.y, width: frame.width, height: frame.height },
          viewport: { width: window.innerWidth, height: window.innerHeight } }, epoch, context, inPlaceUpdates);
        owned = next;
        lease.current = next;
        if (await next.prepare() && !cancelled) { setHidden(true); setPrepared(next); }
      } catch {
        if (cancelled || (owned && lease.current !== owned)) return;
        owned?.invalidate();
        try { await retireNativeChrome(epoch, owned?.projection, controlId); if (!cancelled) setHidden(false); }
        catch { if (!cancelled) setHidden(true); }
      }
    })();
    return () => {
      cancelled = true;
      owned?.invalidate();
      if (owned) void retireNativeChrome(epoch, owned.projection, controlId).catch(() => undefined);
    };
  }, [supported, allowed, epoch, context, controlId, kind, measurement, installationPresentation, inPlaceUpdates, canAct]);

  useLayoutEffect(() => {
    if (!prepared || !hidden) return;
    void prepared.activate().catch(async () => {
      if (lease.current !== prepared) return;
      prepared.invalidate();
      try { await retireNativeChrome(prepared.projection.ownerEpoch, prepared.projection); if (lease.current === prepared) setHidden(false); }
      catch { /* Quarantine until confirmed retirement. */ }
    });
  }, [prepared, hidden]);

  useLayoutEffect(() => {
    if (!prepared || !hidden || !inPlaceUpdates || !theme) return;
    void prepared.update({ ...theme, enabled: true, ...(value === undefined ? {} : { value }), ...(expanded === undefined ? {} : { expanded }) }).catch(async () => {
      if (lease.current !== prepared) return;
      prepared.invalidate();
      try { await retireNativeChrome(prepared.projection.ownerEpoch, prepared.projection); if (lease.current === prepared) setHidden(false); }
      catch { /* Uncertain updates cannot restore a duplicate DOM control. */ }
    });
  }, [prepared, hidden, inPlaceUpdates, theme, value, expanded]);

  return <div ref={slot} className={className} style={props.style} data-native-chrome-slot={controlId}>
    <div inert={hidden} aria-hidden={hidden || undefined} style={{ visibility: hidden ? "hidden" : undefined }}>{children}</div>
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
