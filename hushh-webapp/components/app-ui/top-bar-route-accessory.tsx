"use client";

import { useSyncExternalStore, type ReactNode } from "react";
import { createPortal } from "react-dom";

// The shared shell owns the host; routes retain ownership of their controls.
let host: HTMLDivElement | null = null;
const listeners = new Set<() => void>();
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
};
const snapshot = () => host;
const serverSnapshot = () => null;
const registerHost = (element: HTMLDivElement | null) => {
  host = element;
  listeners.forEach((listener) => listener());
};

export function TopBarRouteAccessoryHost() {
  return <div ref={registerHost} data-slot="top-bar-route-accessory" className="empty:hidden" />;
}

export function TopBarRouteAccessory({ children }: { children: ReactNode }) {
  const target = useSyncExternalStore(subscribe, snapshot, serverSnapshot);
  return target ? createPortal(children, target) : children;
}
