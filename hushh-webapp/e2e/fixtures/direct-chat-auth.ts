import { useSyncExternalStore } from "react";
let uid = "fixture-owner";
const listeners = new Set<() => void>();
const user = () => ({ uid, getIdToken: async () => "synthetic-token" });
let snapshot = { user: user(), loading: false, isAuthenticated: true };
export function changeOwner(next: string) { uid = next; snapshot = { user: user(), loading: false, isAuthenticated: true }; for (const listener of listeners) listener(); }
export function useAuth() { return useSyncExternalStore((listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; }, () => snapshot); }

export const auth = { get currentUser() { return snapshot.user; } };
