import type { VaultWrapper } from "@/lib/services/vault-service";

export function vaultMethodLabel(wrapper: VaultWrapper, biometricLabel?: string, localBiometricId?: string | null) {
  if (wrapper.method === "passphrase") return "Password";
  if (wrapper.method === "generated_default_native_biometric") {
    return (wrapper.wrapperId ?? "default") === localBiometricId ? biometricLabel || "Biometrics" : "Device biometrics";
  }
  return wrapper.passkeyDeviceLabel || (wrapper.passkeyProvider === "webauthn_prf" ? "Browser passkey" : "Device passkey");
}

/** Opaque presentation handles, never credential or wrapper identifiers. Both
 * renderers use the same labels and duplicate-name treatment. */
export function presentVaultMethods(wrappers: readonly VaultWrapper[], biometricLabel?: string, localBiometricId?: string | null) {
  const labels = wrappers.map(wrapper => vaultMethodLabel(wrapper, biometricLabel, localBiometricId));
  const occurrences = new Map<string, number>();
  return wrappers.map((wrapper, index) => {
    const label = labels[index] ?? vaultMethodLabel(wrapper, biometricLabel, localBiometricId);
    const ordinal = (occurrences.get(label) ?? 0) + 1;
    occurrences.set(label, ordinal);
    return { wrapper, id: crypto.randomUUID(), label: labels.filter(candidate => candidate === label).length > 1 ? `${label} ${ordinal}` : label };
  });
}
