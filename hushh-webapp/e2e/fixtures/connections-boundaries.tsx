// Synthetic auth/native/Mail boundaries only; the production drawer, Drive
// transport, popup controller, Picker adapter and card actions are unchanged.
import { createContext, useState } from "react";
// This layout fixture has no unlocked encrypted custom-connector catalog.
export const loadCustomConnectorConfigurations = async () => [];
export const loadCustomConnectorSnapshot = async () => ({
  configurations: [],
  invalid: [],
});
export const saveCustomConnectorConfiguration = async () => { throw new Error("Not admitted in layout fixture"); };
export const removeCustomConnectorConfiguration = async () => { throw new Error("Not admitted in layout fixture"); };
export const removeInvalidCustomConnectorConfiguration = async () => { throw new Error("Not admitted in layout fixture"); };
export const projectCustomConnectorTurnConfigurations = () => { throw new Error("Not admitted in layout fixture"); };
// Pure credential helpers the settings surface calls; the real ones, since they
// read nothing and write nothing.
export { bearerAuthorizationValue, isVaultOwnerCredential } from "@/lib/connections/custom-connector-schema";
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
// Same synthetic vault as `useVault`, for components that read the context.
export const VaultContext = createContext<{ vaultOwnerToken: string } | null>({
  vaultOwnerToken: "synthetic-owner",
});
export function useCalendarConnectionStatus() {
  // Starts disconnected without a request; `refresh` reads the routed
  // owner status endpoint, the way the production hook re-reads the server.
  const [connected, setConnected] = useState(false);
  return {
    connected,
    loaded: true,
    error: null,
    status: { status: connected ? "connected" : "disconnected" },
    refresh: () => {
      // eslint-disable-next-line no-restricted-syntax -- Synthetic status read intercepted by the browser harness; never a product component.
      void fetch("/api/one/calendar/status/fixture-owner")
        .then((response) => response.json())
        .then((body: { connected?: boolean; status?: string }) =>
          setConnected(body.connected === true && body.status === "connected"),
        )
        .catch(() => undefined);
    },
  };
}
export function usePkmDomainResource() {
  return { data: null, loading: false, error: null };
}
export function vaultConnections() {
  return {};
}
export async function disconnectVaultPlaid() {
  throw new Error("No Plaid mutation in the layout fixture");
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
  // Owner status read, routed by the browser harness like the real endpoint.
  getStatus: async () => {
    // eslint-disable-next-line no-restricted-syntax -- Synthetic status read intercepted by the browser harness; never a product component.
    const response = await fetch("/api/gmail/status/fixture-owner");
    return response.json();
  },
  recordConsentFailure: () => undefined,
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
