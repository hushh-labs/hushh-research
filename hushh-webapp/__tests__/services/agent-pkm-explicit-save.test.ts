import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * An explicit "save this to my memory" must save what the owner supplied,
 * report only server-acknowledged commits, and never leak the saved words to
 * One. Production 2026-09-29: a pasted context document saved nothing while
 * One said it was "queued and submitted".
 */

const mocks = vi.hoisted(() => ({ prepare: vi.fn(), add: vi.fn() }));

vi.mock("@/lib/pkm/pkm-natural-language-ingestion", () => ({
  prepareNaturalLanguagePkm: mocks.prepare,
}));
vi.mock("@/lib/agent/agent-pkm-memory", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/agent/agent-pkm-memory")>()),
  addToPKM: mocks.add,
}));

import { getPkmAutoSaveCards, type AgentPkmPreviewCard } from "@/lib/agent/agent-pkm-memory";
import {
  partitionExplicitSaveCards,
  runExplicitPkmSave,
} from "@/lib/agent/agent-pkm-explicit-save";
import {
  buildPkmSaveReceipt,
  describePkmSaveReceipt,
  formatPkmSaveReceiptForAgent,
} from "@/lib/agent/pkm-save-receipt";
import { classifyMergeOutcome } from "@/lib/pkm/pkm-supersede-merge";

function card(id: string, overrides: Partial<AgentPkmPreviewCard> = {}): AgentPkmPreviewCard {
  return {
    card_id: id,
    source_text: `Synthetic fact ${id}`,
    write_mode: "can_save",
    target_domain: "career",
    candidate_payload: { current_role: { title: `Title ${id}` } },
    structure_decision: { target_domain: "career" },
    merge_decision: { merge_mode: "create_entity" },
    ...overrides,
  };
}

function acked(outcome: "saved" | "updated" | "merged" | "unchanged", dataVersion: number | null = 7) {
  return {
    cardId: "x", domain: "career", scope: null, sharingPosture: "", success: true, outcome,
    result: { saveState: "saved" as const, success: true, dataVersion: dataVersion ?? undefined },
  };
}

