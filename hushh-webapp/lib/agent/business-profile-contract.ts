import { resolveCardTargetDomain, type AgentPkmPreviewCard } from "@/lib/agent/agent-pkm-memory";
import { businessMemoryEntity } from "@/lib/pkm/business-memory-origin";

/** Reject a wrong profile contract; never retarget or trim a model proposal. */
export function validBusinessProfilePreview(cards: AgentPkmPreviewCard[], message: string): boolean {
  if (cards.length !== 1 || message.length > 4000) return false;
  try {
    const card = cards[0]!;
    const supplied = JSON.parse(message) as Record<string, unknown>;
    if (!supplied || Array.isArray(supplied) || typeof supplied !== "object" || !Object.keys(supplied).length ||
      Object.entries(supplied).some(([key, value]) => ["__proto__", "prototype", "constructor"].includes(key) || typeof value !== "string" || !value.trim())) return false;
    const domain = resolveCardTargetDomain(card);
    if (!domain || ["identity", "location", "health", "social", "financial"].includes(domain) ||
      (card.target_domain && card.target_domain !== domain) ||
      card.write_mode !== "confirm_first" || card.target_entity_scope !== "businesses") return false;
    const entity = businessMemoryEntity(card);
    const path = entity.path.join(".");
    if (entity.path.length !== 3 || entity.path[0] !== "businesses" ||
      Object.keys(card.candidate_payload || {}).length !== 1 ||
      Object.keys(card.candidate_payload?.businesses as object).length !== 1 ||
      (card.merge_decision?.target_entity_path && card.merge_decision.target_entity_path !== path) ||
      (card.merge_decision?.target_domain && card.merge_decision.target_domain !== domain) ||
      (card.target_entity_id && card.target_entity_id !== entity.path[2]) ||
      !["create_entity", "extend_entity", "correct_entity"].includes(String(card.merge_decision?.merge_mode || ""))) return false;
    return Object.keys(entity.value).length === Object.keys(supplied).length &&
      Object.entries(supplied).every(([key, value]) => entity.value[key] === value);
  } catch { return false; }
}

/** Fixed diagnostic flags only: never log listing values, keys, or entity IDs. */
export function businessProfilePreviewDiagnostics(cards: AgentPkmPreviewCard[], message: string) {
  const card = cards[0];
  const flags = { single_card: cards.length === 1, business_domain: false,
    confirmation_required: card?.write_mode === "confirm_first", business_scope: card?.target_entity_scope === "businesses",
    entity_shape: false, exact_fields: false, merge_target: false };
  if (!card) return flags;
  const domain = resolveCardTargetDomain(card);
  flags.business_domain = Boolean(domain && !["identity", "location", "health", "social", "financial"].includes(domain));
  try {
    const supplied = JSON.parse(message) as Record<string, unknown>;
    const entity = businessMemoryEntity(card);
    flags.entity_shape = entity.path.length === 3 && entity.path[0] === "businesses" &&
      Object.keys(card.candidate_payload || {}).length === 1 &&
      Object.keys(card.candidate_payload?.businesses as object).length === 1;
    flags.exact_fields = Object.keys(entity.value).length === Object.keys(supplied).length &&
      Object.entries(supplied).every(([key, value]) => entity.value[key] === value);
    flags.merge_target = ["create_entity", "extend_entity", "correct_entity"].includes(String(card.merge_decision?.merge_mode || "")) &&
      (!card.merge_decision?.target_entity_path || card.merge_decision.target_entity_path === entity.path.join("."));
  } catch { /* Malformed proposals remain rejected. */ }
  return flags;
}
