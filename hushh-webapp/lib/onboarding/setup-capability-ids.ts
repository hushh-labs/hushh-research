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
 *
 * `cloud` precedes `connections` because that is the product order: a person names
 * and authorizes their own cloud, and only then chooses how their agent reaches a
 * model -- by which point their own project's native Vertex ADC usually answers it,
 * and supplying a key is the exception rather than the front door.
 *
 * A cloud is WHERE the agent lives, not something the agent does for you, which is
 * why it belongs here and not in the capability list. Making it a capability would
 * drag in the whole capability machinery -- setup action ids, handoff targets,
 * resumable active-capability state -- none of which has any meaning for a place.
 *
 * The backend half of this list (`onboarding_contract.SETUP_PREREQUISITE_ORDER`) is
 * an ADMISSION filter applied on both the read and the write path, so it must already
 * contain an id before any surface here writes it.
 */
export const ONE_CLOUD_SETUP_PREREQUISITE_ID = "cloud";
export const ONE_RUNTIME_SETUP_PREREQUISITE_ID = "connections";

/**
 * Named explicitly rather than derived by index. This used to be
 * `ONE_SETUP_PREREQUISITE_IDS[0]`, so prepending a second prerequisite silently
 * redefined it: `hasOneRuntimeChoice` would have started answering "did they set up a
 * cloud?", the AI-access gate would have been satisfied by the wrong step, and nothing
 * anywhere would have raised.
 */
export const ONE_SETUP_PREREQUISITE_IDS = [
  ONE_CLOUD_SETUP_PREREQUISITE_ID,
  ONE_RUNTIME_SETUP_PREREQUISITE_ID,
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
