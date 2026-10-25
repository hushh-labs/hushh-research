/** Synthetic authentication/PKM transport only. Document cryptography, PDF
 * processing, API decoding, review UI and downloads are production modules. */
import type { DocumentSession } from "../../lib/services/document-hosting-service";
import type { KycClientConnectorPrivateRecord } from "../../lib/services/one-kyc-client-zk-service";

export type HostedFixtureConfig = {
  connector: KycClientConnectorPrivateRecord;
  ownerVaultKey: string;
  recipientVaultKey: string;
};
let configuration: HostedFixtureConfig;
let activeActor: "owner" | "recipient" = "recipient";
let keySetups = 0;
let recipientKeyLost = false;
export function setHostedFixtureConfig(value: HostedFixtureConfig) { configuration = value; }
export function setHostedFixtureActor(value: "owner" | "recipient") { activeActor = value; }
export const getFixtureKeySetupCount = () => keySetups;
export function loseFixtureRecipientKey() { recipientKeyLost = true; }
const getVaultKey = () => activeActor === "owner" ? configuration.ownerVaultKey : configuration.recipientVaultKey;
export const getFixtureOwnerToken = () => activeActor;
const users = {
  owner: { uid: "owner", providerData: [], getIdToken: async () => "owner" },
  recipient: { uid: "recipient", providerData: [], getIdToken: async () => "recipient" },
};
export const fixtureSession = (userId: "owner" | "recipient"): DocumentSession => ({
  userId, vaultOwnerToken: userId,
  vaultKey: userId === "owner" ? configuration.ownerVaultKey : configuration.recipientVaultKey,
  isCurrent: () => true,
});
export const ApiService = {
  apiFetch: (url: string, { isEffectCurrent, responseType: _responseType, ...options }: RequestInit & { isEffectCurrent?: () => boolean; responseType?: string }) => {
    if (isEffectCurrent && !isEffectCurrent()) throw new Error("session_changed");
    // eslint-disable-next-line no-restricted-syntax -- Isolated HTTP fixture boundary.
    return fetch(url, options);
  },
};
export const OneKycClientZkService = {
  readStoredConnector: async ({ userId, keyId }: { userId: string; keyId?: string }) =>
    !recipientKeyLost && userId === "recipient" && (!keyId || configuration.connector.connector_key_id === keyId) ? configuration.connector : null,
  ensureConnector: async ({ userId }: { userId: string }) => {
    if (userId !== "recipient") throw new Error("Unexpected connector setup");
    keySetups++;
    if (recipientKeyLost) {
      // Only the external public-key registry/PKM transport is synthetic.
      // Recovery proof, owner rewrap and paid package amendment remain real.
      // eslint-disable-next-line no-restricted-syntax -- Loopback-only generated key fixture.
      const response = await fetch("/__document_fixture/replace-key", { method: "POST" });
      if (!response.ok) throw new Error("Synthetic key replacement failed");
      configuration.connector = await response.json() as KycClientConnectorPrivateRecord;
      recipientKeyLost = false;
    }
    return configuration.connector;
  },
};
export function useAuth() { return { user: users[activeActor], userId: activeActor }; }
export function useVault() { return { isVaultUnlocked: true, getVaultKey, getVaultOwnerToken: getFixtureOwnerToken, vaultOwnerToken: activeActor }; }
export const usePathname = () => "/one/documents/open";
export const useSearchParams = () => new URLSearchParams(window.location.search);
export const useRouter = () => ({
  push: () => { throw new Error("Unexpected navigation outside the document fixture"); },
  replace: () => { throw new Error("Unexpected navigation outside the document fixture"); },
});
export const AuthService = {
  getCurrentUser: () => users[activeActor],
  getIdTokenWithRetry: async ({ expectedUserId }: { expectedUserId: string }) => {
    if (activeActor !== expectedUserId) throw new Error("session_changed");
    return activeActor;
  },
  documentRequestIdentityToken: async () => { throw new Error("One-only request must not ask for Google identity"); },
  linkGoogleIdentity: async () => { throw new Error("One-only request must not ask for Google authorization"); },
};
export const CacheSyncService = { onConsentMutated: () => undefined };
export const projectCustomConnectorTurnConfigurations = () => [];
