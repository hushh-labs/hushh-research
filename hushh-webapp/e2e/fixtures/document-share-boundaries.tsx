// Only authentication and transport boundaries are synthetic. The production
// review, session epoch, API decoding and decision payloads remain unchanged.
import { useSyncExternalStore } from "react";
import type { AnchorHTMLAttributes } from "react";
import { advanceVaultSessionEpoch } from "../../lib/vault/session-epoch";
import { publishValidatedAuthSessionPrincipal } from "@/lib/auth/session-owner";
publishValidatedAuthSessionPrincipal({ firebaseUid: "synthetic-owner", ownerId: "synthetic-owner", accountGeneration: 0 });
let unlocked = true;
const listeners = new Set<() => void>();
const getToken = () => (unlocked ? "synthetic-vault-owner" : null);
export function setFixtureLocked(locked: boolean) {
  advanceVaultSessionEpoch();
  unlocked = !locked;
  for (const listener of listeners) listener();
}
export function useAuth() {
  return { user: { uid: "synthetic-owner" }, userId: "synthetic-owner" };
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
  // These sharing assertions exercise an explicitly selected Shared owner.
  getPersonalAgentStatus: async () => ({ hostingMode: "shared" }),
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
  // The streamed preparation's web transport; Playwright answers it.
  apiFetchStream: (path: string, options: RequestInit = {}) =>
    // eslint-disable-next-line no-restricted-syntax -- Synthetic browser transport; intercepted by Playwright.
    fetch(path, {
      ...options,
      headers: {
        ...(options.headers as Record<string, string> | undefined),
        Accept: "text/event-stream",
      },
    }),
};

// Popup identity is synthetic here; Firebase's same-user semantics have their
// own unit tests and live consent remains a separate acceptance requirement.
export const AuthService = {
  getIdToken: async () => "synthetic-firebase-proof",
  getCurrentUser: () => ({ uid: "synthetic-owner" }),
  documentRequestIdentityToken: async (
    _uid: string,
    current: () => boolean,
  ) => {
    if (!current()) throw new Error("session_changed");
    return "synthetic-firebase-proof";
  },
};
export const CacheSyncService = { onConsentMutated: (_userId: string) => {} };
// This fixture exercises document sharing, not vault-backed custom MCP setup.
// Keep the connector service's unused configuration branch import-safe here.
export const projectCustomConnectorTurnConfigurations = () => [];

// Credential setup has its own acceptance suite. This fixture only controls
// unlock state and must never initialize live Firebase or enter credential UI.
export function VaultFlow() { throw new Error("Drive review fixture must not enter vault setup"); }
export default function FixtureLink(
  props: AnchorHTMLAttributes<HTMLAnchorElement>,
) {
  return <a {...props} />;
}
