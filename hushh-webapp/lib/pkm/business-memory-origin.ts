import type { AgentPkmPreviewCard } from "@/lib/agent/agent-pkm-memory";

export type BusinessMemoryOrigin = { businessUid: string };

/** Find identities in the current domain on every conflict-aware rebuild. */
function businessIdentityPaths(current: Record<string, unknown>, businessUid: string): string[] {
  const matches: string[] = [];
  const visited = new WeakSet<object>();
  const walk = (value: unknown, path: string[]) => {
    if (!value || typeof value !== "object" || Array.isArray(value) || visited.has(value)) return;
    visited.add(value);
    const record = value as Record<string, unknown>;
    const origin = record._business_origin;
    if (path.at(-2) === "entities" && origin && typeof origin === "object" &&
      !Array.isArray(origin) && (origin as Record<string, unknown>).business_uid === businessUid)
      matches.push(path.join("."));
    for (const [key, child] of Object.entries(record)) {
      if (["__proto__", "prototype", "constructor"].includes(key)) throw new Error("Invalid business destination.");
      if (key !== "_business_origin") walk(child, [...path, key]);
    }
  };
  walk(current, []);
  return matches;
}

/** One incoming entity; the merge stage may select a different destination scope. */
export function businessMemoryEntity(card: AgentPkmPreviewCard) {
  const entities: Array<{ value: Record<string, unknown>; path: string[] }> = [];
  const walk = (value: unknown, path: string[] = []) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return;
    for (const [key, child] of Object.entries(value)) {
      if (["__proto__", "prototype", "constructor"].includes(key)) throw new Error("Invalid business destination.");
      if (key === "entities" && child && typeof child === "object" && !Array.isArray(child)) {
        for (const [id, entity] of Object.entries(child)) {
          if (["__proto__", "prototype", "constructor"].includes(id)) throw new Error("Invalid business destination.");
          if (entity && typeof entity === "object" && !Array.isArray(entity))
            entities.push({ value: entity as Record<string, unknown>, path: [...path, key, id] });
        }
      } else walk(child, [...path, key]);
    }
  };
  walk(card.candidate_payload);
  if (entities.length !== 1) throw new Error("The proposed detail needs a fresh review before saving.");
  return entities[0]!;
}

/** A person may have many businesses. An agent merge must not relabel one as another. */
export function assertBusinessMemoryTarget(
  current: Record<string, unknown>, card: AgentPkmPreviewCard, origin: BusinessMemoryOrigin,
) {
  const incomingEntity = businessMemoryEntity(card);
  if (!card.merge_decision?.target_entity_path && (!card.target_entity_scope || !card.target_entity_id))
    throw new Error("Business identity needs a fresh review.");
  const path = String(card.merge_decision?.target_entity_path || incomingEntity.path.join("."));
  if (!path || !origin.businessUid) throw new Error("Business identity needs a fresh review.");
  const segments = path.split(".");
  if (segments.some((segment) => ["__proto__", "prototype", "constructor"].includes(segment)))
    throw new Error("Invalid business destination.");
  if (segments.length < 3 || segments.at(-2) !== "entities" || !segments.at(-1))
    throw new Error("Invalid business destination.");
  const proposed = incomingEntity.value._business_origin;
  if (!proposed || typeof proposed !== "object" || Array.isArray(proposed) ||
    (proposed as Record<string, unknown>).business_uid !== origin.businessUid)
    throw new Error("The proposed business identity needs a fresh review.");
  if (businessIdentityPaths(current, origin.businessUid).some(existing => existing !== path))
    throw new Error("This business is already saved at another destination. Review the existing record instead of creating a duplicate.");
  let value: unknown = current;
  for (const segment of segments) {
    if (!value || typeof value !== "object" || Array.isArray(value) ||
      !Object.prototype.hasOwnProperty.call(value, segment)) return;
    value = (value as Record<string, unknown>)[segment];
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("The saved business needs review.");
  const prior = (value as Record<string, unknown>)._business_origin;
  if (!prior || typeof prior !== "object" || Array.isArray(prior) ||
    (prior as Record<string, unknown>).business_uid !== origin.businessUid)
    throw new Error("This would combine different or unidentified businesses. Nothing was changed.");
}
