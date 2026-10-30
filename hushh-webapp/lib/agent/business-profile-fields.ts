import { describeAgentPkmCardDestination, formatAgentPkmCardDestination, type AgentPkmPreviewCard } from "@/lib/agent/agent-pkm-memory";
import { businessMemoryEntity } from "@/lib/pkm/business-memory-origin";

export type BusinessReviewField = { id: string; path: string[]; label: string; value: unknown };
export type BusinessFieldSelection = Record<string, string[]>;

export type BusinessReviewItem = {
  id: string; label: string; text: string; destination: string; recordDetail: boolean;
  fields: { cardId: string; fieldId: string }[];
};

const BUSINESS_LABELS: Record<string, string> = {
  name: "Business name", business_name: "Business name", website: "Website", phone: "Phone",
  email: "Email", formatted_address: "Address", address: "Address", address_line1: "Street address",
  street1: "Street address", city: "City", state: "State", zip: "Postal code", postal_code: "Postal code",
  category: "Category", description: "About", hours: "Opening hours", summary: "Details",
  observations: "Notes", kind: "Record type", status: "Record status",
};

function readableValue(value: unknown): string {
  if (Array.isArray(value)) return value.map(readableValue).join("\n");
  if (value && typeof value === "object") return Object.entries(value).map(([key, child]) =>
    `${BUSINESS_LABELS[key] || key.replaceAll("_", " ")}: ${readableValue(child)}`).join("\n");
  return value === null ? "Not provided" : typeof value === "boolean" ? value ? "Yes" : "No" : String(value);
}

/** Presentation only. Every checkbox retains all exact backing field references. */
export function businessReviewItems(cards: AgentPkmPreviewCard[]): BusinessReviewItem[] {
  const groups = new Map<string, BusinessReviewItem>();
  for (const card of cards) for (const field of businessReviewFields(card)) {
    const leaf = field.path.at(-1)!;
    const recordDetail = field.path.length === 1 && ["kind", "status"].includes(leaf);
    let label = BUSINESS_LABELS[leaf] || field.label;
    let text = readableValue(field.value);
    // A singleton observation that repeats a summary is one visible fact,
    // but its array and summary remain separate, unchanged fields on save.
    let identityValue: unknown = field.value;
    if (leaf === "observations" && Array.isArray(field.value) && field.value.length === 1 && typeof field.value[0] === "string") {
      identityValue = field.value[0];
      label = BUSINESS_LABELS.summary!;
    }
    if (["summary", "observations"].includes(leaf) && typeof identityValue === "string") {
      const labelled = /^(name|business_name|website|phone|email|formatted_address|address|city|state|zip|postal_code|category):\s(.+)$/s.exec(identityValue);
      if (labelled) { label = BUSINESS_LABELS[labelled[1]!]!; text = labelled[2]!; }
    }
    if (recordDetail && leaf === "kind" && text === "profile_fact") text = "Profile detail";
    if (recordDetail && leaf === "status" && text === "active") text = "Active";
    // No value-only, fuzzy, cross-destination or source-derived merging.
    const destination = formatAgentPkmCardDestination(describeAgentPkmCardDestination(card));
    const key = JSON.stringify([destination, field.path.slice(0, -1), label, identityValue, recordDetail]);
    const group = groups.get(key);
    const reference = { cardId: card.card_id, fieldId: field.id };
    if (group) group.fields.push(reference);
    else groups.set(key, { id: key, label, text, destination, recordDetail, fields: [reference] });
  }
  return [...groups.values()];
}

/** Consent applies to the actual proposed entity, not just its source listing. */
export function businessReviewFields(card: AgentPkmPreviewCard): BusinessReviewField[] {
  const fields: BusinessReviewField[] = [];
  const walk = (value: unknown, path: string[]) => {
    if (value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).length) {
      for (const [key, child] of Object.entries(value)) {
        if (["__proto__", "prototype", "constructor"].includes(key)) throw new Error("Invalid business field.");
        const writerBookkeeping = !path.length && ["entity_id", "created_at", "updated_at"].includes(key);
        if (key !== "_business_origin" && !writerBookkeeping) walk(child, [...path, key]);
      }
    } else if (path.length) fields.push({ id: JSON.stringify(path), path,
      label: path.map(key => key.replaceAll("_", " ")).join(" › "), value });
  };
  walk(businessMemoryEntity(card).value, []);
  return fields;
}

export function initialBusinessFieldSelection(cards: AgentPkmPreviewCard[]): BusinessFieldSelection {
  return Object.fromEntries(cards.map(card => [card.card_id, businessReviewFields(card).map(field => field.id)]));
}

/**
 * Owner-directed narrowing only: keep the model's destination and merge mode.
 * Arrays are one visible field; nested object leaves can be chosen separately.
 * Rebuild the envelope so unreviewed sibling payloads cannot ride along.
 */
export function selectBusinessReviewFields(card: AgentPkmPreviewCard, selectedIds: readonly string[]): AgentPkmPreviewCard | null {
  const fields = businessReviewFields(card);
  const selected = new Set(selectedIds);
  if (selectedIds.length !== selected.size || selectedIds.some(id => !fields.some(field => field.id === id)))
    throw new Error("The field selection changed. Review the details again.");
  const approved = fields.filter(field => selected.has(field.id));
  if (!approved.length) return null;
  const result = structuredClone(card);
  const original = businessMemoryEntity(card);
  const entity: Record<string, unknown> = {};
  for (const field of approved) {
    let cursor = entity;
    field.path.slice(0, -1).forEach(key => {
      cursor[key] ??= {};
      cursor = cursor[key] as Record<string, unknown>;
    });
    cursor[field.path.at(-1)!] = structuredClone(field.value);
  }
  if (original.value._business_origin) entity._business_origin = structuredClone(original.value._business_origin);
  let payload: Record<string, unknown> = entity;
  for (const key of [...original.path].reverse()) payload = { [key]: payload };
  result.candidate_payload = payload;
  const source = `Owner-selected business details. Ownership is not verified.\n${approved.map(field =>
    `${field.label}: ${typeof field.value === "string" ? field.value : JSON.stringify(field.value)}`).join("\n")}`;
  result.source_text = source;
  result.source_quote = source;
  delete result.context_quotes;
  // Generated readable metadata must be rebuilt from approved content. A model
  // summary of the original full profile is not consent to store omitted facts.
  if (result.structure_decision) {
    delete result.structure_decision.summary_projection;
    // This explanation reaches the plaintext mutation receipt. Never carry
    // content-derived prose from the unfiltered model preview into that plan.
    delete result.structure_decision.explanation;
  }
  if (result.manifest_draft) result.manifest_draft.summary_projection = {};
  if (result.retrieval_hints) delete result.retrieval_hints.aliases;
  return result;
}
