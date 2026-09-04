/**
 * Canonical account-setup capability order.
 *
 * This module is deliberately dependency-free so routing, the One capability
 * catalog, generated contracts, and durable journey normalization can share
 * one source without creating an import cycle.
 */
export const ONE_SETUP_CAPABILITY_IDS = [
  "gmail",
  "calendar",
  "location",
  "email",
  "finance",
  "ria",
  "connected-systems",
] as const;

/**
 * Root-setup prerequisites share the durable setup-state set, but are not
 * agent capabilities and must never enter the generated action catalog.
 */
export const ONE_SETUP_PREREQUISITE_IDS = ["connections"] as const;
export const ONE_RUNTIME_SETUP_PREREQUISITE_ID =
  ONE_SETUP_PREREQUISITE_IDS[0];

export type OneSetupCapabilityId = (typeof ONE_SETUP_CAPABILITY_IDS)[number];

const ONE_SETUP_CAPABILITY_ID_SET = new Set<string>(ONE_SETUP_CAPABILITY_IDS);

export function normalizeOneSetupCapabilityId(
  value: unknown,
): OneSetupCapabilityId | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return ONE_SETUP_CAPABILITY_ID_SET.has(normalized)
    ? (normalized as OneSetupCapabilityId)
    : null;
}
