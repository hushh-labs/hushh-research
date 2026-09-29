// Only authentication, vault and transport boundaries are synthetic. The
// production card, progress parser, timeline, ask card and service decoding
// remain unchanged; Playwright answers the network.
import { createContext, type AnchorHTMLAttributes, type ReactNode } from "react";

const user = { uid: "synthetic-requester", getIdToken: async () => "synthetic-firebase" };
export function useAuth() {
  return { user, loading: false };
}
const vault = {
  isVaultUnlocked: true,
  vaultKey: "synthetic-vault-key",
  vaultOwnerToken: "synthetic-vault-owner",
  getVaultOwnerToken: () => "synthetic-vault-owner",
};
export const VaultContext = createContext<typeof vault | null>(vault);
export function VaultProvider({ children }: { children: ReactNode }) {
  return <>{children}</>;
}
export function useRequireAuth() {
  return { user, loading: false };
}
export const getApiBaseUrl = () => "";
export const normalizeNativeBackendUrl = (url: string) => url;
export const fetchWithWebTimeout = (input: RequestInfo, init?: RequestInit) =>
  // eslint-disable-next-line no-restricted-syntax -- Synthetic browser transport; intercepted by Playwright.
  fetch(input, init);
export function useVault() {
  return vault;
}
export const ApiService = {
  getAuthHeaders: (token: string) => ({ Authorization: `Bearer ${token}` }),
  apiFetch: (path: string, options: RequestInit = {}) =>
    // eslint-disable-next-line no-restricted-syntax -- Synthetic browser transport; intercepted by Playwright.
    fetch(path, options),
};
export const AuthService = {};
export const CacheSyncService = { onConsentMutated: (_userId: string) => {} };
export default function FixtureLink(props: AnchorHTMLAttributes<HTMLAnchorElement>) {
  return <a {...props} />;
}
// Firebase is an identity boundary; this fixture never signs in.
export const app = {};
export const auth = { currentUser: null };
export const getRecaptchaVerifier = () => { throw new Error("not in fixture"); };
export const prepareRecaptchaVerifier = async () => { throw new Error("not in fixture"); };
export const resetRecaptcha = () => {};
