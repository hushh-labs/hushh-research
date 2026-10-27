"use client";

import { createContext, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { usePathname, useSearchParams } from "next/navigation";
import { useBackLayer } from "../navigation/back-layers";
import { isSessionChromeSuppressed } from "../auth/use-session-chrome-suppression";
import { createNativePresentationIdentity } from "./native-drawer-owner";
import { readNativeControlAppearance } from "./native-control-appearance";
import { nativeDrawers, nativeDrawerAcknowledged, type HushhNativeDrawersPlugin } from "./native-drawers";
import { NativeOwnedChoiceLease, type NativeOwnedChoicePort } from "./native-owned-choice";
import type { SemanticChoiceOption } from "./native-choice-items";

type Binding = {
  options: readonly SemanticChoiceOption[] | null;
  value: string;
  disabled: boolean;
  label?: string;
  context?: string;
  showTitle?: boolean;
  onValueChange: (value: string) => void;
};
export const NativeChoiceTriggerContext = createContext<{
  committed: boolean;
  presented: boolean;
  blocked: boolean;
  bindTrigger: (node: HTMLButtonElement | null) => void;
} | null>(null);

function ownedPort(source: HushhNativeDrawersPlugin): NativeOwnedChoicePort | null {
  const { prepareOwnedChoice, updateOwnedChoice, retireOwnedChoice, getOwnedChoiceState } = source;
  if (!prepareOwnedChoice || !updateOwnedChoice || !retireOwnedChoice || !getOwnedChoiceState) return null;
  return { prepareOwnedChoice, updateOwnedChoice, retireOwnedChoice, getOwnedChoiceState,
    addListener: (event, callback) => source.addListener(event, callback) };
}
function accessibleChoiceLabel(trigger: HTMLButtonElement | null): string {
  if (!trigger) return "Choose an option";
  const named = trigger.getAttribute("aria-label") || trigger.getAttribute("aria-labelledby")?.split(/\s+/)
    .map(id => document.getElementById(id)?.textContent ?? "").join(" ") ||
    Array.from(trigger.labels ?? []).map(label => label.textContent ?? "").join(" ");
  return named?.trim().slice(0, 256) || "Choose an option";
}

/** Shared semantic adapter. Only a user opening requests presentation; changes
 * invalidate that visit instead of replaying it against another feature owner. */
export function useNativeOwnedChoice(binding: Binding, authoredTrigger?: { current: HTMLButtonElement | null }) {
  const pathname = usePathname() ?? "";
  const params = useSearchParams();
  const queryKey = params?.toString() ?? "";
  const visit = `${pathname}\0${queryKey}`;
  const signature = JSON.stringify([binding.options, binding.value, binding.disabled, binding.label, binding.context, binding.showTitle]);
  const localTrigger = useRef<HTMLButtonElement | null>(null);
  const trigger = authoredTrigger ?? localTrigger;
  const [presented, setPresented] = useState(false);
  const [blocked, setBlocked] = useState(false);
  const [fallback, setFallback] = useState(false);
  const live = useRef({ ...binding, signature, visit });
  const mounted = useRef(true);
  const epoch = useRef(0);
  const invalidateGeneration = useCallback(() => { epoch.current++; }, []);
  const pending = useRef(false);
  const lease = useRef<NativeOwnedChoiceLease | null>(null);
  const ineligibleRetirement = useRef<NativeOwnedChoiceLease | null>(null);
  const bound = useRef<{ signature: string; visit: string } | null>(null);
  const observer = useRef<MutationObserver | null>(null);
  const focusFrame = useRef<number | null>(null);

  const settle = useCallback((generation: number, confirmed: boolean, failed = false) => {
    if (!mounted.current || epoch.current !== generation) return;
    pending.current = false; bound.current = null;
    observer.current?.disconnect(); observer.current = null;
    setBlocked(!confirmed);
    if (!confirmed) return; // Keep the old lease for explicit, readback-only recovery.
    lease.current = null; setPresented(false);
    if (failed) setFallback(true);
  }, []);
  const close = useCallback(async () => {
    const generation = epoch.current;
    const current = lease.current;
    if (!current) { settle(generation, true); return; }
    const confirmed = blocked ? await current.retirementIsConfirmed() : await current.retire();
    settle(generation, confirmed);
  }, [blocked, settle]);

  useLayoutEffect(() => {
    live.current = { ...binding, signature, visit };
    if (!binding.options) {
      const generation = epoch.current;
      if (lease.current) {
        const current = lease.current;
        if (ineligibleRetirement.current === current) return;
        ineligibleRetirement.current = current;
        void current.retire().then(async confirmed => {
          // One targeted readback may resolve a lost retirement response. It
          // never reopens a popup or repeats an operation.
          settle(generation, confirmed || await current.retirementIsConfirmed(), true);
        });
      }
      else settle(generation, true, true);
      return;
    }
    const previous = bound.current;
    if (previous && (previous.signature !== signature || previous.visit !== visit || !binding.options || binding.disabled)) {
      void close();
    }
  });
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false; invalidateGeneration();
      observer.current?.disconnect(); observer.current = null;
      if (focusFrame.current !== null) cancelAnimationFrame(focusFrame.current);
      void lease.current?.retire(); lease.current = null;
    };
  }, [invalidateGeneration]);

  const requestOpen = useCallback((next: boolean) => {
    if (!next) { void close(); return; }
    if (blocked) { void close(); return; } // Recovery never replays a selection.
    if (pending.current || live.current.disabled || !live.current.options) return;
    const generation = ++epoch.current;
    const snapshot = live.current;
    const restoreWeb = () => {
      if (!mounted.current || epoch.current !== generation) return;
      pending.current = false; bound.current = null; setPresented(true); setFallback(true);
    };
    if (isSessionChromeSuppressed()) { restoreWeb(); return; }
    const identity = createNativePresentationIdentity();
    const appearance = readNativeControlAppearance("accent");
    if (!identity || !appearance) { restoreWeb(); return; }
    pending.current = true; bound.current = { signature: snapshot.signature, visit: snapshot.visit };
    setPresented(true);
    const isCurrent = () => mounted.current && epoch.current === generation &&
      live.current.signature === snapshot.signature && live.current.visit === snapshot.visit && !live.current.disabled;
    void (async () => {
      try {
        const source = nativeDrawers(), port = ownedPort(source);
        const capabilities = await nativeDrawerAcknowledged(source.getCapabilities());
        if (!isCurrent() || !pending.current) return;
        if (!port || capabilities.ownedChoices !== true) { restoreWeb(); return; }
        const values = new Map<string, string>();
        const options = snapshot.options!.map(option => {
          const handle = crypto.randomUUID(); values.set(handle, option.value);
          return { handle, label: option.label, disabled: option.disabled, selected: option.value === snapshot.value, ...(option.artworkId ? { artworkId: option.artworkId } : {}) };
        });
        const current = new NativeOwnedChoiceLease({ ...identity, visitId: crypto.randomUUID() }, port, isCurrent, event => {
          const value = event.outcome === "selected" ? values.get(event.handle!) : undefined;
          values.clear();
          if (!isCurrent()) return;
          settle(generation, true);
          if (value !== undefined) live.current.onValueChange(value);
          const expectedVisit = snapshot.visit;
          focusFrame.current = requestAnimationFrame(() => {
            focusFrame.current = null;
            if (mounted.current && epoch.current === generation && live.current.visit === expectedVisit && trigger.current?.isConnected) {
              trigger.current.focus({ preventScroll: true });
            }
          });
        }, (confirmed, reason) => { values.clear(); settle(generation, confirmed, reason === "failed"); });
        if (!isCurrent()) return;
        lease.current = current;
        observer.current = new MutationObserver(() => {
          const theme = readNativeControlAppearance("accent");
          if (theme && isCurrent()) current.updateAppearance(theme);
        });
        observer.current.observe(document.documentElement, { attributes: true, attributeFilter: ["class", "data-accent"] });
        await current.present({ ...identity, visitId: current.identity.visitId, ...appearance,
          title: snapshot.label || accessibleChoiceLabel(trigger.current), ...(snapshot.showTitle === undefined ? {} : { showTitle: snapshot.showTitle }), options });
      } catch {
        if (!isCurrent() || !pending.current) return;
        settle(generation, lease.current ? await lease.current.retire() : true, true);
      }
    })();
  }, [blocked, close, settle, trigger]);

  const query: Record<string, string> = {};
  params?.forEach((value, key) => { if (!(key in query)) query[key] = value; });
  useBackLayer(pathname, presented ? 100 : 0, () => {
    if (!pending.current && !lease.current) return false;
    void close(); return true;
  }, query);
  return useMemo(() => ({ presented, blocked, fallback, trigger, requestOpen }),
    [presented, blocked, fallback, trigger, requestOpen]);
}
