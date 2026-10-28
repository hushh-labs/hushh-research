/** Synthetic authenticated HUSSH identity for Calendar's rendered browser fixture. */
import { useSyncExternalStore } from "react";

type FixtureIdentity = { id: string; email: string };
const listeners = new Set<() => void>();
let identity: FixtureIdentity = { id: "synthetic-calendar-owner", email: "qa-owner@example.com" };
const subscribe = (listener: () => void) => { listeners.add(listener); return () => listeners.delete(listener); };
const snapshot = () => identity;

export function setFixtureIdentity(next: FixtureIdentity) {
  if (identity.id === next.id && identity.email === next.email) return;
  identity = next;
  for (const listener of listeners) listener();
}

export function useAuth() {
  const current = useSyncExternalStore(subscribe, snapshot, snapshot);
  return { userId: current.id, user: { uid: current.id, email: current.email, emailVerified: true }, loading: false, isAuthenticated: true };
}

export function useEffectiveAvatarUrl() {
  const current = useSyncExternalStore(subscribe, snapshot, snapshot);
  return current.id === "synthetic-calendar-owner"
    ? (globalThis as typeof globalThis & { __calendarFixturePhoto?: string }).__calendarFixturePhoto ?? null
    : null;
}
