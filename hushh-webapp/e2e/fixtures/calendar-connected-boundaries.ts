/** Browser QA boundaries only. The production workspace and typed transport remain real. */
import { useSyncExternalStore } from "react";
import { advanceVaultSessionEpoch } from "../../lib/vault/session-epoch";

const listeners = new Set<() => void>();
let vaultSnapshot = {
  vaultOwnerToken: new URLSearchParams(globalThis.location.search).get("locked") === "1" ? null : "synthetic-calendar-owner-token",
  ownerTokenStatus: new URLSearchParams(globalThis.location.search).get("locked") === "1" ? "locked" : "valid",
};
export function authorizeSyntheticVault() {
  advanceVaultSessionEpoch();
  vaultSnapshot = { vaultOwnerToken: "synthetic-calendar-owner-token", ownerTokenStatus: "valid" };
  for (const listener of listeners) listener();
}
export function lockSyntheticVault() {
  advanceVaultSessionEpoch();
  vaultSnapshot = { vaultOwnerToken: null, ownerTokenStatus: "locked" };
  for (const listener of listeners) listener();
}
export function useVault() {
  const snapshot = useSyncExternalStore(listener => { listeners.add(listener); return () => listeners.delete(listener); }, () => vaultSnapshot);
  return { ...snapshot, isVaultUnlocked: Boolean(snapshot.vaultOwnerToken), retryOwnerTokenRenewal: async () => authorizeSyntheticVault() };
}
export function useRouter() {
  return { push: () => {}, replace: () => {}, prefetch: () => {} };
}
export function usePathname() { return "/one/calendar"; }
export function useSearchParams() { return new URLSearchParams(); }
export class ApiService {
  static apiFetch(path: string, init?: RequestInit) { return globalThis.fetch(path, init); }
  static async getPersonalAgentStatus() { return { hostingMode: "shared" }; }
}

/** Identity is synthetic; the fixture never initializes or signs in to Firebase. */
export class AuthService {
  static getCurrentUser() { return { uid: "synthetic-calendar-owner" }; }
}
