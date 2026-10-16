// Inert vault services for visual QA. VaultFlow and VaultUnlockDialog stay real.
import React from "react";

const demoRecoveryKey = "DEMO-ONLY-NOT-A-RECOVERY-KEY";
const passphraseWrapper = { method: "passphrase", encryptedVaultKey: "fixture" };
let state: Record<string, unknown> | null = null;

export class VaultAuthSessionNotReadyError extends Error {}
export const VaultService = {
  getVaultState: async () => state,
  checkVault: async () => false,
  createVault: async () => ({
    vaultKeyHex: "fixture-vault-key",
    recoveryKey: demoRecoveryKey,
    encryptedVaultKey: "fixture",
    salt: "fixture",
    iv: "fixture",
    recoveryEncryptedVaultKey: "fixture",
    recoverySalt: "fixture",
    recoveryIv: "fixture",
  }),
  hashVaultKey: async () => "fixture-hash",
  setupVaultState: async (_userId: string, next: Record<string, unknown>) => {
    state = next;
  },
  assertVaultKeyMatchesState: async () => undefined,
  getWrapperByMethod: () => passphraseWrapper,
  getPrimaryWrapper: () => passphraseWrapper,
  setVaultCheckCache: () => undefined,
};

export const VaultBootstrapService = {
  cancelAuthentication: async () => undefined,
  getBiometricLabel: async () => "Biometrics",
  getDeviceBiometricWrapperId: async () => "default",
};
export const VaultMethodService = {
  getCapabilityMatrix: async () => ({ recommendedMethod: "generated_default_web_prf" }),
};
export const VaultMethodPromptLocalService = { dismiss: async () => undefined };
export const VaultQuickUnlockTrustLocalService = { load: async () => null };
export const isQuickUnlockTrustRequired = () => false;
export const checkPrfSupport = async () => true;
export const useVault = () => ({ isVaultUnlocked: false, unlockVault: async () => undefined });
export const useHostname = () => "setup.local";
export const getNativeTestConfig = () => ({});
export const getNativeUiTestVaultPassphrase = () => null;
export const isNativeUiTestSession = () => false;
export const preferPassphraseUnlockForAutomation = () => false;
export const shouldSkipGeneratedVaultUnlockForAutomation = () => false;
export const useNativeTestConfig = () => ({});
export const trackEvent = () => undefined;
export const downloadTextFile = async () => undefined;
export const copyToClipboard = async () => undefined;
export const LostVaultDeletePanel = () => null;

/* eslint-disable @next/next/no-img-element -- Browser fixture preserves image geometry. */
export default function Image({ alt = "", unoptimized: _unoptimized, ...props }: React.ImgHTMLAttributes<HTMLImageElement> & { unoptimized?: boolean }) {
  return <img alt={alt} {...props} />;
}
