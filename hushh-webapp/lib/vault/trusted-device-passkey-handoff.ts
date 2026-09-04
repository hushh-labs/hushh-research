import { VaultService, type VaultWrapper } from "@/lib/services/vault-service";
import { authenticateWithPrf } from "@/lib/vault/prf-auth";
import { wrapExportKeyForConnector } from "@/lib/vault/export-encrypt";

export const TRUSTED_DEVICE_VAULT_HANDOFF_ALG = "X25519-AES256-GCM";
export const TRUSTED_DEVICE_VAULT_HANDOFF_VERSION =
  "hussh-one-trusted-device-vault-handoff-v1";

export type TrustedDeviceVaultHandoff = {
  vault_handoff_wrapped_key: string;
  vault_handoff_iv: string;
  vault_handoff_tag: string;
  vault_handoff_sender_public_key: string;
  vault_handoff_alg: typeof TRUSTED_DEVICE_VAULT_HANDOFF_ALG;
  vault_handoff_vault_key_hash: string;
  vault_handoff_wrapper_id: string;
  vault_handoff_rp_id: string;
};

function isPasskeyWrapper(wrapper: VaultWrapper): boolean {
  return (
    wrapper.method === "generated_default_web_prf" ||
    wrapper.method === "generated_default_native_passkey_prf"
  );
}

export function trustedDeviceVaultHandoffAad(params: {
  state: string;
  authorizationId: string;
  deviceId: string;
  userId: string;
  expiresAt: number;
  vaultKeyHash: string;
  wrapperId: string;
  rpId: string;
  environment: "uat" | "production";
  recipientPublicKey: string;
}): string {
  return [
    TRUSTED_DEVICE_VAULT_HANDOFF_VERSION,
    params.state,
    params.authorizationId,
    params.deviceId,
    params.userId,
    String(params.expiresAt),
    params.vaultKeyHash,
    params.wrapperId,
    params.rpId,
    params.environment,
    params.recipientPublicKey,
  ].join("|");
}

function compatiblePasskeyWrapper(
  wrappers: VaultWrapper[],
  hostname: string,
): VaultWrapper | null {
  const normalizedHost = hostname.trim().toLowerCase();
  const compatible = wrappers.filter((wrapper) => {
    if (!isPasskeyWrapper(wrapper)) return false;
    if (
      !wrapper.passkeyCredentialId ||
      !wrapper.passkeyPrfSalt ||
      !wrapper.passkeyRpId
    ) {
      return false;
    }
    const rpId = wrapper.passkeyRpId.trim().toLowerCase();
    return normalizedHost === rpId || normalizedHost.endsWith(`.${rpId}`);
  });
  return (
    compatible.sort((left, right) => {
      const leftRpId = left.passkeyRpId!.trim().toLowerCase();
      const rightRpId = right.passkeyRpId!.trim().toLowerCase();
      const leftExact = leftRpId === normalizedHost ? 1 : 0;
      const rightExact = rightRpId === normalizedHost ? 1 : 0;
      if (leftExact !== rightExact) return rightExact - leftExact;
      return (right.passkeyLastUsedAt ?? 0) - (left.passkeyLastUsedAt ?? 0);
    })[0] ?? null
  );
}

export async function buildTrustedDevicePasskeyHandoff(params: {
  userId: string;
  deviceId: string;
  state: string;
  authorizationId: string;
  expiresAt: number;
  recipientPublicKey: string;
  hostname: string;
  environment: "uat" | "production";
}): Promise<TrustedDeviceVaultHandoff | null> {
  const vaultState = await VaultService.getVaultState(params.userId);
  const wrapper = compatiblePasskeyWrapper(
    vaultState.wrappers,
    params.hostname,
  );
  if (!wrapper) return null;
  const wrapperId = wrapper.wrapperId || "default";
  const rpId = wrapper.passkeyRpId!.trim().toLowerCase();

  const passkey = await authenticateWithPrf(
    params.userId,
    wrapper.passkeyPrfSalt!,
    wrapper.passkeyCredentialId,
    wrapper.passkeyRpId,
  );
  const vaultKey = await VaultService.unlockVault(
    passkey.vaultKeyHex,
    wrapper.encryptedVaultKey,
    wrapper.salt,
    wrapper.iv,
  );
  if (!vaultKey) {
    throw new Error("The selected One passkey could not unlock this.");
  }
  await VaultService.assertVaultKeyMatchesState(vaultState, vaultKey);

  const wrapped = await wrapExportKeyForConnector({
    exportKeyHex: vaultKey,
    connectorPublicKey: params.recipientPublicKey,
    additionalData: trustedDeviceVaultHandoffAad({
      state: params.state,
      authorizationId: params.authorizationId,
      deviceId: params.deviceId,
      userId: params.userId,
      expiresAt: params.expiresAt,
      vaultKeyHash: vaultState.vaultKeyHash,
      wrapperId,
      rpId,
      environment: params.environment,
      recipientPublicKey: params.recipientPublicKey,
    }),
  });
  return {
    vault_handoff_wrapped_key: wrapped.wrappedExportKey,
    vault_handoff_iv: wrapped.wrappedKeyIv,
    vault_handoff_tag: wrapped.wrappedKeyTag,
    vault_handoff_sender_public_key: wrapped.senderPublicKey,
    vault_handoff_alg: TRUSTED_DEVICE_VAULT_HANDOFF_ALG,
    vault_handoff_vault_key_hash: vaultState.vaultKeyHash,
    vault_handoff_wrapper_id: wrapperId,
    vault_handoff_rp_id: rpId,
  };
}
