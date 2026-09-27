// Synthetic boundary adapters. The fixture runs the production AuthProvider,
// notification deadline, auth epoch, and terminal browser navigation.
const record = (event: string) => {
  void (window as unknown as { recordSignOutEvent: (event: string) => Promise<void> })
    .recordSignOutEvent(event);
};
const user = { uid: "sign-out-fixture", getIdToken: async () => "synthetic-token" };
let currentUser: typeof user | null = user;
export const auth = {};
export const prepareRecaptchaVerifier = () => undefined;
export const resetRecaptcha = () => undefined;
export const onAuthStateChanged = (_auth: unknown, listener: (value: unknown) => void) => {
  queueMicrotask(() => listener(currentUser));
  return () => undefined;
};
export const Capacitor = { isNativePlatform: () => false, getPlatform: () => "web" };
export const AuthService = {
  getCurrentUser: () => currentUser,
  signOut: async () => { currentUser = null; record("credentials-cleared"); },
};
export const ApiService = {
  getAccountSessionStatus: async () => Response.json({ active: true }),
  notifyAuthMail: async () => undefined,
  deleteSession: async () => { record("cookie-cleared"); },
};
export const deleteFCMToken = async () => {
  record("notification-cleanup-started");
  await new Promise(() => undefined);
};
export const AccountIdentityService = {
  peekCachedIdentity: () => null,
  refreshCurrentUserIdentity: async () => null,
};
export const CacheSyncService = { onAuthSignedOut: () => record("cache-cleared") };
export const UserLocalStateService = { clearForUser: async () => record("local-state-cleared") };
export const OnboardingLocalService = {
  clearMarketingSeen: async () => undefined,
  markForceIntroOnce: async () => record("intro-requested"),
};
export const setOnboardingFlowActiveCookie = () => undefined;
export const setOnboardingRequiredCookie = () => undefined;
export const clearSessionStorage = () => undefined;
export const removeLocalItem = () => undefined;
export const setObservabilityUserId = async () => undefined;
export const isLocalCrmBuildEnabled = () => false;
export const getNativeSessionPrivacyState = async () => ({ shielded: false, generation: 0 });
export const completeNativeSessionPrivacyValidation = async () => undefined;
export const subscribeNativeSessionPrivacy = async () => () => undefined;
export const appInteractionCoordinator = {
  getLifecycleSnapshot: () => ({ state: "active" }),
  subscribeLifecycle: () => () => undefined,
};
export const useOneConversationSession = { getState: () => ({ clearSession: () => undefined }) };
