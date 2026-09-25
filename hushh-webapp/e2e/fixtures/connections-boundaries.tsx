// Synthetic auth/native/Mail boundaries only; the production drawer, Drive
// transport, popup controller, Picker adapter and card actions are unchanged.
import { useState } from "react";
const user = {
  uid: "fixture-owner",
  getIdToken: async () => "synthetic-firebase",
};
export function useAuth() {
  return { user, loading: false };
}
export function useVault() {
  return { vaultOwnerToken: "synthetic-owner" };
}
export function useCalendarConnectionStatus() {
  return { connected: false, loaded: true, error: null };
}
export function usePkmDomainResource() {
  return { data: null, loading: false, error: null };
}
export function vaultConnections() {
  return {};
}
export function useRouter() {
  return {
    push: (href: string) => window.history.pushState({}, "", href),
  };
}
export const HushhAuth = {
  connectGmail: async () => ({ serverAuthCode: "synthetic-code" }),
};
export const ApiService = {
  getAuthHeaders: (token: string) => ({ Authorization: `Bearer ${token}` }),
  // eslint-disable-next-line no-restricted-syntax -- Synthetic ApiService transport intercepted by the browser harness; never a product component.
  apiFetch: (path: string, options: RequestInit) => fetch(path, options),
};
export const GmailReceiptsService = {
  startConnect: async () => ({
    configured: true,
    authorize_url: "https://accounts.google.com/o/oauth2/v2/auth?fixture=mail",
    expires_at: new Date(Date.now() + 60_000).toISOString(),
  }),
};
export function useGmailConnectorStatus() {
  const [connected, setConnected] = useState(true);
  return {
    status: { connected, google_email: "mail-owner@synthetic.invalid" },
    loadingStatus: false,
    refreshStatus: async () => ({ connected }),
    disconnectGmail: async () => {
      setConnected(false);
      return { connected: false };
    },
  };
}
