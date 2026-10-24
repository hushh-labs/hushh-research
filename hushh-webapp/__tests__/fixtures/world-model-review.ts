import { pwmClaimKey, type PwmClaim, type PwmMemory } from "@/lib/services/world-model-decision-service";
import type { PwmProgress, PwmValidatedFact } from "@/lib/services/world-model-research-service";

export const DRAFT_ID = "00000000-0000-4000-8000-000000000001";
export const source = { title: "Hushh team page", url: "https://hushh.ai/team" };
export function offered(
  facts: { statement: string; kind: string; confidence?: string }[],
  matchStatus: "matched" | "uncertain" | "no_match" = "matched",
) {
  return {
    status: "offered",
    pkm_written: false,
    draft_id: DRAFT_ID,
    report: {
      match_status: matchStatus,
      name: "Alice",
      summary: "Alice works on private agents.",
      sections: facts.map((fact) => ({
        kind: fact.kind,
        facts: [
          {
            statement: fact.statement,
            confidence: fact.confidence ?? "supported",
            sources: [source],
          },
        ],
      })),
    },
    grounded_answers: [{ answer: "RAW GROUNDED ANSWER", sources: [], search_suggestions: [] }],
    search_suggestions: [],
    research: {
      identity: { reason: "Same verified email on the team page." },
      candidates: [] as { id: string; label: string }[],
    },
  };
}

export function memoryOf(saved: PwmClaim[] = [], decided: string[] = []): PwmMemory {
  return {
    claims: Object.fromEntries(saved.map((claim) => [claim.key, claim])),
    saved,
    decidedKeys: new Set([...saved.map((claim) => claim.key), ...decided]),
  };
}

export async function claim(text: string, topic: PwmClaim["topic"] = "career"): Promise<PwmClaim> {
  return {
    key: await pwmClaimKey(text),
    decision: "accepted",
    text,
    topic,
    decided_at: "2026-10-15T10:00:00.000Z",
    basis: "owner_declaration",
  };
}

export const pending = { status: "pending", pkm_written: false, restart_required: false };
export const progressOf = (over: Partial<PwmProgress> = {}): PwmProgress => ({
  stage: "coverage",
  searches_used: 9,
  searches_total: 32,
  model_calls_used: 20,
  model_calls_total: 128,
  topics_checked: ["career", "education", "public_roles", "interests"],
  sources_found: 5,
  recent_sources: [
    { title: "Acme Corp – Team", url: "https://acme.example/team" },
    { title: "Example Uni – Alumni", url: "https://uni.example/alumni" },
  ],
  identity_state: "owner_linked",
  candidates: 1,
  started_at: "2026-10-15T10:00:00.000Z",
  last_activity_at: "2026-10-15T10:00:30.000Z",
  slice: 1,
  ...over,
});
export const provisionalFact: PwmValidatedFact = {
  id: "candidate-a:career:fact-1",
  topic: "career",
  statement: "Works at Acme Corp",
  confidence: "supported",
  sources: [{ title: "Acme team page", url: "https://acme.example/team" }],
  identity_state: "owner_linked",
};

