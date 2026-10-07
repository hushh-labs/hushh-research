"use client";

import { Capacitor, type PluginListenerHandle } from "@capacitor/core";
import { useCallback, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState, type ReactNode, type Ref, type RefObject } from "react";
import { NativeChromeLease, chromeControlId, hasOutstandingNativeChrome, nativeChrome, retireNativeChrome, type ChromeAgentSurface, type ChromeChoice } from "@/lib/capacitor/native-chrome";
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
  children: ReactNode;
  /** The authored fallback button (or selected radio), never an inferred DOM control. */
  focusRef: RefObject<HTMLElement | null>;
  ref?: Ref<NativeChatChromeHandle>;
} & ({ kind: "history"; onActivate: () => void;
  /** Omission or any nonzero count retains the authored notification/badge DOM. Never bridged. */
  pendingAttention?: number } |
  { kind: "agent-surface"; value: ChromeAgentSurface; onValueChange: (value: ChromeAgentSurface) => void });

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
  const overlay = useNativeShellOverlayBlocked();
  const suppressed = useSessionChromeSuppressed();
  const surface = useVoiceSurfaceMetadata();
  const foreground = kind === "history" ? "secondary" : "accent";
  const theme = useNativeControlAppearance(foreground);
  const badgeAdmitted = props.kind !== "history" || props.pendingAttention === 0;
  const allowed = badgeAdmitted && props.eligible && !!props.owner && !!theme && !overlay && !suppressed &&
    surface?.interactionLayer?.blocksUnderlyingActions !== true;
  const identity = useMemo(() => ({ owner: props.owner, controlId, epoch: crypto.randomUUID() }), [props.owner, controlId]);
  const epoch = identity.epoch;
  const value = props.kind === "agent-surface" ? props.value : undefined;
  const context = props.context;
  const current = useRef({ allowed, epoch, context, value, props });
  const lease = useRef<NativeChromeLease | null>(null);
  const heldFocus = useRef(false);
  const focusPending = useRef(false);
  const mounted = useRef(true);
  const [supported, setSupported] = useState(false);
  const [hidden, setHidden] = useState(() => hasOutstandingNativeChrome(controlId));
  const [prepared, setPrepared] = useState<NativeChromeLease | null>(null);
  const [measurement, remeasure] = useState(0);

  const canAct = useCallback(() => current.current.allowed && !nativeShellOverlayBlocked() &&
    !isSessionChromeSuppressed() && !getVoiceSurfaceMetadata()?.interactionLayer?.blocksUnderlyingActions &&
    document.visibilityState !== "hidden", []);
  useLayoutEffect(() => {
    const old = current.current;
    if (old.allowed !== allowed || old.epoch !== epoch || old.context !== context || old.value !== value) lease.current?.invalidate();
    if (old.epoch !== epoch || old.context !== context) { heldFocus.current = false; focusPending.current = false; }
    current.current = { allowed, epoch, context, value, props };
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
            if (callback.kind === "history") callback.onActivate();
            else if (event.value === "one" || event.value === "puppy") callback.onValueChange(event.value);
          }).catch(() => undefined);
        }));
        await retain(nativeChrome.addListener("invalidated", invalidate));
        await retain(subscribeNativeSessionPrivacy(invalidate));
        if (!cancelled) setSupported(true);
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
        if (frame.height !== 44 || (kind === "history" ? frame.width !== 44 : frame.width < 88 || frame.width > 320)) return;
        if (kind === "agent-surface" && value === undefined) return;
        const control = value === undefined ? { kind: "history" as const } : { kind: "agent-surface" as const, value };
        const next = new NativeChromeLease({ ...control, label: kind === "history" ? "Open chat history" : "Agent",
          enabled: true, ...theme, frame: { x: frame.x, y: frame.y, width: frame.width, height: frame.height },
          viewport: { width: window.innerWidth, height: window.innerHeight } }, epoch, context);
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
      void retireNativeChrome(epoch, owned?.projection, controlId).catch(() => undefined);
    };
  }, [supported, allowed, epoch, context, controlId, kind, value, measurement, theme, canAct]);

  useLayoutEffect(() => {
    if (!prepared || !hidden) return;
    void prepared.activate().catch(async () => {
      if (lease.current !== prepared) return;
      prepared.invalidate();
      try { await retireNativeChrome(prepared.projection.ownerEpoch, prepared.projection); if (lease.current === prepared) setHidden(false); }
      catch { /* Quarantine until confirmed retirement. */ }
    });
  }, [prepared, hidden]);

  return <div ref={slot} className={className}>
    <div inert={hidden} aria-hidden={hidden || undefined} style={{ visibility: hidden ? "hidden" : undefined }}>{children}</div>
  </div>;
}
