"use client";

import { createContext, useContext, useLayoutEffect, useMemo, useRef, useSyncExternalStore, type ReactNode } from "react";
import type { DockEvent, DockProjection, DockLayout } from "@/lib/capacitor/native-dock";

export type NativeDockPort = {
  projection: DockProjection;
  onEdit?: (text: string) => void;
  onPaste?: (text: string, start: number, end: number) => void;
  onAction: (event: DockEvent) => void | Promise<void>;
};
type Family = "text" | "voice";
class DockPorts {
  private ports = new Map<Family, { id: symbol; port: NativeDockPort }>();
  private listeners = new Set<() => void>();
  private snapshot = 0;
  owned = false;
  height = 52;
  layout: DockLayout | null = null;
  private layoutListeners = new Set<() => void>();
  subscribeLayout = (listener: () => void) => { this.layoutListeners.add(listener); return () => { this.layoutListeners.delete(listener); }; };
  setLayout(layout: DockLayout | null) {
    this.layout = layout;
    this.layoutListeners.forEach(listener => listener());
    if (layout) this.present(true, layout.frame.height);
  }
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  getSnapshot = () => this.snapshot;
  get(family: Family) { return this.ports.get(family)?.port; }
  publish(family: Family, id: symbol, port: NativeDockPort) {
    const previous = this.ports.get(family);
    this.ports.set(family, { id, port });
    if (previous?.id !== id || JSON.stringify(previous.port.projection) !== JSON.stringify(port.projection)) this.emit();
  }
  release(family: Family, id: symbol) {
    if (this.ports.get(family)?.id !== id) return;
    this.ports.delete(family); this.emit();
  }
  present(owned: boolean, height = this.height) {
    if (!owned && this.layout) this.setLayout(null);
    if (this.owned === owned && this.height === height) return;
    this.owned = owned; this.height = height; this.emit();
  }
  private emit() { this.snapshot++; this.listeners.forEach(listener => listener()); }
}
const Context = createContext<DockPorts | null>(null);
export function NativeDockPortProvider({ children }: { children: ReactNode }) {
  const ports = useMemo(() => new DockPorts(), []);
  return <Context.Provider value={ports}>{children}</Context.Provider>;
}
export function useNativeDockPorts() {
  const ports = useContext(Context);
  useSyncExternalStore(ports?.subscribe ?? (() => () => {}), ports?.getSnapshot ?? (() => 0), () => 0);
  return ports;
}
/** Publishes current feature callbacks, not a second draft or operation store. */
export function useNativeDockPort(family: Family, port: NativeDockPort | null) {
  const ports = useContext(Context);
  const id = useRef(Symbol(family));
  useLayoutEffect(() => {
    if (port) ports?.publish(family, id.current, port);
    else ports?.release(family, id.current);
  });
  useLayoutEffect(() => { const identity = id.current; return () => ports?.release(family, identity); }, [ports, family]);
}