describe("explicit memory save", () => {
  beforeEach(() => {
    mocks.prepare.mockReset();
    mocks.add.mockReset();
  });

  it("holds identifiers and shared details for the owner's tap, and never saves refused cards", () => {
    const partition = partitionExplicitSaveCards([
      card("role"),
      card("pay", { write_mode: "confirm_first", requires_confirmation: true,
        candidate_payload: { compensation: { base_pay: "USD 100000 (synthetic)" } } }),
      card("passport", { candidate_payload: { identity: { passport_number: "X0000000" } } }),
      card("shared", { sharing_impact: { active_recipient_count: 1, recipient_labels: ["A"],
        enters_next_export_revision: true, summary: "", affected_grant_ids: [], affected_export_ids: [] } }),
      card("unknowns", { write_mode: "do_not_save" }),
      card("secret", { validation_hints: ["sensitive_credential"] }),
      card("restated", { write_mode: "do_not_save", merge_decision: { merge_mode: "no_op",
        target_entity_path: "profile.entities.role_senior" } }),
    ]);
    expect(partition.save.map((item) => item.card_id)).toEqual(["role", "pay"]);
    expect(partition.needsOwner.map((item) => item.card_id)).toEqual(["passport", "shared"]);
    expect(partition.skipped.map((item) => item.card_id)).toEqual(["unknowns", "secret"]);
    // A restatement the merge agent matched to a stored detail is "already known", not a skip.
    expect(partition.known.map((item) => item.card_id)).toEqual(["restated"]);
    const timedOut = partitionExplicitSaveCards([card("late", { preview_degraded: true })]);
    expect(timedOut.unreadable.map((item) => item.card_id)).toEqual(["late"]);
    expect(timedOut.skipped).toEqual([]);
  });

  it("counts only acknowledged commits; a success without a revision is a failure", () => {
    const partition = partitionExplicitSaveCards([card("a"), card("b"), card("c"), card("d")]);
    const receipt = buildPkmSaveReceipt({
      coverage: [
        { sourceBlockId: "s1", disposition: "proposed", detectedFactCount: 4, accountedFactCount: 4, duplicateCount: 2 },
        // The "Information not known" section: the agent deliberately found nothing.
        { sourceBlockId: "s2", disposition: "intentionally_ignored", detectedFactCount: 0, accountedFactCount: 0 },
        { sourceBlockId: "s3", preparationIssue: "preparation_timeout", disposition: "review_required",
          detectedFactCount: 0, accountedFactCount: 0 },
      ],
      partition,
      saveResult: {
        attempted: 4, saved: 4, failed: 0, domains: ["career"],
        results: [acked("saved"), acked("updated"), acked("merged"), acked("saved", null)],
      },
    });
    expect(receipt).toMatchObject({
      saved: 1, updated: 1, merged: 1, unchanged: 2, skipped: 1, failed: 1, unprepared: 1, needsOwner: 0,
    });
    expect(describePkmSaveReceipt(receipt)).toBe(
      "Saved 1, updated 1, merged 1, 2 already known, skipped 1 (not facts), 1 couldn’t save, 1 section couldn’t be read.",
    );
  });

  it("tells One counts and categories only, never the owner's words", () => {
    const partition = partitionExplicitSaveCards([card("a", { source_text: "Synthetic salary 100000" })]);
    const receipt = buildPkmSaveReceipt({
      coverage: [], partition,
      saveResult: { attempted: 1, saved: 1, failed: 0, domains: ["career"], results: [acked("saved")] },
      domainTitles: new Map([["career", "Career"]]),
    });
    const line = formatPkmSaveReceiptForAgent(receipt);
    expect(line).toContain("Saved to Memory: 1 new");
    expect(line).toContain("Categories written: Career.");
    expect(line).not.toContain("100000");
    const nothing = formatPkmSaveReceiptForAgent(buildPkmSaveReceipt({ coverage: [], partition, saveResult: null }));
    expect(nothing).toContain("Nothing new was written");
  });

  it("saves the prepared sections of a long document even when one section timed out", async () => {
    // The auto-save policy taints every card when any section is unresolved.
    const cards = [card("a", { preparation_requires_review: true }), card("b", { preparation_requires_review: true })];
    expect(getPkmAutoSaveCards(cards)).toEqual([]);
    mocks.prepare.mockResolvedValue({
      cards,
      sourceCoverage: [
        { sourceBlockId: "s1", disposition: "proposed", detectedFactCount: 2, accountedFactCount: 2 },
        { sourceBlockId: "s2", preparationIssue: "preparation_timeout", disposition: "review_required",
          detectedFactCount: 0, accountedFactCount: 0 },
      ],
      previews: [], preview: {}, chunkCount: 1, ingestionId: "i",
    });
    mocks.add.mockResolvedValue({ attempted: 2, saved: 2, failed: 0, domains: ["career"],
      results: [acked("saved"), acked("updated")] });
    const { receipt } = await runExplicitPkmSave({
      userId: "u", message: "# Role\n- Synthetic", currentDomains: [], vaultKey: "k", vaultOwnerToken: "t",
    });
    expect(mocks.prepare).toHaveBeenCalledWith(expect.objectContaining({ granularity: "section", allowEmpty: true }));
    const saved = mocks.add.mock.calls[0]![0];
    expect(saved.cards.map((item: AgentPkmPreviewCard) => item.card_id)).toEqual(["a", "b"]);
    expect(saved.cards.every((item: AgentPkmPreviewCard) => !item.preparation_requires_review)).toBe(true);
    expect(saved.confirmation).toMatchObject({ confirmedByUser: true, surface: "chat", source: "agent_chat_owner_request" });
    expect(receipt).toMatchObject({ saved: 1, updated: 1, unprepared: 1 });
  });

  it("classifies a write against what is stored: new, updated, merged or already known", () => {
    const existing = { current_role: { title: "Engineer", tools: ["Figma"] } };
    expect(classifyMergeOutcome({ existing, incoming: { current_role: { title: "Engineer" } } })).toBe("unchanged");
    expect(classifyMergeOutcome({ existing, incoming: { current_role: { title: " engineer " } } })).toBe("unchanged");
    expect(classifyMergeOutcome({ existing, incoming: { current_role: { title: "Staff Engineer" } } })).toBe("updated");
    expect(classifyMergeOutcome({ existing, incoming: { current_role: { tools: ["Figma", "Linear"] } } })).toBe("merged");
    expect(classifyMergeOutcome({ existing, incoming: { housing: { city: "Synthetic City" } } })).toBe("saved");
    expect(classifyMergeOutcome({ existing, incoming: { current_role: { team: "Platform" } }, mergeMode: "extend_entity" }))
      .toBe("merged");
  });
});
