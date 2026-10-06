/** Fixture-only information boundaries. The real Dialog, VaultFlow and controls
 * render; no authentication, credential submission or account mutation exists. */
const wrapper = { method: "passphrase", wrapperId: "fixture", encryptedVaultKey: "fixture", salt: "fixture", iv: "fixture" };
const quickWrapper = { ...wrapper, method: "generated_default_native_biometric", wrapperId: "fixture-quick" };
let unavailableQuickMethod = false;
export const setVaultFixtureHint = (unavailable: boolean) => { unavailableQuickMethod = unavailable; };
const forbidden = () => { throw new Error("Layout fixture cannot perform a vault operation"); };

export class VaultAuthSessionNotReadyError extends Error {}
export const VaultService = {
  checkVault: async () => true,
  getVaultState: async () => ({ primaryMethod: unavailableQuickMethod ? quickWrapper.method : wrapper.method, primaryWrapperId: unavailableQuickMethod ? quickWrapper.wrapperId : wrapper.wrapperId, wrappers: unavailableQuickMethod ? [wrapper, quickWrapper] : [wrapper] }),
  getPrimaryWrapper: () => unavailableQuickMethod ? quickWrapper : wrapper,
  getWrapperByMethod: (_state: unknown, method: string) => method === "passphrase" ? wrapper : null,
  unlockWithMethod: forbidden,
  getOrIssueVaultOwnerToken: forbidden,
};
export const useVault = () => ({ isVaultUnlocked: false, unlockVault: forbidden });
export const VaultBootstrapService = { cancelAuthentication: async () => undefined };
export const VaultMethodService = { getCapabilityMatrix: async () => ({ recommendedMethod: "passphrase" }) };
export const VaultMethodPromptLocalService = {};
export const isQuickUnlockTrustRequired = () => false;
export const VaultQuickUnlockTrustLocalService = { load: async () => null };
export const checkPrfSupport = async () => false;
export const copyToClipboard = forbidden;
export const downloadTextFile = forbidden;
const testConfig = { enabled: false };
export const getNativeTestConfig = () => testConfig;
export const useNativeTestConfig = () => testConfig;
export const getNativeUiTestVaultPassphrase = () => null;
export const isNativeUiTestSession = () => false;
export const preferPassphraseUnlockForAutomation = () => false;
export const shouldSkipGeneratedVaultUnlockForAutomation = () => false;
