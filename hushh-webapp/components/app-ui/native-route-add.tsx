"use client";

import { useLayoutEffect, useRef, useSyncExternalStore, type ReactNode } from "react";
import { usePathname } from "next/navigation";
import { normalizeBottomNavPathname } from "@/lib/navigation/app-bottom-nav";
import { NativeAddAction } from "./native-add-action";
import { nativeWalletCardFormsEnabled } from "@/lib/capacitor/native-wallet-card";

type Registration = { token: symbol; pathname: string; owner: string; context: string; enabled: boolean; onActivate: () => void };
let current: Registration | null = null;
const listeners = new Set<() => void>();
const notify = () => listeners.forEach(listener => listener());
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };

/** Explicit feature-to-shell port; no DOM inspection or second action owner. */
export function NativeRouteAdd({ route, owner, context, enabled, onActivate, children }: {
  route: string; owner: string | null; context: string; enabled: boolean; onActivate: () => void; children: ReactNode;
}) {
  const pathname = normalizeBottomNavPathname(usePathname()), token = useRef(Symbol("route-add"));
  useLayoutEffect(() => {
    if (!owner || pathname !== route || !nativeWalletCardFormsEnabled()) return;
    const registration = { token: token.current, pathname: route, owner, context, enabled, onActivate };
    current = registration; notify();
    return () => { if (current?.token === registration.token) { current = null; notify(); } };
  }, [pathname, route, owner, context, enabled, onActivate]);
  return <span className="contents" data-native-route-add-fallback>{children}</span>;
}
export function NativeRouteAddSeat() {
  const pathname = normalizeBottomNavPathname(usePathname());
  const registration = useSyncExternalStore(subscribe, () => current, () => null);
  if (!registration || registration.pathname !== pathname || !nativeWalletCardFormsEnabled()) return null;
  return <NativeAddAction owner={registration.owner} context={registration.context} label="Add a card"
    enabled={registration.enabled} onActivate={() => {
      if (current === registration && normalizeBottomNavPathname(window.location.pathname) === registration.pathname && registration.enabled) registration.onActivate();
    }} />;
}
