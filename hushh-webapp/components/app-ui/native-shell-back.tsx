"use client";

import { Capacitor, type PluginListenerHandle } from "@capacitor/core";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { ArrowLeftIcon } from "@/components/icons";
import { ShellActionSurface } from "@/components/app-ui/shell-action-surface";
import { NativeChromeLease, hasOutstandingNativeChrome, nativeChrome, retireNativeChrome } from "@/lib/capacitor/native-chrome";
import { nativeShellOverlayBlocked, useNativeShellOverlayBlocked } from "@/lib/capacitor/native-navigation";
import { subscribeNativeSessionPrivacy } from "@/lib/capacitor/session-privacy";
import { useVoiceSurfaceMetadata, getVoiceSurfaceMetadata } from "@/lib/voice/voice-surface-metadata";
import { isSessionChromeSuppressed, useSessionChromeSuppressed } from "@/lib/auth/use-session-chrome-suppression";

/** Opt-in stationary shell Back. The existing callback retains all routing and
 * action authority; changing the route or owner expires the native lease. */
export function NativeShellBack({ label, onBack, owner, context, eligible }: {
  label: string; onBack: () => void; owner: string | null; context: string; eligible: boolean;
}) {
  const slot = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const callback = useRef(onBack);
  const overlay = useNativeShellOverlayBlocked();
  const suppressed = useSessionChromeSuppressed();
  const surface = useVoiceSurfaceMetadata();
  const layerBlocked = surface?.interactionLayer?.blocksUnderlyingActions === true;
  const [supported, setSupported] = useState(false);
  const [hidden, setHidden] = useState(hasOutstandingNativeChrome);
  const [prepared, setPrepared] = useState<NativeChromeLease | null>(null);
  const [measurement, remeasure] = useState(0);
  const lease = useRef<NativeChromeLease | null>(null);
  const ownerIdentity = useMemo(() => ({ owner, epoch: crypto.randomUUID() }), [owner]);
  const epoch = ownerIdentity.epoch;
  const allowed = eligible && !!owner && !overlay && !layerBlocked && !suppressed;
  const current = useRef({ allowed, context, epoch });
  useLayoutEffect(() => {
    if (current.current.allowed !== allowed || current.current.context !== context || current.current.epoch !== epoch) {
      lease.current?.invalidate();
    }
    callback.current = onBack;
    current.current = { allowed, context, epoch };
  }, [allowed, context, epoch, onBack]);

  useEffect(() => {
    if (!Capacitor.isNativePlatform() || Capacitor.getPlatform() !== "ios") return;
    let cancelled = false;
    const handles: PluginListenerHandle[] = [];
    const retain = async (promise: Promise<PluginListenerHandle>) => {
      const handle = await promise;
      if (cancelled) await handle.remove(); else handles.push(handle);
    };
    const invalidate = () => { lease.current?.invalidate(); remeasure((value) => value + 1); };
    void (async () => {
      try {
        const capability = await nativeChrome.getCapabilities();
        if (cancelled || capability.contractVersion !== 1 || !capability.families.includes("back")) return;
        await retain(nativeChrome.addListener("choiceRequested", (event) => {
          const active = lease.current;
          void active?.choose(event, () => lease.current === active && current.current.context === active.context &&
            current.current.allowed && current.current.epoch === active.projection.ownerEpoch &&
            !nativeShellOverlayBlocked() && !isSessionChromeSuppressed() && !getVoiceSurfaceMetadata()?.interactionLayer?.blocksUnderlyingActions &&
            document.visibilityState !== "hidden", () => callback.current()).catch(() => undefined);
        }));
        await retain(nativeChrome.addListener("invalidated", invalidate));
        await retain(subscribeNativeSessionPrivacy(invalidate));
        if (!cancelled) setSupported(true);
      } catch { /* Old wrappers retain the DOM control. No provider errors are logged. */ }
    })();
    document.addEventListener("visibilitychange", invalidate);
    window.addEventListener("resize", invalidate);
    const observer = new ResizeObserver(invalidate);
    if (slot.current) observer.observe(slot.current);
    return () => {
      cancelled = true;
      handles.forEach((handle) => { void handle.remove(); });
      observer.disconnect();
      window.removeEventListener("resize", invalidate);
      document.removeEventListener("visibilitychange", invalidate);
    };
  }, []);

  useLayoutEffect(() => {
    if (!supported) return;
    let cancelled = false;
    let owned: NativeChromeLease | null = null;
    const activeEpoch = epoch;
    const wasFocused = document.activeElement === button.current;
    lease.current?.invalidate();
    void (async () => {
      try {
        // Also retire an uncertain lease from a previous mount before exposing DOM.
        await retireNativeChrome(activeEpoch);
        if (cancelled) return;
        setPrepared(null);
        setHidden(false);
        if (!allowed || document.visibilityState === "hidden" || !slot.current) {
          if (wasFocused) button.current?.focus({ preventScroll: true });
          return;
        }
        const frame = slot.current.getBoundingClientRect();
        if (frame.width !== 44 || frame.height !== 44) return;
        const next = new NativeChromeLease({ kind: "back", label, enabled: true,
          frame: { x: frame.x, y: frame.y, width: frame.width, height: frame.height },
          viewport: { width: window.innerWidth, height: window.innerHeight } }, activeEpoch, context);
        owned = next;
        lease.current = next;
        if (await next.prepare() && !cancelled) { setHidden(true); setPrepared(next); }
      } catch {
        if (cancelled || (owned && lease.current !== owned)) return;
        owned?.invalidate();
        // Uncertainty is recoverable only by a confirmed removal, never a replay.
        try { await retireNativeChrome(activeEpoch, owned?.projection); if (!cancelled) setHidden(false); }
        catch { if (!cancelled) setHidden(true); console.warn("NATIVE_CHROME_RETIRE_UNCONFIRMED"); }
      }
    })();
    return () => {
      cancelled = true;
      owned?.invalidate();
      void retireNativeChrome(activeEpoch, owned?.projection).catch(() => console.warn("NATIVE_CHROME_RETIRE_UNCONFIRMED"));
    };
  }, [supported, allowed, epoch, context, label, measurement]);

  // Layout effect runs after the DOM button is hidden/inert, not before React commits it.
  useLayoutEffect(() => {
    if (!prepared || !hidden) return;
    void prepared.activate().catch(async () => {
      if (lease.current !== prepared) return;
      prepared.invalidate();
      try { await retireNativeChrome(prepared.projection.ownerEpoch, prepared.projection); if (lease.current === prepared) setHidden(false); }
      catch { console.warn("NATIVE_CHROME_RETIRE_UNCONFIRMED"); }
    });
  }, [prepared, hidden]);

  return <div ref={slot} className="pointer-events-auto -ml-3.5 flex h-11 w-11 items-center justify-center">
    <ShellActionSurface ref={button} variant="icon" aria-label={label} onClick={onBack}
      disabled={hidden} aria-hidden={hidden || undefined} tabIndex={hidden ? -1 : undefined}
      style={{ visibility: hidden ? "hidden" : undefined }}
      className="!border-transparent !bg-transparent !text-[color:var(--app-accent-deep)] !shadow-none hover:!bg-transparent active:!scale-100">
      <ArrowLeftIcon className="h-5 w-5" />
    </ShellActionSurface>
  </div>;
}
