// Synthetic identity/vault ports only. Workspace, drawer, reset, queue and
// informational AG-UI transport remain production code.
import { createContext } from "react";

const user = { uid: "new-chat-test-owner", displayName: location.search.includes("long=1")
  ? "AlexandriaVeryLongPreferredFirstNameForChatLayoutVerification Owner"
  : "Test Owner", email: "owner@example.test", getIdToken: async () => "synthetic-id-token" };
export function useAuth() {
  return { user: location.search.includes("anonymous=1") ? null : user, loading: false, sessionVerificationRequired: false };
}
export function useVault() {
  return { isVaultUnlocked: false, vaultKey: null, vaultOwnerToken: null, tokenExpiresAt: null, getVaultOwnerToken: () => null };
}
export const VaultContext = createContext(null);
export function usePersonaState() {
  return { activePersona: "investor", primaryNavPersona: "investor", personaTransitionTarget: null, riaSetupAvailable: false, riaSwitchAvailable: false, riaOnboardingStatus: null, switchPersona: async () => {} };
}
const onboarding = { turns: [], shownTurns: new Map(), shownTurnTimes: new Map(), captureComposerText: () => false, dailyTip: null };
export const useChatOnboarding = () => onboarding;
export const useGmailConnectorStatus = () => ({ status: null, loadingStatus: false, presentation: {} });
export const useRootChatDeferredReady = () => true;
export const useOneVoiceLiveEnabled = () => false;
export const useEffectiveAvatarUrl = () => null;
export const useOneDisplayName = () => "One";
export const useEntryWelcome = () => null;
export const ModelPreferenceService = { get: async () => ({ choices: [], effective_model: "test" }) };
const search = new URLSearchParams();
export const usePathname = () => "/";
export const useSearchParams = () => search;
export const useRouter = () => ({ push: () => {}, replace: () => {}, prefetch: () => {} });
export const AuthService = { getIdToken: user.getIdToken, getCurrentUser: () => user };
export const auth = null;
export const app = null;
export const prepareRecaptchaVerifier = () => { throw new Error("No authentication mutation in this fixture"); };
export const resetRecaptcha = () => {};
export const VaultUnlockDialog = () => null;
