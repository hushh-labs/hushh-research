import type { HushhNativeDrawersPlugin } from "./native-drawers";

/** Admission needs the whole scene handshake, including confirmed withdrawal.
 * A flag alone cannot safely transfer an editor to a partially capable wrapper.
 * Keep this mapping shared by the destination and its editor adapters. */
export function hasNativeProfileScene(plugin: HushhNativeDrawersPlugin, scene: "account-name" | "writing-style" | "support" | "phone" | "vault-passphrase" | "request-price" | "world-model" | "runtime-provider" | "connector-custom-server" | "memory-financial-context" | "payments"): boolean {
  const methods = scene === "payments" ? [plugin.applyProfilePaymentsScene, plugin.confirmProfilePaymentsAction, plugin.settleProfilePaymentsAction, plugin.retireProfilePaymentsScene]
    : scene === "memory-financial-context" ? [plugin.applyProfileMemoryScene, plugin.confirmProfileMemoryAction, plugin.settleProfileMemoryAction, plugin.retireProfileMemoryScene]
    : scene === "account-name"
    ? [plugin.applyProfileNameScene, plugin.confirmProfileNameAction, plugin.settleProfileNameAction, plugin.retireProfileNameScene]
    : scene === "writing-style"
      ? [plugin.applyProfileStyleScene, plugin.confirmProfileStyleAction, plugin.settleProfileStyleAction, plugin.retireProfileStyleScene]
      : scene === "support" ? [plugin.applyProfileSupportScene, plugin.confirmProfileSupportAction, plugin.settleProfileSupportAction, plugin.retireProfileSupportScene]
      : scene === "vault-passphrase" ? [plugin.applyProfilePasswordScene, plugin.confirmProfilePasswordAction, plugin.settleProfilePasswordAction, plugin.retireProfilePasswordScene]
      : scene === "request-price" ? [plugin.applyProfilePricingScene, plugin.confirmProfilePricingAction, plugin.settleProfilePricingAction, plugin.retireProfilePricingScene]
      : scene === "world-model" ? [plugin.applyProfileWorldModelScene, plugin.confirmProfileWorldModelAction, plugin.settleProfileWorldModelAction, plugin.retireProfileWorldModelScene]
      : scene === "connector-custom-server" ? [plugin.applyProfileConnectorScene, plugin.confirmProfileConnectorAction, plugin.settleProfileConnectorAction, plugin.retireProfileConnectorScene]
      : scene === "runtime-provider" ? [plugin.applyProfileRuntimeScene, plugin.confirmProfileRuntimeAction, plugin.settleProfileRuntimeAction, plugin.retireProfileRuntimeScene]
      : [plugin.applyProfilePhoneScene, plugin.confirmProfilePhoneAction, plugin.settleProfilePhoneAction, plugin.retireProfilePhoneScene];
  return methods.every(method => typeof method === "function");
}
