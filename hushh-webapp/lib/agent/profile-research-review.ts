import {
  clearAgentPkmContext,
  resolveCardTargetDomain,
  type AgentPkmPreviewCard,
} from "@/lib/agent/agent-pkm-memory";
import {
  assertProfileReviewTargetPath,
  businessMemoryEntity,
  touchesBusinessRecord,
  type BusinessMemoryOrigin,
} from "@/lib/pkm/business-memory-origin";
import { AgentPkmContextStore } from "@/lib/agent/agent-pkm-context-store";
import {
  prepareConnectorMemoryReview,
  saveConnectorMemoryReview,
} from "@/lib/agent/connector-memory-review";
import {
  PROFILE_SECTION_LABELS,
  type ProfileReport,
} from "@/lib/services/profile-research-service";
import { pkmPlanIdForIdempotencyScope } from "@/lib/personal-knowledge-model/mutation-plan";
import { PersonalKnowledgeModelService } from "@/lib/services/personal-knowledge-model-service";

export const PROFILE_RESEARCH_SOURCE = "profile_research_review";
export type ProfileReviewSession = {
  userId: string;
  vaultKey: string;
  vaultOwnerToken: string;
  isCurrent: () => boolean;
  assertCurrent: () => Promise<void>;
};
export type ReviewedProfile = {
  message: string;
  cards: AgentPkmPreviewCard[];
  origins: ReadonlyMap<string, BusinessMemoryOrigin>;
  scopes: ReadonlyMap<string, string>;
};

/** Only checked, edited statements enter preparation. Unselected facts and input identifiers do not. */
export function profileReviewMessage(
  report: ProfileReport,
  selected: ReadonlySet<string>,
  edits: Readonly<Record<string, string>>,
): string {
  return report.sections
    .flatMap((section) => {
      const facts = section.facts.flatMap((fact, index) => {
        const id = `${section.kind}:${index}`;
        const statement = (edits[id] ?? fact.statement).trim();
        if (!selected.has(id) || !statement) return [];
        return [
          `- ${statement}\n  Sources: ${fact.sources.map((source) => `${source.title} (${source.url})`).join("; ")}`,
        ];
      });
      return facts.length
        ? [
            `${PROFILE_SECTION_LABELS[section.kind]} details about me:\n${facts.join("\n")}`,
          ]
        : [];
    })
    .join("\n\n");
}

export async function prepareProfileReview(
  session: ProfileReviewSession,
  message: string,
): Promise<ReviewedProfile> {
  if (!message.trim()) throw new Error("Select a detail to keep.");
  const prepared = await prepareConnectorMemoryReview({
    ...session,
    message,
    source: PROFILE_RESEARCH_SOURCE,
  });
  await session.assertCurrent();
  if (prepared.incomplete)
    throw new Error(
      "Some details could not be prepared. Review them and try again.",
    );
  if (!prepared.cards.length)
    throw new Error(
      prepared.alreadySaved
        ? "These details are already saved."
        : "No new details could be prepared.",
    );
  const origins = new Map<string, BusinessMemoryOrigin>();
  const scopes = new Map<string, string>();
  const cards = prepared.cards.map((original) => {
    const card = structuredClone(original);
    assertProfileReviewTargetPath(card);
    // The model may select a current business, but cannot mint or relabel a
    // directory identity. Origin comes only from the freshly decrypted inventory.
    const bound = AgentPkmContextStore.profileBusinessTarget(
      session.userId,
      card,
      resolveCardTargetDomain(card),
    );
    if (bound || touchesBusinessRecord(card)) {
      if (!bound)
        throw new Error("The proposed business identity needs a fresh review.");
      const entity = businessMemoryEntity(card);
      const target = String(
        card.merge_decision?.target_entity_path || "",
      ).split(".");
      if (
        entity.value._business_origin ||
        target.at(-1) !== entity.path.at(-1) ||
        (card.target_entity_id && card.target_entity_id !== entity.path.at(-1))
      )
        throw new Error("The proposed business update needs a fresh review.");
      entity.value._business_origin = bound.metadata;
      origins.set(card.card_id, { businessUid: bound.businessUid });
    }
    scopes.set(card.card_id, `profile-review:${crypto.randomUUID()}`);
    return card;
  });
  return { message, cards, origins, scopes };
}

/** Pinned cards and stable scopes survive partial/lost responses; no re-preparation during save. */
export async function saveProfileReview(
  session: ProfileReviewSession,
  review: ReviewedProfile,
  selectedCardIds: ReadonlySet<string>,
  sharingImpactAcknowledged: boolean,
) {
  let saved = 0;
  const committed = new Set<string>();
  for (const card of review.cards.filter((card) =>
    selectedCardIds.has(card.card_id),
  )) {
    await session.assertCurrent();
    const scope = review.scopes.get(card.card_id);
    if (!scope) throw new Error("The reviewed detail needs a fresh review.");
    const acknowledged = async () => {
      await session.assertCurrent();
      const rows = await PersonalKnowledgeModelService.lookupMutationCommits({
        userId: session.userId,
        vaultOwnerToken: session.vaultOwnerToken,
        commits: [
          {
            domain: resolveCardTargetDomain(card),
            planId: pkmPlanIdForIdempotencyScope(scope),
          },
        ],
      });
      await session.assertCurrent();
      return rows[0]?.exists === true && rows[0].dataVersion !== null;
    };
    let confirmed = await acknowledged();
    if (!confirmed) {
      try {
        const result = await saveConnectorMemoryReview({
          ...session,
          message: review.message,
          cards: [card],
          source: PROFILE_RESEARCH_SOURCE,
          sharingImpactAcknowledged,
          idempotencyScopes: [scope],
          businessOrigin: review.origins.get(card.card_id),
        });
        await session.assertCurrent();
        confirmed =
          result?.saved === 1 &&
          result.failed === 0 &&
          result.results.some(
            (row) => row.success && typeof row.result?.dataVersion === "number",
          ) === true;
      } catch {
        // A lost response may follow a committed write. Never rebuild/replay
        // it until the owner's receipt lookup says whether it landed.
        await session.assertCurrent();
      }
      if (!confirmed) confirmed = await acknowledged();
    }
    await session.assertCurrent();
    if (!confirmed) break;
    clearAgentPkmContext(session.userId);
    saved += 1;
    committed.add(card.card_id);
  }
  return { saved, committed };
}
