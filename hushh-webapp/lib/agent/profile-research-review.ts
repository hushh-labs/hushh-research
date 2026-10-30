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
import {
  prepareConnectorMemoryReview,
  saveConnectorMemoryReview,
} from "@/lib/agent/connector-memory-review";
import {
  PROFILE_SECTION_LABELS,
  ProfileResearchService,
  type ProfileReport,
} from "@/lib/services/profile-research-service";
import { pkmPlanIdForIdempotencyScope } from "@/lib/personal-knowledge-model/mutation-plan";
import { PersonalKnowledgeModelService } from "@/lib/services/personal-knowledge-model-service";

export const PROFILE_RESEARCH_SOURCE = "profile_research_review";
export type ProfileReviewSession = {
  worldModel?: boolean;
  sourceReview?: boolean;
  draftId?: string;
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
  committed: Set<string>;
};

export type SelectedProfileDetail = {
  statement: string;
  sources: ProfileReport["sections"][number]["facts"][number]["sources"];
};

export function selectedProfileDetails(
  report: ProfileReport,
  selected: ReadonlySet<string>,
  edits: Readonly<Record<string, string>>,
): SelectedProfileDetail[] {
  return report.sections.flatMap((section) =>
    section.facts.flatMap((fact, index) => {
      const id = `${section.kind}:${index}`;
      const statement = (edits[id] ?? fact.statement).trim();
      return selected.has(id) && statement
        ? [{ statement, sources: fact.sources }]
        : [];
    }),
  );
}

/** One-click confirmation covers exact checked facts, not arbitrary model additions.
 * The model still chooses the domain/target. Reject an entire preparation rather
 * than rewriting its meaning or accepting facts the owner did not see.
 */
export function assertExactProfileSelection(
  review: ReviewedProfile,
  details: readonly SelectedProfileDetail[],
): void {
  const remaining = new Set(details.map((detail) => detail.statement));
  const fail = () => {
    throw new Error("Couldn't save these details safely. Please try again.");
  };
  const visit = (value: unknown, originBound: boolean): void => {
    if (!value || typeof value !== "object" || Array.isArray(value))
      return fail();
    const row = value as Record<string, unknown>;
    if (Object.hasOwn(row, "summary")) {
      if (typeof row.summary !== "string" || !remaining.has(row.summary))
        return fail();
      const detail = details.find(
        (detail) => detail.statement === row.summary,
      )!;
      const allowed = new Set([
        "summary",
        "observations",
        "kind",
        "status",
        "sources",
      ]);
      if (originBound) allowed.add("_business_origin");
      if (Object.keys(row).some((key) => !allowed.has(key))) return fail();
      if (row.kind !== undefined && row.kind !== "profile_fact") return fail();
      if (row.status !== undefined && row.status !== "active") return fail();
      if (
        row.observations !== undefined &&
        (!Array.isArray(row.observations) ||
          row.observations.some((item) => item !== detail.statement))
      )
        return fail();
      if (
        row.sources !== undefined &&
        (!Array.isArray(row.sources) ||
          row.sources.length !== detail.sources.length ||
          row.sources.some((source, index) => {
            if (!source || typeof source !== "object" || Array.isArray(source))
              return true;
            const value = source as Record<string, unknown>;
            const expected = detail.sources[index]!;
            return (
              Object.keys(value).some(
                (key) => key !== "title" && key !== "url",
              ) ||
              value.title !== expected.title ||
              value.url !== expected.url
            );
          }))
      )
        return fail();
      remaining.delete(detail.statement);
      return;
    }
    if (!Object.keys(row).length) return fail();
    for (const child of Object.values(row)) visit(child, originBound);
  };
  if (!details.length || !review.cards.length) return fail();
  for (const card of review.cards) {
    assertProfileReviewTargetPath(card);
    const quote = card.source_quote || card.source_text;
    if (!quote || !review.message.includes(quote)) return fail();
    if (
      !["create_entity", "extend_entity"].includes(
        String(card.merge_decision?.merge_mode),
      )
    )
      return fail();
    // The canonical writer commits one entity per card, never every sibling.
    const entity = businessMemoryEntity(card);
    const target = card.merge_decision?.target_entity_path;
    if (target && target !== entity.path.join(".")) return fail();
    visit(card.candidate_payload, review.origins.has(card.card_id));
  }
  if (remaining.size) fail();
}

/** Citation bookkeeping comes from the exact owner selection, not inference.
 * Never replace a source list authored by the model; the fidelity gate rejects
 * mismatched nonempty metadata. Bind once before the payload/scopes are pinned.
 */
export function bindProfileSelectionSources(
  review: ReviewedProfile,
  details: readonly SelectedProfileDetail[],
): void {
  assertExactProfileSelection(review, details);
  for (const card of review.cards) {
    const entity = businessMemoryEntity(card);
    const detail = details.find(
      (detail) => detail.statement === entity.value.summary,
    )!;
    if (entity.value.sources === undefined)
      entity.value.sources = structuredClone(detail.sources);
    card.validation_hints = [
      ...new Set([
        ...(card.validation_hints || []),
        "exact_profile_selection_v1",
      ]),
    ];
  }
}

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
  if (!prepared.profileInventory)
    throw new Error("Existing details could not be checked. Try again.");
  const inventory = prepared.profileInventory;
  const cards = prepared.cards.map((original) => {
    const card = structuredClone(original);
    assertProfileReviewTargetPath(card);
    // The model may select a current business, but cannot mint or relabel a
    // directory identity. Bind to the same inventory used during preparation,
    // never a later cache refresh with another business at the reviewed path.
    const bound = inventory.businessTarget(card, resolveCardTargetDomain(card));
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
  return { message, cards, origins, scopes, committed: new Set() };
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
    review.committed.add(card.card_id);
  }
  if (selectedCardIds.size > 0 && committed.size === selectedCardIds.size) {
    await session.assertCurrent();
    await ProfileResearchService.complete({
      worldModel: session.worldModel,
      sourceReview: session.sourceReview,
      draftId: session.draftId,
      vaultKey: session.vaultKey,
      vaultOwnerToken: session.vaultOwnerToken,
      commits: review.cards
        .filter((card) => review.committed.has(card.card_id))
        .map((card) => ({
          domain: resolveCardTargetDomain(card),
          planId: pkmPlanIdForIdempotencyScope(
            review.scopes.get(card.card_id)!,
          ),
        })),
    });
    await session.assertCurrent();
  }
  return { saved, committed };
}
