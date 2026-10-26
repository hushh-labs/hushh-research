// Synthetic boundaries only. The mounted fixture uses the production controllers,
// validation, calendar, receipt components, Dialog owner and optimized stylesheet.
const user = { uid: "fixture-requester", getIdToken: async () => "fixture-id-token" };
const getVaultOwnerToken = () => "fixture-owner-token";
export const useAuth = () => ({ user, userId: user.uid });
export const usePathname = () => "/one/profile";
const searchParams = new URLSearchParams(location.search);
export const useSearchParams = () => searchParams;
const unexpectedNavigation = () => { throw new Error("Unexpected fixture route navigation"); };
export const useRouter = () => ({ push: unexpectedNavigation, replace: unexpectedNavigation, back: unexpectedNavigation });
export const useVault = () => ({ isVaultUnlocked: true, vaultOwnerToken: getVaultOwnerToken(), vaultKey: "fixture-key", getVaultOwnerToken });
export const AuthService = {
  getCurrentUser: () => user,
  getIdToken: user.getIdToken,
  documentRequestIdentityToken: user.getIdToken,
  linkGoogleIdentity: async () => undefined,
};
const unexpectedTransport = async (): Promise<never> => { throw new Error("Unexpected fixture transport"); };
export const ApiService = { apiFetch: unexpectedTransport, apiFetchStream: unexpectedTransport };
export const CacheSyncService = { onConsentMutated() {}, onFeedChanged() {} };
export const bootstrapCurrentUserLocationRecipientKey = async () => ({ userId: user.uid, publicKeyJwk: { kty: "EC" } });
export function VaultFlow() { throw new Error("Unlocked fixture must not enter vault setup"); }
