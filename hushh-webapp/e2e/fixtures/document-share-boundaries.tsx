// Only authentication and transport boundaries are synthetic. The production
// review, session epoch, API decoding and decision payloads remain unchanged.
import { useSyncExternalStore } from "react";
import type { AnchorHTMLAttributes } from "react";
import { advanceVaultSessionEpoch } from "../../lib/vault/session-epoch";
let unlocked = true;
const listeners = new Set<() => void>();
const getToken = () => (unlocked ? "synthetic-vault-owner" : null);
export function setFixtureLocked(locked: boolean) {
  advanceVaultSessionEpoch();
  unlocked = !locked;
  for (const listener of listeners) listener();
}
export function useAuth() {
  return { user: { uid: "synthetic-owner" } };
}
export function useVault() {
  const isVaultUnlocked = useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    () => unlocked,
  );
  return { isVaultUnlocked, getVaultOwnerToken: getToken };
}
export const ApiService = {
  getAuthHeaders: (token: string) => ({ Authorization: `Bearer ${token}` }),
  apiFetch: (
    path: string,
    {
      isEffectCurrent,
      ...options
    }: RequestInit & { isEffectCurrent?: () => boolean },
  ) => {
    if (isEffectCurrent && !isEffectCurrent())
      throw new Error("session_changed");
    // eslint-disable-next-line no-restricted-syntax -- Synthetic browser transport; intercepted by Playwright.
    return fetch(path, options);
  },
};

// Popup identity is synthetic here; Firebase's same-user semantics have their
// own unit tests and live consent remains a separate acceptance requirement.
export const AuthService = {
  reauthenticateGoogleIdentity: async (
    _uid: string,
    current: () => boolean,
  ) => {
    if (!current()) throw new Error("session_changed");
    return "synthetic-firebase-proof";
  },
};
export const CacheSyncService = { onConsentMutated: (_userId: string) => {} };
export default function FixtureLink(
  props: AnchorHTMLAttributes<HTMLAnchorElement>,
) {
  return <a {...props} />;
}
