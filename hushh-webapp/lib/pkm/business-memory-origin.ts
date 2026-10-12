import type { AgentPkmPreviewCard } from "@/lib/agent/agent-pkm-memory";

export type BusinessMemoryOrigin = { businessUid: string };

/** The canonical writer targets the entity, never a suffix beneath it. */
export function assertProfileReviewTargetPath(card: AgentPkmPreviewCard): void {
  const path = String(card.merge_decision?.target_entity_path || "");
  if (!path) return;
  const segments = path.split(".");
  const entityAt = segments.indexOf("entities");
  if (
    segments.some(
      (key) => !key || ["__proto__", "prototype", "constructor"].includes(key),
    ) ||
    entityAt < 0 ||
    entityAt !== segments.length - 2 ||
    segments.lastIndexOf("entities") !== entityAt
  )
    throw new Error("The proposed destination needs a fresh review.");
}

/** A checked addition is not permission to replace an existing entity.
 * Runs against the coordinator's fresh, conflict-aware domain snapshot.
 */
export function assertProfileSelectionCreateTarget(
  card: AgentPkmPreviewCard,
  current: Record<string, unknown>,
): void {
  if (!card.validation_hints?.includes("exact_profile_selection_v1")) return;
  assertProfileReviewTargetPath(card);
  if (card.merge_decision?.merge_mode !== "create_entity") return;
  const entity = businessMemoryEntity(card);
  const path = String(
    card.merge_decision.target_entity_path || entity.path.join("."),
  );
  let value: unknown = current;
  for (const key of path.split(".")) {
    if (
      !value ||
      typeof value !== "object" ||
      Array.isArray(value) ||
      !Object.hasOwn(value, key)
    )
      return;
    value = (value as Record<string, unknown>)[key];
  }
  throw new Error(
    "This destination already has details. Nothing was replaced.",
  );
}

/** Existing business provenance requires a pinned origin; new public facts do not assert ownership. */
export function touchesBusinessRecord(
  card: AgentPkmPreviewCard,
  current?: Record<string, unknown>,
): boolean {
  const walk = (value: unknown): boolean =>
    !!value &&
    typeof value === "object" &&
    Object.entries(value).some(
      ([key, child]) => key === "_business_origin" || walk(child),
    );
  const path = String(card.merge_decision?.target_entity_path || "")
    .split(".")
    .filter(Boolean);
  if (walk(card.candidate_payload)) return true;
  if (!current) return false;
  let target: unknown = current;
  for (const key of path)
    target =
      target &&
      typeof target === "object" &&
      Object.prototype.hasOwnProperty.call(target, key)
        ? (target as Record<string, unknown>)[key]
        : null;
  if (path.length && walk(target)) return true;
  // A create without an explicit merge path may reuse the incoming entity's
  // path. Protect that existing destination too, including retargeted scopes.
  if (!path.length) {
    try {
      target = current;
      for (const key of businessMemoryEntity(card).path)
        target =
          target &&
          typeof target === "object" &&
          Object.prototype.hasOwnProperty.call(target, key)
            ? (target as Record<string, unknown>)[key]
            : null;
      return walk(target);
    } catch {
      return false;
    }
  }
  return false;
}

/** Find identities in the current domain on every conflict-aware rebuild. */
function businessIdentityPaths(
  current: Record<string, unknown>,
  businessUid: string,
): string[] {
  const matches: string[] = [];
  const visited = new WeakSet<object>();
  const walk = (value: unknown, path: string[]) => {
    if (
      !value ||
      typeof value !== "object" ||
      Array.isArray(value) ||
      visited.has(value)
    )
      return;
    visited.add(value);
    const record = value as Record<string, unknown>;
    const origin = record._business_origin;
    if (
      path.at(-2) === "entities" &&
      origin &&
      typeof origin === "object" &&
      !Array.isArray(origin) &&
      (origin as Record<string, unknown>).business_uid === businessUid
    )
      matches.push(path.join("."));
    for (const [key, child] of Object.entries(record)) {
      if (["__proto__", "prototype", "constructor"].includes(key))
        throw new Error("Invalid business destination.");
      if (key !== "_business_origin") walk(child, [...path, key]);
    }
  };
  walk(current, []);
  return matches;
}

