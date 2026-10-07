"use client";

import { Capacitor, type PluginListenerHandle } from "@capacitor/core";
import { useLayoutEffect, useMemo, useRef, useState } from "react";
import { ArrowLeftIcon } from "@/components/icons";
import { ShellActionSurface } from "@/components/app-ui/shell-action-surface";
import { NativeChromeLease, getNativeChromeCapabilities, hasOutstandingNativeChrome, supportsNativeChrome, nativeChrome, retireNativeChrome, retireOwnedNativeChrome, measureNativeChromeGeometry } from "@/lib/capacitor/native-chrome";
import { nativeShellOverlayBlocked, useNativeShellOverlayBlocked } from "@/lib/capacitor/native-navigation";
import { subscribeNativeSessionPrivacy } from "@/lib/capacitor/session-privacy";
import { useVoiceSurfaceMetadata, getVoiceSurfaceMetadata } from "@/lib/voice/voice-surface-metadata";
import { isSessionChromeSuppressed, useSessionChromeSuppressed } from "@/lib/auth/use-session-chrome-suppression";
import { isCurrentNativeControlAppearance, NATIVE_CONTROL_CONTRACT_VERSION, useNativeControlAppearance } from "@/lib/capacitor/native-control-appearance";

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
  const theme = useNativeControlAppearance();
  const layerBlocked = surface?.interactionLayer?.blocksUnderlyingActions === true;
  const [supported, setSupported] = useState(false);
  const [inPlaceUpdates, setInPlaceUpdates] = useState(false);
  const [backReplacement, setBackReplacement] = useState(false);
  const [hidden, setHidden] = useState(() => hasOutstandingNativeChrome() || supportsNativeChrome("back") && eligible && !!owner && !overlay && !suppressed && !layerBlocked);
  const [prepared, setPrepared] = useState<NativeChromeLease | null>(null);
  const [measurement, remeasure] = useState(0);
  const lease = useRef<NativeChromeLease | null>(null);
  const replacementCandidate = useRef<NativeChromeLease | null>(null);
  const ownerIdentity = useMemo(() => ({ owner, epoch: crypto.randomUUID() }), [owner]);
  const epoch = ownerIdentity.epoch;
  const allowed = eligible && !!owner && !!theme && !overlay && !layerBlocked && !suppressed;
  const current = useRef({ allowed, context, epoch, theme });
  useLayoutEffect(() => {
    if (current.current.allowed !== allowed || current.current.context !== context || current.current.epoch !== epoch || (!inPlaceUpdates && current.current.theme !== theme)) {
      lease.current?.invalidate();
    }
    callback.current = onBack;
    current.current = { allowed, context, epoch, theme };
  }, [allowed, context, epoch, onBack, theme, inPlaceUpdates]);

  useLayoutEffect(() => {
    if (!Capacitor.isNativePlatform() || Capacitor.getPlatform() !== "ios") return;
    let cancelled = false;
    let subscriptionsFailed = false;
    const handles: PluginListenerHandle[] = [];
    const retain = async (promise: Promise<PluginListenerHandle>) => {
      const handle = await promise;
      if (cancelled || subscriptionsFailed) await handle.remove(); else handles.push(handle);
    };
    const invalidate = () => { lease.current?.invalidate(); remeasure((value) => value + 1); };
    const reconcileGeometry = () => {
      const geometry = slot.current && measureNativeChromeGeometry(slot.current, "back");
      if (geometry && current.current.allowed && document.visibilityState !== "hidden" &&
          !nativeShellOverlayBlocked() && !isSessionChromeSuppressed() &&
          !getVoiceSurfaceMetadata()?.interactionLayer?.blocksUnderlyingActions && lease.current?.matchesGeometry(geometry)) return;
      invalidate();
    };
    void (async () => {
      try {
        const capability = await getNativeChromeCapabilities();
        if (cancelled || !capability || capability.contractVersion !== NATIVE_CONTROL_CONTRACT_VERSION ||
            capability.independentControls !== true || !capability.families.includes("back")) return;
        await Promise.all([retain(nativeChrome.addListener("choiceRequested", (event) => {
          const active = lease.current;
          void active?.choose(event, () => lease.current === active && current.current.context === active.context &&
            current.current.allowed && current.current.epoch === active.projection.ownerEpoch &&
            isCurrentNativeControlAppearance(active.projection) &&
            !nativeShellOverlayBlocked() && !isSessionChromeSuppressed() && !getVoiceSurfaceMetadata()?.interactionLayer?.blocksUnderlyingActions &&
            document.visibilityState !== "hidden", () => callback.current()).catch(() => undefined);
        })), retain(nativeChrome.addListener("invalidated", invalidate)), retain(subscribeNativeSessionPrivacy(invalidate))]);
        if (!cancelled) {
          setInPlaceUpdates(capability.inPlaceUpdates === true);
          setBackReplacement(capability.backReplacement === true);
          setSupported(true);
        }
      } catch {
        if (cancelled) return;
        subscriptionsFailed = true;
        handles.splice(0).forEach((handle) => { void handle.remove(); });
        // Capability support does not prove listener installation. A concealed
        // slot recovers only after any outstanding native view is retired.
        try { await retireNativeChrome(current.current.epoch); if (!cancelled) setHidden(false); }
        catch { /* Retain quarantine; no provider error body is logged. */ }
      }
    })();
    document.addEventListener("visibilitychange", invalidate);
    window.addEventListener("resize", reconcileGeometry);
    const observer = new ResizeObserver(reconcileGeometry);
    if (slot.current) observer.observe(slot.current);
    return () => {
      cancelled = true;
      handles.forEach((handle) => { void handle.remove(); });
      observer.disconnect();
      window.removeEventListener("resize", reconcileGeometry);
      document.removeEventListener("visibilitychange", invalidate);
    };
  }, []);

  const installationAppearance = inPlaceUpdates ? "in-place" : JSON.stringify(theme);
  useLayoutEffect(() => {
    if (!supported) return;
    let cancelled = false;
    let owned: NativeChromeLease | null = null;
    let inactive = false;
    const activeEpoch = epoch;
    const wasFocused = document.activeElement === button.current;
    const previous = replacementCandidate.current;
    replacementCandidate.current = null;
    const retiring = lease.current;
    lease.current?.invalidate();
    void (async () => {
      try {
        const { theme } = current.current;
        const geometry = allowed && theme && document.visibilityState !== "hidden" && slot.current
          ? measureNativeChromeGeometry(slot.current, "back") : null;
        const projection = geometry && theme ? { kind: "back" as const, label, enabled: true, ...theme, ...geometry } : null;
        inactive = !projection;
        const replacing = backReplacement && previous && projection && previous.canReplaceBackWith(projection, activeEpoch, context);
        if (!replacing) {
          // Uncertainty, owner, overlay or actual geometry changes require
          // removal. Cached capability never authorizes keeping a stale view.
          // Inactive cleanup cannot take authority from a newer mounted slot.
          if (projection) await retireNativeChrome(activeEpoch);
          else if (retiring) await retireOwnedNativeChrome(retiring.projection);
          if (cancelled) return;
        }
        setPrepared(null);
        if (!projection) {
          const occupied = hasOutstandingNativeChrome();
          setHidden(occupied);
          if (!occupied && wasFocused) button.current?.focus({ preventScroll: true });
          return;
        }
        const next = new NativeChromeLease(projection, activeEpoch, context, inPlaceUpdates);
        owned = next; lease.current = next; setHidden(true);
        const ready = replacing ? await next.prepareBackReplacement(previous) : await next.prepare();
        if (ready && !cancelled) { setHidden(true); setPrepared(next); }
      } catch {
        if (cancelled || (owned && lease.current !== owned)) return;
        owned?.invalidate();
        // Uncertainty is recoverable only by a confirmed removal, never a replay.
        // Active refusal/timeout retains strict recovery. An inactive
        // predecessor still owns only its own uncertain installation.
        try {
          if (inactive) { if (retiring) await retireOwnedNativeChrome(retiring.projection); }
          else await retireNativeChrome(activeEpoch);
          if (!cancelled) setHidden(hasOutstandingNativeChrome());
        }
        catch { if (!cancelled) setHidden(true); console.warn("NATIVE_CHROME_RETIRE_UNCONFIRMED"); }
      }
    })();
    return () => {
      cancelled = true;
      replacementCandidate.current = owned?.replacementReady ? owned : null;
      owned?.invalidate();
      // The next committed layout either explicitly replaces this presentation
      // or hard-retires it. Actual unmount has its own strict removal below.
    };
  }, [supported, allowed, epoch, context, label, measurement, installationAppearance, inPlaceUpdates, backReplacement]);

  useLayoutEffect(() => () => {
    replacementCandidate.current = null;
    const active = lease.current;
    active?.invalidate();
    // Pending replacement may still own its predecessor natively. The removal
    // revision is reserved synchronously; a later mount has a newer fence.
    if (active) void retireOwnedNativeChrome(active.projection)
      .catch(() => console.warn("NATIVE_CHROME_RETIRE_UNCONFIRMED"));
  }, []);

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

  useLayoutEffect(() => {
    if (!prepared || !hidden || !inPlaceUpdates || !theme) return;
    void prepared.update({ ...theme, enabled: true }).catch(async () => {
      if (lease.current !== prepared) return;
      prepared.invalidate();
      try { await retireNativeChrome(prepared.projection.ownerEpoch, prepared.projection); if (lease.current === prepared) setHidden(false); }
      catch { console.warn("NATIVE_CHROME_RETIRE_UNCONFIRMED"); }
    });
  }, [prepared, hidden, inPlaceUpdates, theme]);

  return <div ref={slot} className="pointer-events-auto -ml-3.5 flex h-11 w-11 items-center justify-center">
    <ShellActionSurface ref={button} variant="icon" aria-label={label} onClick={onBack}
      disabled={hidden} aria-hidden={hidden || undefined} tabIndex={hidden ? -1 : undefined}
      style={{ visibility: hidden ? "hidden" : undefined }}
      className="!border-transparent !bg-transparent !text-[color:var(--app-accent-deep)] !shadow-none hover:!bg-transparent active:!scale-100">
      <ArrowLeftIcon className="h-5 w-5" />
    </ShellActionSurface>
  </div>;
}
