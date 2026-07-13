/**
 * Canonical account-setup capability order.
 *
 * This module is deliberately dependency-free so routing, the One capability
 * catalog, generated contracts, and durable journey normalization can share
 * one source without creating an import cycle.
 */
export const ONE_SETUP_CAPABILITY_IDS = [
  "gmail",
  "location",
  "email",
  "finance",
  "ria",
  "connected-systems",
] as const;

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
