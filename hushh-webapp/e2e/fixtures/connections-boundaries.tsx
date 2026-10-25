// Synthetic auth/native/Mail/cache boundaries; the production drawer, Drive
// transport, popup controller, Picker adapter and card actions are unchanged.
import { createContext, useState } from "react";
export function usePathname() { return "/"; }
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
  return { user, userId: user.uid, loading: false };
}
// Packet controls use the auth service for verified buyer identity. Keep that
// provider boundary synthetic instead of importing Firebase's full sign-out
// and vault warm-up graph into this mounted settings fixture.
export const AuthService = {
  getIdToken: user.getIdToken,
  getCurrentUser: () => user,
  documentRequestIdentityToken: async () => "synthetic-firebase",
  linkGoogleIdentity: async () => { throw new Error("No identity mutation in the layout fixture"); },
};
export function useVault() {
  return { vaultOwnerToken: "synthetic-owner", isVaultUnlocked: true, getVaultOwnerToken: () => "synthetic-owner" };
}
// Same synthetic vault as `useVault`, for components that read the context.
export const VaultContext = createContext<{ vaultOwnerToken: string } | null>({
  vaultOwnerToken: "synthetic-owner",
});
export function useCalendarConnectionStatus() {
  // Starts disconnected without a request; `refresh` reads the routed
  // owner status endpoint, the way the production hook re-reads the server.
  const [status, setStatus] = useState({ connected: false, status: "disconnected", google_email: null as string | null });
  return {
    connected: status.connected && status.status === "connected",
    loaded: true,
    error: null,
    status,
    refresh: () => {
      // eslint-disable-next-line no-restricted-syntax -- Synthetic status read intercepted by the browser harness; never a product component.
      void fetch("/api/one/calendar/status/fixture-owner")
        .then((response) => response.json())
        .then((body: { connected?: boolean; status?: string; google_email?: string | null }) =>
          setStatus({ connected: body.connected === true, status: body.status || "disconnected", google_email: body.google_email || null }),
        )
        .catch(() => undefined);
    },
  };
}
export const PkmDomainResourceService = {
  invalidateDomain: () => {
    throw new Error("No PKM invalidation in the Connections layout fixture");
  },
};
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
// Private turns are outside this Shared connector layout fixture.
export async function streamAgentChat() {
  throw new Error("Private chat is not admitted in the layout fixture");
}
export const app = null;
export const auth = null;
export const prepareRecaptchaVerifier = () => {
  throw new Error("Authentication is outside the Connections layout fixture");
};
export const getRecaptchaVerifier = prepareRecaptchaVerifier;
export const resetRecaptcha = () => {};
// Pure task models and rows stay real. This public fixture does not admit
// encrypted task reads or writes through the private service port.
export { openTodoItems, completedTodoItems, TODO_SOURCE_LABELS } from "@/lib/todos/todo-list-model";
function taskMutationUnavailable(): never {
  throw new Error("No task creation or execution in the public layout fixture");
}
export const agentTodoInput = taskMutationUnavailable;
export const buildTodo = taskMutationUnavailable;
export const calendarTodoInput = taskMutationUnavailable;
export const createTodo = taskMutationUnavailable;
export const isLiveAgentTodo = taskMutationUnavailable;
export const TodoListPkmService = {
  load: async () => { throw new Error("No task reads in the public layout fixture"); },
  setStatus: async () => { throw new Error("No task writes in the public layout fixture"); },
  remove: async () => { throw new Error("No task writes in the public layout fixture"); },
};
// Profile settings import these cold native service paths into the bundle.
// This browser fixture admits no native calls; fail if one is actually used.
function unavailableNativeBridge(name: string) {
  return new Proxy({}, {
    get(_target, method) {
      throw new Error(`${name}.${String(method)} is not admitted in the Connections layout fixture`);
    },
  });
}
export const HushhPersonalKnowledgeModel = unavailableNativeBridge("HushhPersonalKnowledgeModel");
export const HushhVault = unavailableNativeBridge("HushhVault");
export const HushhConsent = unavailableNativeBridge("HushhConsent");
export const HushhNotifications = unavailableNativeBridge("HushhNotifications");
export const HushhLocation = unavailableNativeBridge("HushhLocation");
export const ApiService = {
  // This fixture explicitly rehearses a recorded Shared owner.
  getPersonalAgentStatus: async () => ({ hostingMode: "shared" as const }),
  getAuthHeaders: (token: string) => ({ Authorization: `Bearer ${token}` }),
  // eslint-disable-next-line no-restricted-syntax -- Synthetic ApiService transport intercepted by the browser harness; never a product component.
  apiFetch: (path: string, options: RequestInit) => fetch(path, options),
};
export const GmailReceiptsService = {
  startConnect: async () => ({
    configured: true,
    authorize_url: "https://accounts.google.com/o/oauth2/v2/auth?fixture=mail&redirect_uri=http%3A%2F%2Flocalhost%2Fone%2Fprofile%2Fgmail%2Foauth%2Freturn",
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

// Feed-preview layout never reads or persists a native recipient key.
export const HushhKeychain = {
  get: async () => ({ value: null }),
  set: async () => { throw new Error("Not admitted in layout fixture"); },
  delete: async () => { throw new Error("Not admitted in layout fixture"); },
};

// The mounted Feed preview reads through the real service/cache/epoch paths.
// Mutations are outside this fixture; keep their cold resource imports out of
// its synthetic auth/PKM/Plaid boundaries and reject an unexpected write.
export const CacheSyncService = {
  onFeedChanged(_userId: string): never {
    throw new Error("Feed mutations are not admitted in the read-only Connections layout fixture");
  },
};

// The fixture vault is locked, so the shared Live Mirror shows only its status.
export function useLiveMirrorView() {
  return { status: "locked", view: null } as const;
}
