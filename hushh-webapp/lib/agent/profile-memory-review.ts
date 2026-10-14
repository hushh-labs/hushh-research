import {
  PROFILE_RESEARCH_SOURCE,
  type ProfileReviewSession,
} from "@/lib/agent/profile-research-review";
import { pkmPlanIdForIdempotencyScope } from "@/lib/personal-knowledge-model/mutation-plan";
import {
  appendMarkdownMemoryFacts,
  MARKDOWN_MEMORY_DOMAIN,
} from "@/lib/pkm/markdown-memory";
import type { SoulFact } from "@/lib/pkm/soul-document";
import { PersonalKnowledgeModelService } from "@/lib/services/personal-knowledge-model-service";
import {
  ProfileResearchService,
  type ProfileReport,
} from "@/lib/services/profile-research-service";

/** Topics that describe taste or choice; every other topic is a plain fact. */
const PREFERENCE_KINDS: ReadonlySet<ProfileReport["sections"][number]["kind"]> =
  new Set([
    "interests",
    "preferences",
    "dislikes",
    "style",
    "food",
    "travel",
    "entertainment",
    "shopping",
    "communication",
  ]);

export type ProfileMemoryReview = {
  /** Exactly the checked, owner-edited statements; nothing is rewritten or added. */
  facts: SoulFact[];
  /** Pinned for the review's life so a retry replays one commit, never a second. */
  scope: string;
  committed: boolean;
};

/** The owner's selection as memory.md bullets. Sources stay in the draft, not the file. */
export function selectedProfileFacts(
  report: ProfileReport,
  selected: ReadonlySet<string>,
  edits: Readonly<Record<string, string>>,
): SoulFact[] {
  return report.sections.flatMap((section) =>
    section.facts.flatMap((fact, index) => {
      const text = (edits[`${section.kind}:${index}`] ?? fact.statement).trim();
      return selected.has(`${section.kind}:${index}`) && text
        ? [
            {
              text,
              section: PREFERENCE_KINDS.has(section.kind)
                ? ("Preferences" as const)
                : ("Facts" as const),
            },
          ]
        : [];
    }),
  );
}

export function prepareProfileMemoryReview(
  facts: SoulFact[],
): ProfileMemoryReview {
  if (!facts.length) throw new Error("Select a detail to keep.");
  return { facts, scope: `profile-review:${crypto.randomUUID()}`, committed: false };
}

/**
 * One atomic memory.md commit, then owner-bound completion. The acknowledged
 * receipt, never a write response, decides whether the save happened, so a lost
 * response is recovered by lookup and a committed write is never replayed.
 */
export async function saveProfileMemoryReview(
  session: ProfileReviewSession,
  review: ProfileMemoryReview,
): Promise<void> {
  const planId = pkmPlanIdForIdempotencyScope(review.scope);
  const acknowledged = async () => {
    await session.assertCurrent();
    const rows = await PersonalKnowledgeModelService.lookupMutationCommits({
      userId: session.userId,
      vaultOwnerToken: session.vaultOwnerToken,
      commits: [{ domain: MARKDOWN_MEMORY_DOMAIN, planId }],
    });
    await session.assertCurrent();
    return rows[0]?.exists === true && rows[0].dataVersion !== null;
  };
  await session.assertCurrent();
  if (!review.committed && !(await acknowledged())) {
    let failure: string | undefined;
    try {
      const result = await appendMarkdownMemoryFacts({
        userId: session.userId,
        vaultKey: session.vaultKey,
        vaultOwnerToken: session.vaultOwnerToken,
        facts: review.facts,
        idempotencyScope: review.scope,
        beforeEffect: session.assertCurrent,
        confirmation: {
          confirmedByUser: true,
          surface: "chat",
          source: PROFILE_RESEARCH_SOURCE,
          confirmedAt: new Date().toISOString(),
        },
      });
      if (!result.success) failure = result.message;
    } catch {
      // A lost response may follow a committed write; only the receipt decides.
    }
    if (!(await acknowledged()))
      throw new Error(failure || "Save wasn't confirmed. Try again.");
  }
  review.committed = true;
  await session.assertCurrent();
  await ProfileResearchService.complete({
    worldModel: session.worldModel,
    draftId: session.draftId,
    vaultKey: session.vaultKey,
    vaultOwnerToken: session.vaultOwnerToken,
    commits: [{ domain: MARKDOWN_MEMORY_DOMAIN, planId }],
  });
  await session.assertCurrent();
}