/** One incoming entity; the merge stage may select a different destination scope. */
export function businessMemoryEntity(card: AgentPkmPreviewCard) {
  const entities: Array<{ value: Record<string, unknown>; path: string[] }> =
    [];
  const walk = (value: unknown, path: string[] = []) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return;
    for (const [key, child] of Object.entries(value)) {
      if (["__proto__", "prototype", "constructor"].includes(key))
        throw new Error("Invalid business destination.");
      if (
        key === "entities" &&
        child &&
        typeof child === "object" &&
        !Array.isArray(child)
      ) {
        for (const [id, entity] of Object.entries(child)) {
          if (["__proto__", "prototype", "constructor"].includes(id))
            throw new Error("Invalid business destination.");
          if (entity && typeof entity === "object" && !Array.isArray(entity))
            entities.push({
              value: entity as Record<string, unknown>,
              path: [...path, key, id],
            });
        }
      } else walk(child, [...path, key]);
    }
  };
  walk(card.candidate_payload);
  if (entities.length !== 1)
    throw new Error("The proposed detail needs a fresh review before saving.");
  return entities[0]!;
}

/** A person may have many businesses. An agent merge must not relabel one as another. */
export function assertBusinessMemoryTarget(
  current: Record<string, unknown>,
  card: AgentPkmPreviewCard,
  origin: BusinessMemoryOrigin,
  options: { requireExistingTarget?: boolean } = {},
) {
  const incomingEntity = businessMemoryEntity(card);
  const mode = String(card.merge_decision?.merge_mode || card.merge_mode || "");
  // A create has no prior target: its identity is the model-authored payload.
  // Updates must still name an explicit existing target.
  if (!card.merge_decision?.target_entity_path && mode !== "create_entity")
    throw new Error("Business identity needs a fresh review.");
  const path = String(
    card.merge_decision?.target_entity_path || incomingEntity.path.join("."),
  );
  if (!path || !origin.businessUid)
    throw new Error("Business identity needs a fresh review.");
  const segments = path.split(".");
  if (
    segments.some((segment) =>
      ["__proto__", "prototype", "constructor"].includes(segment),
    )
  )
    throw new Error("Invalid business destination.");
  if (segments.length < 3 || segments.at(-2) !== "entities" || !segments.at(-1))
    throw new Error("Invalid business destination.");
  const proposed = incomingEntity.value._business_origin;
  if (
    !proposed ||
    typeof proposed !== "object" ||
    Array.isArray(proposed) ||
    (proposed as Record<string, unknown>).business_uid !== origin.businessUid
  )
    throw new Error("The proposed business identity needs a fresh review.");
  if (
    businessIdentityPaths(current, origin.businessUid).some(
      (existing) => existing !== path,
    )
  )
    throw new Error(
      "This business is already saved at another destination. Review the existing record instead of creating a duplicate.",
    );
  let value: unknown = current;
  for (const segment of segments) {
    if (
      !value ||
      typeof value !== "object" ||
      Array.isArray(value) ||
      !Object.prototype.hasOwnProperty.call(value, segment)
    ) {
      if (options.requireExistingTarget)
        throw new Error("The saved business changed. Review these details again. Nothing was changed.");
      return;
    }
    value = (value as Record<string, unknown>)[segment];
  }
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("The saved business needs review.");
  if (options.requireExistingTarget &&
    ((value as Record<string, unknown>).active === false ||
      ((value as Record<string, unknown>).status !== undefined &&
        (value as Record<string, unknown>).status !== "active")))
    throw new Error("The saved business changed. Review these details again. Nothing was changed.");
  const prior = (value as Record<string, unknown>)._business_origin;
  if (
    !prior ||
    typeof prior !== "object" ||
    Array.isArray(prior) ||
    (prior as Record<string, unknown>).business_uid !== origin.businessUid
  )
    throw new Error(
      "This would combine different or unidentified businesses. Nothing was changed.",
    );
  // A create replaces the whole existing entity. A narrowed consent selection
  // must not erase fields the owner previously saved (also checked on retries).
  if (
    String(card.merge_decision?.merge_mode || "create_entity")
      .trim()
      .toLowerCase() === "create_entity"
  )
    throw new Error(
      "This business already exists. Review an update instead of replacing its saved details.",
    );
}
