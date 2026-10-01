// Semantic preview and encrypted writer effects are synthetic here. The
// shipped review UI, selection, explicit confirmation, and session guard run
// unchanged. Encryption/persistence is covered by the canonical writer suite.
export { isReservedPkmCard, describeAgentPkmCardDestination, formatAgentPkmCardDestination } from "../../lib/agent/agent-pkm-memory";
import type { AgentPkmPreviewCard } from "../../lib/agent/agent-pkm-memory";
export const loadPkmAgentLabContext = async () => ({ metadata: { domains: [{ key: "professional" }] }, manifests: {} });
export const AgentPkmContextStore = { findLocalDuplicate: () => ({ kind: "none" }), load: async () => null };
export const clearAgentPkmContext = () => {};
export const prepareNaturalLanguagePkm = async () => ({ sourceCoverage: [], cards: [
  { card_id: "launch", source_text: "The SDK launch is planned for October.", write_mode: "confirm_first", target_domain: "professional", primary_json_path: "projects.sdk.launch" },
  { card_id: "owner", source_text: "Priya owns the SDK launch.", write_mode: "confirm_first", target_domain: "professional", primary_json_path: "projects.sdk.owner" },
] });
export const addToPKM = async ({ cards, confirmation }: { cards: AgentPkmPreviewCard[]; confirmation: { confirmedByUser: boolean } }) => {
  if (confirmation.confirmedByUser !== true) throw new Error("confirmation_required");
  window.dispatchEvent(new CustomEvent("fixture:memory-saved", { detail: cards.length }));
  return { attempted: cards.length, saved: cards.length, failed: 0, domains: ["professional"], results: [] };
};

// This layout fixture supplies no source-coverage blocks; coverage validation
// belongs to the production ingestion tests. Fail if that fixture contract changes.
export const isUnresolvedSourceBlock = () => {
  throw new Error("Drive layout fixture must not provide source coverage");
};
