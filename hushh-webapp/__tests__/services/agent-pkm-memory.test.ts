import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const apiFetchMock = vi.fn();
vi.mock("@/lib/services/api-service", () => ({
  ApiService: {
    apiFetch: (...args: unknown[]) => apiFetchMock(...args), getPersonalAgentStatus: async () => ({ hostingMode: "shared" }),
  },
}));
vi.mock("@/lib/services/auth-service", () => ({ AuthService: { getCurrentUser: () => ({ uid: "user_1" }) } }));
const pkmGetMetadataMock = vi.fn();
const prepareNaturalLanguageMock = vi.fn();
vi.mock("@/lib/pkm/pkm-natural-language-ingestion", async (original) => ({
  ...(await original<typeof import("@/lib/pkm/pkm-natural-language-ingestion")>()),
  prepareNaturalLanguagePkm: (...args: unknown[]) => prepareNaturalLanguageMock(...args),
}));
vi.mock("@/lib/profile/pkm-agent-lab-capture", () => ({
  loadPkmAgentLabContext: async () => ({ metadata: { domains: [] }, manifests: {} }),
}));
vi.mock("@/lib/services/personal-knowledge-model-service", () => ({
  PersonalKnowledgeModelService: {
    getMetadata: (...args: unknown[]) => pkmGetMetadataMock(...args),
  },
}));

const pkmGetManyStaleFirstMock = vi.fn();
const pkmGetStaleFirstMock = vi.fn();
const pkmPeekMock = vi.fn();
vi.mock("@/lib/pkm/pkm-domain-resource", () => ({
  PkmDomainResourceService: {
    getStaleFirst: (...args: unknown[]) => pkmGetStaleFirstMock(...args),
    getManyStaleFirst: (...args: unknown[]) => pkmGetManyStaleFirstMock(...args),
    peek: (...args: unknown[]) => pkmPeekMock(...args),
  },
}));

const pkmSavePreparedDomainMock = vi.fn();
const pkmSaveMergedDomainMock = vi.fn();
vi.mock("@/lib/services/pkm-write-coordinator", () => ({
  PkmWriteCoordinator: {
    savePreparedDomain: (...args: unknown[]) => pkmSavePreparedDomainMock(...args),
    saveMergedDomain: (...args: unknown[]) => pkmSaveMergedDomainMock(...args),
  },
}));

const peekLiveMirrorMock = vi.fn();
vi.mock("@/lib/pkm/memory-refresh", () => ({
  peekLiveMirror: (...args: unknown[]) => peekLiveMirrorMock(...args),
}));

import {
  addToPKM,
  clearAgentPkmContext,
  describeAgentPkmCardDestination,
  formatAgentPkmSaveSummary,
  getPkmAutoSaveCards,
  getPkmConfirmationCards,
  loadAgentPkmContext,
  peekAgentPkmContext,
  peekReceiptMemoryIndex,
  previewAgentPkmMemory,
  warmAgentPkmContext,
  type AgentPkmPreviewCard,
} from "@/lib/agent/agent-pkm-memory";
import { AgentPkmContextStore } from "@/lib/agent/agent-pkm-context-store";
import { prepareProfileReview } from "@/lib/agent/profile-research-review";
import { toPlainMemoryText } from "@/lib/pkm/memory-plain-text";
import { publishValidatedAuthSessionPrincipal } from "@/lib/auth/session-owner";
import { advanceVaultSessionEpoch, snapshotVaultSessionEpoch } from "@/lib/vault/session-epoch";
import type { LiveMirrorFact, LiveMirrorView } from "@/lib/pkm/live-mirror-contract";
import { createAgentPkmCaptureGuard, isAgentPkmProcessingReady } from "@/lib/agent/agent-pkm-capture-runtime";
import { planSecretCaptures, UnguardedSecretError } from "@/lib/pkm/secret-span-guard";
import { peekMarkdownMemory, replaceMarkdownMemoryDocument } from "@/lib/pkm/markdown-memory";
import * as markdownMemory from "@/lib/pkm/markdown-memory";

// Structured-PKM specialist contracts stay covered independently of One's
// Soul-only context loader. These tests must not reintroduce a chat fallback.
async function loadLegacyPkmContext(params: Parameters<typeof loadAgentPkmContext>[0]) {
  const context = await AgentPkmContextStore.load({ ...params, vaultKey: params.vaultKey! });
  if (!context) throw new Error("Legacy context unavailable");
  return context;
}

// Synthetic secrets, assembled from parts so no credential-shaped literal sits in the repository.
const FAKE_API_KEY = ["s", "k-proj-", "fakefake0000fakefake9f2a"].join("");
const FAKE_PASSWORD = "Fake-pass-42";
const FAKE_CARD = "4111 1111 1111 1111";
const FAKE_PASSPORT = "X1234567";
const SECRET_PASSAGE = `openai key ${FAKE_API_KEY}, bank password is ${FAKE_PASSWORD}!\ncard ${FAKE_CARD}\npassport number ${FAKE_PASSPORT}`;
const FAKE_VALUES = [FAKE_API_KEY, FAKE_PASSWORD, FAKE_CARD, FAKE_CARD.replace(/ /g, ""), FAKE_PASSPORT];

// A read-time Live Mirror view whose records also hold fields that must never
// reach a model: a token, a birth date and another person's id.
function liveMirrorView(ownerId: string, vaultEpoch: number): LiveMirrorView {
  const now = new Date().toISOString();
  const fact = (ref: string, predicate: string, value: LiveMirrorFact["value"]): LiveMirrorFact => {
    const [kind, field] = predicate.split(".") as [LiveMirrorFact["kind"], string];
    return { key: `["${kind}","src-raw-${ref}","${field}"]`, predicate, kind, sourceId: `src-raw-${ref}`, ref, field,
      label: field, value, state: "verified", revision: 2, sourceUpdatedAt: now, capturedAt: now, verifiedAt: now };
  };
  return {
    schemaVersion: "live_mirror.v1", ownerId, vaultEpoch, builtAt: now, inventoryObservedAt: now, inventoryComplete: true,
    issues: [], nameConflict: false, sources: [], markdown: "", evaluatedAt: now, overall: "current", lastVerifiedAt: now,
    facts: [
      fact("Profile", "profile.name", "Synthetic Owner"),
      fact("Profile", "profile.accessToken", "ya29.SYNTH"),
      fact("Profile", "profile.dateOfBirth", "1990-01-01"),
      fact("Connection 1", "connection.counterpartId", "uid-other"),
    ],
    history: { entries: [], firstRetainedSequence: 1, droppedCount: 0, truncatedAt: null, coverage: "open_app_only" },
  };
}

it("keeps a confirmed old-generation receipt without invalidating the replacement owner context", async () => {
  publishValidatedAuthSessionPrincipal({ firebaseUid: "owner-a", ownerId: "owner-a", accountGeneration: 0 });
  const guard = createAgentPkmCaptureGuard({
    userId: "owner-a", signal: new AbortController().signal, isEnabled: () => true,
  });
  const invalidate = vi.spyOn(AgentPkmContextStore, "invalidateUser");
  pkmSavePreparedDomainMock.mockImplementationOnce(async () => {
    publishValidatedAuthSessionPrincipal({ firebaseUid: "owner-b", ownerId: "owner-b", accountGeneration: 0 });
    publishValidatedAuthSessionPrincipal({ firebaseUid: "owner-a", ownerId: "owner-a", accountGeneration: 0 });
    advanceVaultSessionEpoch();
    return { success: true, saveState: "saved", fullBlob: {} };
  });
  try {
    const result = await addToPKM({
      userId: "owner-a", sourceMessage: "Synthetic preference", vaultKey: "test-key",
      vaultOwnerToken: "test-token", beforeEffect: guard.assertCurrent, mayPublish: guard.isCurrent,
      confirmation: { confirmedByUser: true, surface: "chat", source: "test" },
      cards: [{ card_id: "test", write_mode: "can_save", target_domain: "preferences",
        candidate_payload: { format: "brief" }, structure_decision: { target_domain: "preferences" } }],
    });
    expect(result.saved).toBe(1);
    expect(guard.isCurrent()).toBe(false);
    expect(invalidate).not.toHaveBeenCalled();
  } finally {
    invalidate.mockRestore();
    publishValidatedAuthSessionPrincipal(null);
  }
});

const METADATA = {
  userId: "user_1",
  domains: [
    {
      key: "preferences",
      displayName: "Preferences",
      icon: "",
      color: "",
      attributeCount: 1,
      summary: { readable_summary: "Prefers concise answers." },
      readableSummary: "Prefers concise answers.",
      readableHighlights: ["Concise summaries"],
      availableScopes: [],
      lastUpdated: "2026-07-06T12:00:00Z",
    },
  ],
  totalAttributes: 1,
  modelCompleteness: 1,
  modelVersion: 1,
  storedModelVersion: 1,
  effectiveModelVersion: 1,
  targetModelVersion: 1,
  upgradeStatus: "ready",
  upgradableDomains: [],
  suggestedDomains: [],
  lastUpgradedAt: null,
  lastUpdated: "2026-07-06T12:00:00Z",
};

let pkmBlob: Record<string, unknown>;

describe("agent PKM memory helpers", () => {
  it("an explicit Review recovers from a rejected warm-up without retrying across lock", async () => {
    let rejectWarm!: (error: Error) => void;
    pkmGetManyStaleFirstMock.mockReturnValueOnce(new Promise((_resolve, reject) => { rejectWarm = reject; }));
    const params = { userId: "user_1", vaultKey: "test-key", vaultOwnerToken: "test-token" };
    const warm = AgentPkmContextStore.load(params).catch(() => null);
    await vi.waitFor(() => expect(pkmGetManyStaleFirstMock).toHaveBeenCalledOnce());
    const review = AgentPkmContextStore.load({ ...params, forceRefresh: true });
    rejectWarm(new Error("optional warm-up unavailable"));
    await warm;
    expect(await review).not.toBeNull();
    expect(pkmGetManyStaleFirstMock).toHaveBeenCalledTimes(2);
    expect(pkmGetManyStaleFirstMock.mock.calls[1]![0]).toMatchObject({ forceRefresh: true });

    clearAgentPkmContext();
    pkmGetManyStaleFirstMock.mockReturnValueOnce(new Promise((_resolve, reject) => { rejectWarm = reject; }));
    const oldWarm = AgentPkmContextStore.load(params).catch(() => null);
    await vi.waitFor(() => expect(pkmGetManyStaleFirstMock).toHaveBeenCalledTimes(3));
    const oldReview = AgentPkmContextStore.load({ ...params, forceRefresh: true });
    clearAgentPkmContext();
    rejectWarm(new Error("warm-up failed after lock"));
    await oldWarm;
    expect(await oldReview).toBeNull();
    expect(pkmGetManyStaleFirstMock).toHaveBeenCalledTimes(3);
  });
  it("a forced Review waits for warm-up then performs an authoritative complete read", async () => {
    let finishWarm!: (value: unknown) => void;
    pkmGetManyStaleFirstMock.mockReturnValueOnce(new Promise(resolve => { finishWarm = resolve; }));
    const params = { userId: "user_1", vaultKey: "test-key", vaultOwnerToken: "test-token" };
    const warm = AgentPkmContextStore.load(params);
    await vi.waitFor(() => expect(pkmGetManyStaleFirstMock).toHaveBeenCalledOnce());
    const review = AgentPkmContextStore.load({ ...params, forceRefresh: true });
    finishWarm({ snapshots: {}, failedDomains: ["preferences"] });
    await warm;
    await review;
    expect(pkmGetManyStaleFirstMock).toHaveBeenCalledTimes(2);
    expect(pkmGetManyStaleFirstMock.mock.calls[1]![0]).toMatchObject({ forceRefresh: true });
    expect(pkmGetMetadataMock.mock.calls[1]).toEqual(["user_1", true, "test-token", { allowStaleFallback: false }]);
    expect(AgentPkmContextStore.findBusinessReconciliationCandidates({ userId: "user_1", businessUid: "not-stored" })).toEqual([]);
  });
  it("indexes current businesses by exact UID without sharing origin bookkeeping or other owners", async () => {
    pkmGetMetadataMock.mockResolvedValue({ ...METADATA, domains: [{ key: "professional" }] });
    pkmBlob = { professional: { businesses: { entities: {
      first: { name: "Example", phone: "+15555550100", _business_origin: { business_uid: "business-one" } },
      second: { name: "Example", _business_origin: { business_uid: "business-two" } },
    } } } };
    await AgentPkmContextStore.load({ userId: "user_1", vaultKey: "test-key", vaultOwnerToken: "test-token" });
    const entries = AgentPkmContextStore.findBusinessReconciliationCandidates({ userId: "user_1", businessUid: "business-one" });
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ entity_id: "first", domain: "professional", entity_scope: "businesses" });
    expect(JSON.parse(entries[0]!.message)).toEqual({ name: "Example", phone: "+15555550100" });
    expect(JSON.stringify(entries)).not.toContain("business-one");
    expect(AgentPkmContextStore.findBusinessReconciliationCandidates({ userId: "user_1", businessUid: "unmatched" })).toEqual([]);
    expect(() => AgentPkmContextStore.findBusinessReconciliationCandidates({ userId: "other-owner", businessUid: "business-one" })).toThrow();
    clearAgentPkmContext();
    expect(() => AgentPkmContextStore.findBusinessReconciliationCandidates({ userId: "user_1", businessUid: "business-one" })).toThrow();
  });
  beforeEach(() => {
    publishValidatedAuthSessionPrincipal({ firebaseUid: "user_1", ownerId: "user_1", accountGeneration: 0 });
    vi.clearAllMocks();
    clearAgentPkmContext();
    peekLiveMirrorMock.mockReset().mockReturnValue(null);
    pkmPeekMock.mockReset().mockReturnValue(null);
    pkmGetStaleFirstMock.mockReset().mockResolvedValue({ data: { markdown: "# Soul.md\n\n## Preferences\n- concise summaries\n" } });
    pkmGetMetadataMock.mockResolvedValue(METADATA);
    pkmBlob = {
      preferences: {
        writing: {
          default_style: "concise summaries",
        },
      },
    };
    pkmGetManyStaleFirstMock.mockImplementation(async ({ domains }: { domains: string[] }) => ({
      snapshots: Object.fromEntries(
        domains
          .filter((domain) => pkmBlob[domain])
          .map((domain) => [domain, { data: pkmBlob[domain] }]),
      ),
      failedDomains: [],
    }));
    pkmSavePreparedDomainMock.mockResolvedValue({
      success: true,
      saveState: "saved",
      message: "Saved",
      fullBlob: {},
    });
    pkmSaveMergedDomainMock.mockResolvedValue({
      success: true,
      saveState: "saved",
      message: "Saved",
      fullBlob: {},
    });
  });

  it("finds origin-bearing businesses across scopes without starving existing personal details", async () => {
    pkmGetMetadataMock.mockResolvedValue({ ...METADATA, domains: [{ key: "professional" }] });
    pkmBlob = { professional: {
      profile: { entities: { known: { name: "Example Company", _business_origin: { business_uid: "known-business" } } } },
      businesses: { entities: Object.fromEntries(Array.from({ length: 12 }, (_, index) => [`business${index}`, {
        name: `Unrelated Company ${index}`, _business_origin: { business_uid: `uid${index}` },
      }])) },
      education: { entities: { school: { summary: "Alex studied mathematics at Example School." } } },
    } };
    await AgentPkmContextStore.load({ userId: "user_1", vaultKey: "test-key", vaultOwnerToken: "test-token", forceRefresh: true });
    const stored = AgentPkmContextStore.findBusinessReconciliationCandidates({ userId: "user_1", businessUid: "known-business" });
    expect(stored[0]?.entity_scope).toBe("profile");
    const personal = AgentPkmContextStore.findProfileReconciliationCandidates({ userId: "user_1", text: "Alex studied mathematics at Example School." });
    expect(personal.some(candidate => candidate.entity_id === "school")).toBe(true);
    expect(personal).toHaveLength(2); // Relevant company + school; unrelated companies cannot crowd them out.
    expect(JSON.stringify(personal)).not.toContain("business_uid");
    const target = AgentPkmContextStore.profileBusinessTarget("user_1", { card_id: "test", source_text: "A detail",
      target_domain: "professional", candidate_payload: { notes: { entities: { known: { summary: "A detail" } } } },
      merge_decision: { merge_mode: "extend_entity", target_entity_path: "profile.entities.known" } }, "professional");
    expect(target?.businessUid).toBe("known-business");
  });

  it("rechecks origin at a retargeted destination inside the public-profile writer", async () => {
    pkmSavePreparedDomainMock.mockImplementation(async (input: { build: (context: { currentDomainData: Record<string, unknown> }) => Promise<unknown> }) => {
      await input.build({ currentDomainData: { profile: { entities: { known: { _business_origin: { business_uid: "existing-business" } } } } } });
      return { success: true, dataVersion: 2, fullBlob: {} };
    });
    const result = await addToPKM({ userId: "user_1", vaultKey: "test-key", vaultOwnerToken: "test-token",
      sourceMessage: "A company detail", source: "profile_research_review", confirmation: { confirmedByUser: true, surface: "chat" },
      cards: [{ card_id: "test", source_text: "A company detail", write_mode: "confirm_first", target_domain: "professional",
        candidate_payload: { notes: { entities: { known: { summary: "A company detail" } } } },
        merge_decision: { merge_mode: "extend_entity", target_entity_path: "profile.entities.known" } }] });
    expect(result.saved).toBe(0); expect(result.results[0]?.message).toContain("identity review");
    await expect(addToPKM({ userId: "user_1", vaultKey: "test-key", vaultOwnerToken: "test-token",
      sourceMessage: "A company detail", source: "profile_research_review", confirmation: { confirmedByUser: true, surface: "chat" },
      cards: [{ card_id: "bad-target", source_text: "A company detail", write_mode: "confirm_first", target_domain: "professional",
        candidate_payload: { notes: { entities: { known: { summary: "A company detail" } } } },
        merge_decision: { merge_mode: "create_entity", target_entity_path: "profile.entities.known.details" } }] })).rejects.toThrow("destination");
  });

  it("keeps one reviewed inventory through a concurrent PKM change, without rebinding business identity", async () => {
    pkmGetMetadataMock.mockResolvedValue({ ...METADATA, domains: [{ key: "professional" }] });
    const entity = (uid: string) => ({ businesses: { entities: { chosen: {
      summary: "Example Company", _business_origin: { business_uid: uid },
    } } } });
    pkmBlob = { professional: entity("business-A") };
    const personal: AgentPkmPreviewCard = { card_id: "personal", source_text: "I studied mathematics.",
      write_mode: "can_save", target_domain: "professional",
      candidate_payload: { education: { entities: { school: { summary: "I studied mathematics." } } } },
      merge_decision: { merge_mode: "create_entity", target_entity_path: "education.entities.school" } };
    const business: AgentPkmPreviewCard = { card_id: "business", source_text: "Example Company",
      write_mode: "can_save", target_domain: "professional",
      candidate_payload: { businesses: { entities: { chosen: { summary: "Example Company" } } } },
      merge_decision: { merge_mode: "extend_entity", target_entity_path: "businesses.entities.chosen" } };
    prepareNaturalLanguageMock.mockImplementation(async (input) => {
      window.dispatchEvent(new CustomEvent("pkm-domain-changed", { detail: { userId: "user_1" } }));
      expect(input.findDuplicate("Example Company")?.kind).toBe("exact");
      expect(input.findReconciliationCandidates("Example Company")).toHaveLength(1);
      // A subsequent authoritative refresh has a different UID at the same path.
      pkmBlob = { professional: entity("business-B") };
      await AgentPkmContextStore.load({ userId: "user_1", vaultKey: "test-key", vaultOwnerToken: "test-token", forceRefresh: true });
      return { cards: [personal, business], sourceCoverage: [] };
    });
    const review = await prepareProfileReview({ userId: "user_1", vaultKey: "test-key",
      vaultOwnerToken: "test-token", isCurrent: () => true, assertCurrent: async () => {} },
      "I studied mathematics. Example Company");
    expect(review.origins.has("personal")).toBe(false);
    expect(review.origins.get("business")).toEqual({ businessUid: "business-A" });
    pkmSavePreparedDomainMock.mockImplementation(async (input) => {
      await input.build({ currentDomainData: pkmBlob.professional });
      return { success: true, dataVersion: 2, fullBlob: {} };
    });
    const save = (card: AgentPkmPreviewCard) => addToPKM({ userId: "user_1", vaultKey: "test-key",
      vaultOwnerToken: "test-token", source: "profile_research_review", sourceMessage: review.message,
      businessOrigin: review.origins.get(card.card_id), cards: [card],
      confirmation: { confirmedByUser: true, surface: "chat" } });
    expect((await save(review.cards[0]!)).saved).toBe(1);
    const rejected = await save(review.cards[1]!);
    expect(rejected.saved).toBe(0);
    expect(rejected.results[0]?.message).toContain("different or unidentified");
    pkmBlob = { professional: entity("business-A") };
    expect((await save(review.cards[1]!)).saved).toBe(1);
  });

  it("never captures another owner's or incomplete inventory, and revokes the review witness on vault expiry", async () => {
    const params = { userId: "user_1", vaultKey: "test-key", vaultOwnerToken: "test-token", forceRefresh: true };
    pkmGetManyStaleFirstMock.mockResolvedValueOnce({ snapshots: {}, failedDomains: ["preferences"] });
    await AgentPkmContextStore.load(params);
    expect(() => AgentPkmContextStore.captureProfileReviewInventory("user_1")).toThrow("could not be checked");
    await AgentPkmContextStore.load(params);
    expect(() => AgentPkmContextStore.captureProfileReviewInventory("other-owner")).toThrow("could not be checked");
    const inventory = AgentPkmContextStore.captureProfileReviewInventory("user_1");
    advanceVaultSessionEpoch();
    expect(() => inventory.findLocalDuplicate("concise summaries")).toThrow("Unlock your vault");
    expect(() => inventory.findReconciliationCandidates("concise summaries")).toThrow("Unlock your vault");
    expect(() => inventory.businessTarget({ card_id: "expired", source_text: "" }, "preferences")).toThrow("Unlock your vault");
  });

  it.each(["deleted", "moved", "inactive"])("does not resurrect a %s business from a pinned profile review", async (change) => {
    const business = { summary: "Example Company", status: "active", _business_origin: { business_uid: "business-A" } };
    const current = change === "deleted" ? {} : change === "moved"
      ? { businesses: { entities: { relocated: business } } }
      : { businesses: { entities: { chosen: { ...business, status: "deleted" } } } };
    pkmSavePreparedDomainMock.mockImplementation(async (input) => {
      await input.build({ currentDomainData: current });
      return { success: true, dataVersion: 2, fullBlob: {} };
    });
    const result = await addToPKM({ userId: "user_1", vaultKey: "test-key", vaultOwnerToken: "test-token",
      sourceMessage: "Example Company", source: "profile_research_review", businessOrigin: { businessUid: "business-A" },
      confirmation: { confirmedByUser: true, surface: "chat" },
      cards: [{ card_id: "business", source_text: "Example Company", write_mode: "can_save", target_domain: "professional",
        candidate_payload: { businesses: { entities: { chosen: business } } },
        merge_decision: { merge_mode: "extend_entity", target_entity_path: "businesses.entities.chosen" } }] });
    expect(result.saved).toBe(0);
    expect(result.results[0]?.message).toContain(change === "moved" ? "another destination" : "saved business changed");
    expect(pkmSaveMergedDomainMock).not.toHaveBeenCalled();
  });

  afterEach(() => {
    publishValidatedAuthSessionPrincipal(null);
    vi.useRealTimers();
  });

  it("fences business identity at the conflict-aware writer, not only in the popup", async () => {
    const entity = (uid: string) => ({ businesses: { entities: { chosen: { summary: "Synthetic business",
      _business_origin: { business_uid: uid } } } } });
    const reviewed: AgentPkmPreviewCard = { card_id: "business", source_text: "Synthetic business", write_mode: "can_save",
      target_domain: "professional", target_entity_scope: "businesses", target_entity_id: "chosen",
      candidate_payload: entity("business-A"), structure_decision: { target_domain: "professional" },
      merge_decision: { merge_mode: "extend_entity", target_entity_path: "businesses.entities.chosen" } };
    let existing = entity("business-A");
    pkmSavePreparedDomainMock.mockImplementation(async (input: { build: (context: { currentDomainData: Record<string, unknown> }) => Promise<unknown> }) => {
      await input.build({ currentDomainData: existing });
      return { success: true, dataVersion: 1, fullBlob: {} };
    });
    const save = () => addToPKM({ userId: "user_1", vaultKey: "test-key", vaultOwnerToken: "test-token",
      sourceMessage: "Synthetic business", source: "business_profile_review", businessOrigin: { businessUid: "business-A" },
      confirmation: { confirmedByUser: true, surface: "chat", source: "business_profile_review" },
      batchSimpleDomainExtensions: true, cards: [reviewed] });
    expect((await save()).saved).toBe(1);
    existing = entity("business-B");
    const rejected = await save();
    expect(rejected.saved).toBe(0);
    expect(rejected.results[0]?.message).toContain("different or unidentified");
    expect(pkmSaveMergedDomainMock).not.toHaveBeenCalled();
    await expect(addToPKM({ userId: "user_1", vaultKey: "test-key", vaultOwnerToken: "test-token",
      sourceMessage: "Synthetic business", source: "business_profile_review", cards: [reviewed] })).rejects.toThrow("Business identity");
  });

  it("keeps sharing and uncertain cards in review while exposing only private can-save cards", () => {
    const cards: AgentPkmPreviewCard[] = [
      { card_id: "auto", source_text: "", write_mode: "can_save" },
      { card_id: "incomplete", source_text: "", write_mode: "can_save", preparation_requires_review: true },
      {
        card_id: "shared",
        source_text: "",
        write_mode: "can_save",
        sharing_impact: {
          active_recipient_count: 1,
          recipient_labels: ["Advisor"],
          enters_next_export_revision: true,
          summary: "One recipient is affected.",
          affected_grant_ids: ["grant"],
          affected_export_ids: ["export"],
        },
      },
      { card_id: "review", source_text: "", write_mode: "confirm_first" },
    ];

    expect(getPkmAutoSaveCards(cards).map((card) => card.card_id)).toEqual(["auto"]);
    expect(getPkmConfirmationCards(cards).map((card) => card.card_id)).toEqual([
      "shared",
      "review",
    ]);
  });

  it("keeps degraded previews out of automatic writes", () => {
    const cards: AgentPkmPreviewCard[] = [
      { card_id: "verified", source_text: "", write_mode: "can_save" },
      {
        card_id: "degraded",
        source_text: "",
        write_mode: "can_save",
        preview_degraded: true,
      },
    ];

    expect(getPkmAutoSaveCards(cards).map((card) => card.card_id)).toEqual(["verified"]);
  });

  it("rejects a degraded preview even when a caller supplies explicit confirmation", async () => {
    const result = await addToPKM({
      userId: "user_1",
      sourceMessage: "I prefer tea.",
      vaultKey: "test-key",
      vaultOwnerToken: "test-token",
      confirmation: { confirmedByUser: true, surface: "web", source: "test" },
      cards: [{
        card_id: "degraded",
        source_text: "I prefer tea.",
        write_mode: "can_save",
        preview_degraded: true,
        target_domain: "preferences",
        candidate_payload: { drink: "tea" },
        structure_decision: { target_domain: "preferences" },
      }],
    });

    expect(result).toMatchObject({ saved: 0, failed: 1 });
    expect(result.results[0]?.message).toContain("prepared again");
    expect(pkmSavePreparedDomainMock).not.toHaveBeenCalled();
    expect(pkmSaveMergedDomainMock).not.toHaveBeenCalled();
  });

  it("rechecks token expiry without requiring a React render", () => {
    vi.useFakeTimers();
    const state = { authLoading: false, sessionVerificationRequired: false, isVaultUnlocked: true,
      vaultOwnerToken: "test-token", tokenExpiresAt: Date.now() + 100 };
    expect(isAgentPkmProcessingReady(state, "test-token")).toBe(true);
    expect(isAgentPkmProcessingReady({ ...state, vaultOwnerToken: "replacement" }, "test-token")).toBe(false);
    vi.advanceTimersByTime(100);
    expect(isAgentPkmProcessingReady(state, "test-token")).toBe(false);
    expect(isAgentPkmProcessingReady({ ...state, tokenExpiresAt: null }, "test-token")).toBe(false);
  });

  it.each(["owner", "product"])("rejects a direct %s automatic write with incomplete coverage but retains explicit manual review", async (mode) => {
    const card: AgentPkmPreviewCard = {
      card_id: "incomplete", source_text: "I prefer tea.", write_mode: "can_save",
      preparation_requires_review: true, target_domain: "preferences",
      candidate_payload: { drink: "tea" }, structure_decision: { target_domain: "preferences" },
    };
    const params = { userId: "user_1", cards: [card], sourceMessage: "I prefer tea. I prefer warm rooms.",
      vaultKey: "test-key", vaultOwnerToken: "test-token", source: "test" };
    const automatic = await addToPKM({ ...params, confirmation: mode === "owner" ? {
      authorizationMode: "owner_auto_save_policy", surface: "chat", source: "test",
      autoSavePolicyVersion: 1, autoSavePolicyEnabledAt: "2026-09-18T00:00:00Z",
    } : {
      authorizationMode: "product_default_auto_save_policy", surface: "chat",
      source: "agent_chat_product_default_auto_save", autoSavePolicyVersion: 1,
      productDefaultEffectiveAt: "2026-09-18T00:00:00Z",
    } });
    expect(automatic).toMatchObject({ saved: 0, failed: 1 });
    expect(pkmSavePreparedDomainMock).not.toHaveBeenCalled();
    expect(pkmSaveMergedDomainMock).not.toHaveBeenCalled();
    const reviewed = await addToPKM({ ...params, confirmation: {
      confirmedByUser: true, surface: "web", source: "test",
    } });
    expect(reviewed).toMatchObject({ saved: 1, failed: 0 });
    expect(pkmSavePreparedDomainMock).toHaveBeenCalledTimes(1);
    expect(card.write_mode).toBe("can_save");
  });

  it("keeps a saved Soul.md edit available to the next chat without another network read", async () => {
    pkmSavePreparedDomainMock.mockImplementationOnce(async (params) => {
      await params.build({ currentDomainData: { markdown: "# Memory\n" } });
      return { success: true };
    });
    const edited = "# Soul\n\n- A corrected personal preference.\n";
    await replaceMarkdownMemoryDocument({ userId: "user_1", vaultKey: "key", vaultOwnerToken: "token",
      markdown: edited, expectedMarkdown: "# Memory\n", expectedPersisted: true, beforeEffect: async () => {} });
    clearAgentPkmContext("user_1", { preserveMarkdown: true });
    const context = await loadAgentPkmContext({ userId: "user_1", vaultKey: "key", vaultOwnerToken: "token", requireDecrypted: true });
    expect(context.text).toBe(edited);
    expect(peekMarkdownMemory("user_1")?.persisted).toBe(true);
    expect(pkmGetMetadataMock).not.toHaveBeenCalled();
    expect(pkmGetManyStaleFirstMock).not.toHaveBeenCalled();
    clearAgentPkmContext("user_1");
    expect(peekMarkdownMemory("user_1")).toBeNull();
  });

  it("loads decrypted session PKM when the vault key is available", async () => {
    const context = await loadLegacyPkmContext({
      userId: "user_1",
      vaultOwnerToken: "vault_token",
      vaultKey: "vault_key",
      message: "what do you know about my writing preferences",
    });

    expect(context.source).toBe("decrypted_session_pkm");
    expect(context.text).toContain("Source: decrypted locally");
    expect(context.text).toContain("agent-safe-pkm/v1");
    expect(context.text).toContain("concise summaries");
    expect(context.coverage).toMatchObject({
      totalFactCount: 1,
      matchedFactCount: 1,
      selectedFactCount: 1,
      inventoryOnly: false,
      budgetChars: 12000,
    });
    expect(pkmGetManyStaleFirstMock).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "user_1",
        vaultKey: "vault_key",
        vaultOwnerToken: "vault_token",
      })
    );
  });

  it("fails closed for a recall turn when Soul.md is temporarily unavailable", async () => {
    pkmGetStaleFirstMock.mockRejectedValue(new Error("Soul temporarily unavailable"));

    await expect(
      loadAgentPkmContext({
        userId: "user_1",
        vaultOwnerToken: "vault_token",
        vaultKey: "vault_key",
        message: "where do I study?",
        requireDecrypted: true,
      }),
    ).rejects.toThrow("private memory could not be loaded");

    expect(peekAgentPkmContext({ userId: "user_1", message: "where do I study?" })).toBeNull();
  });

  it("waits for the complete agent-safe batch before publishing a packet", async () => {
    const context = await loadLegacyPkmContext({
      userId: "user_1",
      vaultOwnerToken: "vault_token",
      vaultKey: "vault_key",
      message: "what do you know about my writing preferences",
    });

    expect(context.text).toContain("concise summaries");
    expect(pkmGetManyStaleFirstMock).toHaveBeenCalledWith(
      expect.objectContaining({ forceRefresh: false, backgroundRefresh: false }),
    );
  });

  it("loads the full agent-safe profile for a KYC lookup", async () => {
    pkmBlob = {
      preferences: { writing: { default_style: "concise summaries" } },
      identity: { identity_profile: { full_name: "Test Person", declared_age: "23" } },
    };
    pkmGetMetadataMock.mockResolvedValue({
      ...METADATA,
      domains: [...METADATA.domains, { ...METADATA.domains[0], key: "identity", displayName: "Identity" }],
    });
    const context = await loadLegacyPkmContext({
      userId: "user_1",
      vaultOwnerToken: "vault_token",
      vaultKey: "vault_key",
      message: "Find my legal name and age for this KYC request",
    });

    expect(pkmGetManyStaleFirstMock).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "user_1",
        domains: ["preferences", "identity"],
      }),
    );
    expect(context.text).toContain("Test Person");
    expect(context.text).toContain("concise summaries");
  });

  it("reuses the same full packet for unrelated requests", async () => {
    const params = {
      userId: "user_1",
      vaultOwnerToken: "vault_token",
      vaultKey: "vault_key",
      message: "Find my legal name and age for this KYC request",
    };

    const first = await loadLegacyPkmContext(params);
    const second = await loadLegacyPkmContext({ ...params, message: "What writing style do I prefer?" });

    expect(first.text).toBe(second.text);
    expect(pkmGetManyStaleFirstMock).toHaveBeenCalledTimes(1);
  });

  it("checks duplicates only against an already-unlocked local inventory", async () => {
    expect(
      AgentPkmContextStore.findLocalDuplicate({
        userId: "user_1",
        candidate: "concise summaries",
      })
    ).toBeNull();

    await loadLegacyPkmContext({
      userId: "user_1",
      vaultKey: "test-vault-key",
      vaultOwnerToken: "owner-token",
      message: "preferences",
    });

    expect(
      AgentPkmContextStore.findLocalDuplicate({
        userId: "user_1",
        candidate: "concise summaries",
      })
    ).toMatchObject({ kind: "exact", domain: "preferences" });
  });

  it("offers the merge agent the owner's related existing details, so a changed fact updates", async () => {
    // 2026-09-29: the product never sent existing details, so 97 of 97 live
    // cards were create_entity and a promotion would have stored a second role.
    pkmBlob = {
      ...pkmBlob,
      professional: {
        profile: { entities: {
          role_senior: { entity_id: "role_senior", summary: "Senior Platform Engineer at Example Labs since March 2024." },
          commute: { entity_id: "commute", summary: "Commutes by bike most days." },
        } },
      },
    };
    pkmGetMetadataMock.mockResolvedValue({
      ...METADATA,
      domains: [...METADATA.domains, { ...METADATA.domains[0], key: "professional", displayName: "Professional" }],
    });
    const passage = "## Current role\n- Staff Platform Engineer at Example Labs, promoted in September 2026";
    expect(AgentPkmContextStore.findReconciliationCandidates({ userId: "user_1", text: passage })).toEqual([]);
    await loadLegacyPkmContext({ userId: "user_1", vaultKey: "k", vaultOwnerToken: "t", message: "role" });
    const candidates = AgentPkmContextStore.findReconciliationCandidates({ userId: "user_1", text: passage });
    expect(candidates).toEqual([{
      domain: "professional", entity_id: "role_senior", entity_scope: "profile",
      message: "Senior Platform Engineer at Example Labs since March 2024.", active: true,
    }]);

    apiFetchMock.mockResolvedValue({ ok: true, json: async () => ({ agent_id: "a", agent_name: "A", model: "m", used_fallback: false, preview_cards: [] }) });
    await previewAgentPkmMemory({
      userId: "user_1", vaultOwnerToken: "t", message: passage, currentDomains: ["professional"],
      reconciliationCandidates: candidates,
    });
    const body = JSON.parse(apiFetchMock.mock.calls.at(-1)![1].body as string);
    expect(body.simulated_state).toEqual({ memories: candidates });
  });

  it("forwards the whole bounded Soul snapshot without expanding the general candidate limit", async () => {
    apiFetchMock.mockResolvedValue({ ok: true, json: async () => ({ agent_id: "a", agent_name: "A", model: "m", used_fallback: false, preview_cards: [] }) });
    const candidates = Array.from({ length: 24 }, (_, index) => ({ domain: "one_memory", entity_scope: "markdown",
      entity_id: `soul_${index}`, message: `Synthetic fact ${index}.`, active: true }));
    await previewAgentPkmMemory({ userId: "user_1", vaultOwnerToken: "t", message: "My brother likes tea.", currentDomains: ["one_memory"],
      memoryProfile: "soul_markdown_v1", reconciliationCandidates: candidates });
    const body = JSON.parse(apiFetchMock.mock.calls.at(-1)![1].body as string);
    expect(body.memory_profile).toBe("soul_markdown_v1");
    expect(body.simulated_state.memories).toEqual(candidates);
    await previewAgentPkmMemory({ userId: "user_1", vaultOwnerToken: "t", message: "My brother likes tea.", currentDomains: [], reconciliationCandidates: candidates });
    expect(JSON.parse(apiFetchMock.mock.calls.at(-1)![1].body as string).simulated_state.memories).toHaveLength(10);
    apiFetchMock.mockClear();
    await expect(previewAgentPkmMemory({ userId: "user_1", vaultOwnerToken: "t", message: "Fact", currentDomains: ["one_memory"],
      memoryProfile: "soul_markdown_v1", reconciliationCandidates: Array(257).fill(candidates[0]) })).rejects.toThrow("bound");
    expect(apiFetchMock).not.toHaveBeenCalled();
  });

  it("sends a memory proposal holding placeholders only, and refuses a raw secret (negative control)", async () => {
    apiFetchMock.mockResolvedValue({ ok: true, json: async () => ({ agent_id: "a", agent_name: "A", model: "m", used_fallback: false, preview_cards: [] }) });
    const [guarded] = planSecretCaptures([SECRET_PASSAGE]).render();
    await previewAgentPkmMemory({ userId: "user_1", vaultOwnerToken: "t", message: guarded!, currentDomains: ["identity"] });
    const body = apiFetchMock.mock.calls.at(-1)![1].body as string;
    for (const value of FAKE_VALUES) expect(body).not.toContain(value);
    expect(body.match(/⟦secret:sec_[0-9a-f]{16} /g)).toHaveLength(4);

    apiFetchMock.mockClear();
    await expect(previewAgentPkmMemory({
      userId: "user_1", vaultOwnerToken: "t", message: SECRET_PASSAGE, currentDomains: ["identity"],
    })).rejects.toBeInstanceOf(UnguardedSecretError);
    expect(apiFetchMock).not.toHaveBeenCalled();
  });

  it("names Secrets, cards and identity documents to One by label only", async () => {
    pkmBlob = {
      ...pkmBlob,
      secrets: { items: { sec_00000000000000a1: { label: "openai API key ending 9f2a", kind: "credential", value: FAKE_API_KEY } } },
      wallet: {
        summary: { card_1: { nickname: "Travel", brand: "visa", last4: "1111", expiry_month: 4, expiry_year: 2030, issuing_region: "US" } },
        secrets: { card_1: { pan: FAKE_CARD, cvv: "123" } },
      },
      identity: {
        full_name: "Synthetic Person",
        identity_documents: {
          doc_1: { document_type: "passport", label: "Passport ending 4567", number: FAKE_PASSPORT },
          entities: {
            mem_1: { summary: `passport number ${FAKE_PASSPORT} renewed in 2026` },
            mem_2: { label: "Passport renewal", summary: `passport ${FAKE_PASSPORT} renewed this year` },
          },
        },
      },
      notes: { legacy: { owner_note: `bank password is ${FAKE_PASSWORD}!` } },
    };
    pkmGetMetadataMock.mockResolvedValue({
      ...METADATA,
      domains: [...METADATA.domains, ...["secrets", "wallet", "identity", "notes"].map((key) => ({ ...METADATA.domains[0], key, displayName: key }))],
    });

    const context = await loadLegacyPkmContext({ userId: "user_1", vaultKey: "k", vaultOwnerToken: "t", message: "what do you know" });

    expect(context.text).toContain("- Secret exists: openai API key ending 9f2a");
    expect(context.text).toContain("- Secret exists: Travel, Visa card ending 1111");
    expect(context.text).toContain("- Secret exists: Passport ending 4567");
    expect(context.text).toContain("- Secret exists: Identity Documents entry");
    expect(context.text).toContain("Synthetic Person");
    expect(context.text).toContain("[hidden secret]");
    for (const value of [...FAKE_VALUES, "123", "2030"]) expect(context.text).not.toContain(value);
    expect(context.text).not.toMatch(/Expiry|Issuing Region|Document Type/);

    const candidates = AgentPkmContextStore.findReconciliationCandidates({
      userId: "user_1", text: "my passport renewal happened this year",
    });
    expect(candidates).toEqual([{
      domain: "identity", entity_id: "mem_2", entity_scope: "identity_documents",
      message: "Secret exists: Passport renewal", active: true,
    }]);
    expect(JSON.stringify(candidates)).not.toContain(FAKE_PASSPORT);
  });

  it("returns the full agent-safe packet regardless of prompt wording", async () => {
    const context = await loadLegacyPkmContext({
      userId: "user_1",
      vaultOwnerToken: "vault_token",
      vaultKey: "vault_key",
      message: "list down a summary of my memory",
    });

    expect(context.source).toBe("decrypted_session_pkm");
    expect(context.mode).toBe("full");
    expect(context.text).toContain("concise summaries");
    expect(context.coverage).toMatchObject({ inventoryOnly: false, selectedFactCount: 1 });
  });

  it("marks an oversized full packet incomplete instead of silently truncating a fact", async () => {
    pkmBlob = { preferences: { writing: { long_note: "x".repeat(2_500) } } };

    const context = await loadLegacyPkmContext({
      userId: "user_1",
      vaultOwnerToken: "vault_token",
      vaultKey: "vault_key",
      maxChars: 2_000,
    });

    expect(context.coverage).toMatchObject({
      totalFactCount: 1,
      selectedFactCount: 0,
      omittedFactCount: 1,
      clipped: true,
    });
    expect(context.text).toContain("omitted because of the 2000-character packet limit");
    expect(context.text).not.toContain("x".repeat(200));
  });

  it("keeps a small sensitive domain in the owner's packet when a large domain overflows the budget", async () => {
    // Regression (2026-09-27): 9,049 facts, 88 sent, Health absent, because the
    // budget filled alphabetically and imported transactions came first.
    pkmBlob = {
      financial: {
        budget: { dining_out_monthly: "400 dollars" },
        transactions: Array.from({ length: 600 }, (_, index) => ({
          merchant: `Merchant ${index}`,
          amount: `${index}.00`,
        })),
      },
      health: { allergies: { medication: "penicillin" } },
    };
    pkmGetMetadataMock.mockResolvedValue({
      ...METADATA,
      domains: [
        { ...METADATA.domains[0], key: "financial", displayName: "Financial" },
        { ...METADATA.domains[0], key: "health", displayName: "Health" },
      ],
    });

    const context = await loadLegacyPkmContext({
      userId: "user_1",
      vaultOwnerToken: "vault_token",
      vaultKey: "vault_key",
      message: "am I allergic to anything?",
    });

    expect(context.coverage.clipped).toBe(true);
    expect(context.text.length).toBeLessThanOrEqual(12_000);
    expect(context.text).toContain("penicillin");
    expect(context.text).toContain("400 dollars");
  });

  it("puts the device-computed spending totals ahead of a clipped transaction sample", async () => {
    // Regression (2026-09-27): with thousands of imported transactions the
    // round-robin never reached a monthly_cash_flow row, so a spending answer
    // could only sum whichever raw rows happened to fit the budget. The raw rows
    // come first here, as Plaid's first assemble writes them, and outnumber the
    // inventory cap on their own.
    const itemIds = Array.from({ length: 400 }, (_, index) => `plaid-item-${index}`);
    const fact = <T,>(value: T) => ({ value, computed_at: "2026-09-27T00:00:00Z", source_item_ids: itemIds });
    const months = Array.from({ length: 12 }, (_, index) => ({
      month: `2025-${String(index + 1).padStart(2, "0")}`,
      income: 5000,
      spend: 3000 + index,
      net: 2000 - index,
    }));
    pkmBlob = {
      financial: {
        transactions_v1: Object.fromEntries(
          Array.from({ length: 3000 }, (_, index) => [
            `txn${index}`,
            { amount: 12.5 + index, date: "2026-09-01", merchant_name: `Merchant ${index}`, category_primary: "FOOD_AND_DRINK" },
          ]),
        ),
        derived_v1: {
          schema: "plaid-derived-v1",
          computed_at: "2026-09-27T00:00:00Z",
          net_worth: fact(84000),
          cash_flow_trend: fact("positive"),
          monthly_cash_flow: fact(months),
          recurring_bills: fact([
            { label: "Streaming", category: "ENTERTAINMENT", cadence: "monthly", typical_amount: 15.49, occurrences: 6, last_date: "2026-09-01" },
          ]),
        },
      },
    };
    pkmGetMetadataMock.mockResolvedValue({
      ...METADATA,
      domains: [{ ...METADATA.domains[0], key: "financial", displayName: "Financial" }],
    });

    const context = await loadLegacyPkmContext({
      userId: "user_1",
      vaultOwnerToken: "vault_token",
      vaultKey: "vault_key",
    });

    expect(context.coverage.clipped).toBe(true);
    expect(context.text.length).toBeLessThanOrEqual(12_000);
    // Every month is one line, so its income and spend read together.
    for (const row of months) {
      expect(context.text).toContain(
        `- Financial > Derived V1 > Monthly Cash Flow > Value: Month: ${row.month}; Income: 5000; Spend: ${row.spend}; Net: ${row.net}`,
      );
    }
    expect(context.text).toContain("Recurring Bills > Value: Label: Streaming; Category: ENTERTAINMENT");
    expect(context.text).toContain("Financial > Derived V1 > Net Worth > Value: 84000");
    // Provenance ids are budget noise, not facts.
    expect(context.text).not.toContain("plaid-item-");
    // The raw sample still fills the rest of the budget.
    expect(context.text).toContain("Transactions V1");
  });

  it("reads only closed communication settings beside Soul, excluding identity records from prompts", async () => {
    pkmGetStaleFirstMock.mockImplementation(async ({ domain }) => domain === "identity"
      ? { data: { communication_preferences: { tone: "direct", length: "short", unexpected: "discard" }, identity_profile: { legal_name: "private identity" } } }
      : { data: { markdown: "# Soul.md\n- A synthetic preference.\n" } });
    const context = await loadAgentPkmContext({ userId: "user_1", vaultKey: "key", vaultOwnerToken: "token", requireDecrypted: true });
    expect(context.communicationPreferences).toEqual({ tone: "direct", length: "short" });
    expect(context.text).not.toContain("private identity");
    expect(context.text).not.toContain("short");
    expect(context.domains).toEqual(["one_memory"]);
    expect(pkmGetManyStaleFirstMock).not.toHaveBeenCalled();
  });

  it.each(["read_only", "preparation_only", "bounded_mutation", "mutation_authorized"] as const)("retains Soul reads and admits recovery only for authorized mutations: %s", async reviewerMutationPolicy => {
    window.__HUSHH_NATIVE_TEST__ = { enabled: true, autoReviewerLogin: true, reviewerMutationPolicy };
    const recovery = vi.spyOn(markdownMemory, "recoverMarkdownMemorySync").mockResolvedValue(undefined);
    try {
      const context = await loadAgentPkmContext({ userId: "user_1", vaultKey: "key", vaultOwnerToken: "token", requireDecrypted: true });
      expect(context.domains).toEqual(["one_memory"]);
      expect(context.text).toContain("concise summaries");
      expect(recovery).toHaveBeenCalledTimes(reviewerMutationPolicy === "mutation_authorized" ? 1 : 0);
    } finally { recovery.mockRestore(); delete window.__HUSHH_NATIVE_TEST__; }
  });

  it("warms only Soul.md into browser RAM after unlock", async () => {
    await warmAgentPkmContext({
      userId: "user_1",
      vaultOwnerToken: "vault_token",
      vaultKey: "vault_key",
    });

    expect(pkmGetMetadataMock).not.toHaveBeenCalled();
    expect(pkmGetManyStaleFirstMock).not.toHaveBeenCalled();
    expect(pkmGetStaleFirstMock.mock.calls.filter(([params]) => params.domain === "one_memory")).toHaveLength(1);
    const packet = peekAgentPkmContext({ userId: "user_1", message: "unrelated request" });
    expect(packet?.text).not.toContain("agent-safe-pkm/v1");
    expect(packet?.text).toContain("concise summaries");
  });

  it("reuses the decrypted Soul document throughout the unlocked session without a TTL cloud read", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-20T12:00:00Z"));
    await loadAgentPkmContext({
      userId: "user_1",
      vaultOwnerToken: "vault_token",
      vaultKey: "vault_key",
      message: "summarize my memory",
    });

    vi.setSystemTime(new Date("2026-07-20T12:06:00Z"));
    expect(
      peekAgentPkmContext({ userId: "user_1", message: "summarize my memory" })?.text,
    ).toContain("concise summaries");

    const firstRefresh = loadAgentPkmContext({
      userId: "user_1",
      vaultOwnerToken: "vault_token",
      vaultKey: "vault_key",
      message: "summarize my memory",
    });
    const secondRefresh = loadAgentPkmContext({
      userId: "user_1",
      vaultOwnerToken: "vault_token",
      vaultKey: "vault_key",
      message: "what do you know about my writing",
    });

    expect(pkmGetMetadataMock).not.toHaveBeenCalled();
    await expect(Promise.all([firstRefresh, secondRefresh])).resolves.toHaveLength(2);
    expect(pkmGetManyStaleFirstMock).not.toHaveBeenCalled();
    expect(pkmGetStaleFirstMock.mock.calls.filter(([params]) => params.domain === "one_memory")).toHaveLength(1);
  });

  it("supplies Soul, then only the owner's allowlisted Live Mirror packet, on the peek and load paths", async () => {
    const settings = { preferred_name: "STYLE_ONLY_CANARY", tone: "executive" };
    const read = pkmGetStaleFirstMock.getMockImplementation()!;
    pkmGetStaleFirstMock.mockImplementation((params) => params.domain === "identity"
      ? Promise.resolve({ data: { communication_preferences: settings } }) : read(params));
    pkmPeekMock.mockImplementation(({ domain }) => domain === "identity"
      ? { data: { data: { communication_preferences: settings } } } : null);
    // Without a mirror the context is exactly Soul, as before.
    const soul = (await loadAgentPkmContext({ userId: "user_1", vaultOwnerToken: "vault_token", vaultKey: "vault_key" })).text;
    expect(soul).toContain("- concise summaries");
    peekLiveMirrorMock.mockImplementation((userId: string) => liveMirrorView(userId, snapshotVaultSessionEpoch()));
    const loaded = await loadAgentPkmContext({ userId: "user_1", vaultOwnerToken: "vault_token", vaultKey: "vault_key" });
    const peeked = peekAgentPkmContext({ userId: "user_1" });

    for (const context of [loaded, peeked]) {
      expect(context?.communicationPreferences).toEqual(settings);
      expect(context?.text).not.toContain("STYLE_ONLY_CANARY");
      expect(context?.text.startsWith(`${soul}\n\nLIVE MIRROR FACTS v1 (`)).toBe(true);
      expect(context?.text).toContain('name="Synthetic Owner"');
      expect(context?.text.endsWith("\nEND LIVE MIRROR FACTS")).toBe(true);
      // Debug and telemetry get counts, never the packet.
      expect(context?.liveMirror).toEqual({ shownFacts: 2, omittedFacts: 0 });
      for (const forbidden of ["ya29.SYNTH", "1990-01-01", "uid-other", "src-raw"])
        expect(context?.text).not.toContain(forbidden);
    }
    expect(peekLiveMirrorMock).toHaveBeenCalledWith("user_1");

    // Negative control: another owner's projection adds nothing to Soul.
    peekLiveMirrorMock.mockImplementation(() => liveMirrorView("user_2", snapshotVaultSessionEpoch()));
    expect(peekAgentPkmContext({ userId: "user_1" })?.text).toBe(soul);
    // A mirror fault only drops the packet; the turn keeps its Soul.
    peekLiveMirrorMock.mockImplementation(() => { throw new Error("mirror unavailable"); });
    await expect(loadAgentPkmContext({ userId: "user_1", vaultOwnerToken: "vault_token", vaultKey: "vault_key" }))
      .resolves.toMatchObject({ text: soul });
  });

  it("drops an in-flight context load when the vault session clears", async () => {
    let finish!: (value: unknown) => void;
    pkmGetStaleFirstMock.mockReturnValueOnce(new Promise(resolve => { finish = resolve; }));
    peekLiveMirrorMock.mockImplementation((userId: string) => liveMirrorView(userId, snapshotVaultSessionEpoch()));

    const pending = loadAgentPkmContext({
      userId: "user_1",
      vaultOwnerToken: "vault_token",
      vaultKey: "vault_key",
    });
    clearAgentPkmContext("user_1");
    finish({ data: { markdown: "# Soul.md\n- A private fact.\n" } });

    await expect(pending).resolves.toMatchObject({ text: "", domains: [] });
    expect(pkmGetManyStaleFirstMock).not.toHaveBeenCalled();
    expect(peekAgentPkmContext({ userId: "user_1" })).toBeNull();

    // A lock that lands while the packet is being read discards the whole
    // context, on both paths, instead of returning a prior session's facts.
    await loadAgentPkmContext({ userId: "user_1", vaultOwnerToken: "vault_token", vaultKey: "vault_key" });
    peekLiveMirrorMock.mockImplementation((userId: string) => {
      const view = liveMirrorView(userId, snapshotVaultSessionEpoch());
      advanceVaultSessionEpoch();
      return view;
    });
    expect(peekAgentPkmContext({ userId: "user_1" })).toBeNull();
    await expect(loadAgentPkmContext({ userId: "user_1", vaultOwnerToken: "vault_token", vaultKey: "vault_key" }))
      .resolves.toMatchObject({ text: "" });
  });

  it("supplies no memory or metadata when the vault key is unavailable", async () => {
    const context = await loadAgentPkmContext({
      userId: "user_1",
      vaultOwnerToken: "vault_token",
      message: "what do you know about my preferences",
    });

    expect(context.text).toBe("");
    expect(pkmGetStaleFirstMock).not.toHaveBeenCalled();
    expect(pkmGetMetadataMock).not.toHaveBeenCalled();
    expect(pkmGetManyStaleFirstMock).not.toHaveBeenCalled();
  });

  it("does not use metadata summaries even when a compatibility caller requests them", async () => {
    const context = await loadAgentPkmContext({
      userId: "user_1",
      vaultOwnerToken: "vault_token",
      vaultKey: "vault_key",
      message: "what do you know about my preferences",
      metadataOnly: true,
    });

    expect(context.text).toBe("");
    expect(pkmGetMetadataMock).not.toHaveBeenCalled();
    expect(pkmGetManyStaleFirstMock).not.toHaveBeenCalled();
  });

  it("never imports a populated specialist inventory when Soul.md is absent", async () => {
    await loadLegacyPkmContext({ userId: "user_1", vaultKey: "key", vaultOwnerToken: "token" });
    expect(AgentPkmContextStore.peek({ userId: "user_1" })?.text).toContain("concise summaries");
    expect(peekAgentPkmContext({ userId: "user_1" })).toBeNull();
    pkmGetStaleFirstMock.mockResolvedValueOnce(null);
    pkmGetMetadataMock.mockClear(); pkmGetManyStaleFirstMock.mockClear();
    const context = await loadAgentPkmContext({ userId: "user_1", vaultKey: "key", vaultOwnerToken: "token", requireDecrypted: true });
    expect(context.text).toBe("# memory.md\n\n## Facts\n\n## Preferences\n\n## Commitments\n");
    expect(context.text).not.toContain("concise summaries");
    expect(context.domains).toEqual(["one_memory"]);
    expect(pkmGetMetadataMock).not.toHaveBeenCalled();
    expect(pkmGetManyStaleFirstMock).not.toHaveBeenCalled();
    expect(pkmSavePreparedDomainMock).not.toHaveBeenCalled();
  });

  it("does not treat a malformed Soul document as absent or fall back to specialist records", async () => {
    pkmGetStaleFirstMock.mockResolvedValueOnce({ data: { markdown: null } });
    await expect(loadAgentPkmContext({ userId: "user_1", vaultKey: "key", vaultOwnerToken: "token", requireDecrypted: true }))
      .rejects.toThrow("private memory could not be loaded");
    expect(peekAgentPkmContext({ userId: "user_1" })).toBeNull();
    expect(pkmGetMetadataMock).not.toHaveBeenCalled();
    expect(pkmGetManyStaleFirstMock).not.toHaveBeenCalled();
  });

  it("never projects secrets, regulated identifiers, source artifacts, or quarantined information into One's packet", async () => {
    pkmBlob = {
      preferences: {
        writing: { default_style: "concise summaries" },
      },
      runtime_secrets: {
        llm: {
          gemini_api_key: "must-not-reach-agent-context",
          credential_mode: "byok",
        },
      },
      __quarantine_v1: {
        saved_but_never_shareable: "must-not-reach-agent-context",
      },
      identity: {
        student_id: "safe-student-id",
        passport_number: "must-not-reach-agent-context",
      },
      financial: {
        account_number: "must-not-reach-agent-context",
        portfolio_name: "long-term holdings",
      },
      source_library: {
        document_text: "must-not-reach-agent-context",
      },
    };
    pkmGetMetadataMock.mockResolvedValue({
      ...METADATA,
      domains: [
        ...METADATA.domains,
        { ...METADATA.domains[0], key: "identity", displayName: "Identity" },
        { ...METADATA.domains[0], key: "financial", displayName: "Financial" },
        { ...METADATA.domains[0], key: "source_library", displayName: "Source library" },
      ],
    });

    const context = await loadLegacyPkmContext({
      userId: "user_1",
      vaultOwnerToken: "vault_token",
      vaultKey: "vault_key",
      message: "summarize everything in my PKM",
    });

    expect(context.source).toBe("decrypted_session_pkm");
    expect(context.domains).toContain("preferences");
    expect(context.domains).not.toContain("runtime_secrets");
    expect(context.domains).not.toContain("__quarantine_v1");
    expect(context.text).toContain("concise summaries");
    expect(context.text).toContain("safe-student-id");
    expect(context.text).toContain("long-term holdings");
    expect(context.text).not.toContain("runtime_secrets");
    expect(context.text).not.toContain("gemini_api_key");
    expect(context.text).not.toContain("must-not-reach-agent-context");
  });

  it("keeps legacy receipt rows and highlights out of routine Chat context", async () => {
    const transaction = {
      ref: `txn_${"a".repeat(24)}`,
      merchant: "Supabase",
      amount: 124.01,
      currency: "USD",
      category: "Cloud & Infra",
      status: "overdue",
      transaction_date: "2026-10-04",
      identifiers: [{ kind: "invoice", value: "ZSUQHV-00028" }],
      detail: null,
    };
    const index = {
      schema: "receipt_canonical_index.v1",
      generated_at: "2026-10-09T10:00:00Z",
      total_transactions: 1,
      truncated: false,
      transactions: [transaction],
    };
    const shoppingMetadata = {
      ...METADATA,
      domains: [...METADATA.domains, { ...METADATA.domains[0], key: "shopping", displayName: "Shopping" }],
    };
    pkmGetMetadataMock.mockResolvedValue(shoppingMetadata);
    pkmBlob = {
      preferences: { writing: { default_style: "concise summaries" } },
      shopping: { wishlists: { first: "noise-cancelling headphones" }, receipts_memory: { _canonical_index: index, readable_summary: { text: "RAW_SUBJECT USD 124.01" }, observed_facts: { recent_highlights: [{ amount: 124.01, transaction_date: "2026-10-04", subject: "RAW_SUBJECT" }], merchant_affinity: [{ merchant_label: "Amazon", receipt_count_365d: 5 }, { merchant_label: "Amazon paid USD 124.01 on 2026-10-04", receipt_count_365d: 1 }] } } },
    };

    const context = await loadLegacyPkmContext({
      userId: "user_1",
      vaultOwnerToken: "vault_token",
      vaultKey: "vault_key",
      message: "show my receipts",
    });
    // The rest of the shopping domain still reaches One; the transaction index never does.
    expect(context.text).toContain("noise-cancelling headphones");
    for (const leaked of ["Supabase", "ZSUQHV", "124.01", "txn_aaaa", "RAW_SUBJECT", "2026-10-04"]) {
      expect(context.text).not.toContain(leaked);
    }
    expect(peekReceiptMemoryIndex({ userId: "user_1" })).toBeNull();
    expect(peekReceiptMemoryIndex({ userId: "someone_else" })).toBeNull();

    // Negative control: an index carrying a field the reader's closed schema forbids is not offered.
    clearAgentPkmContext();
    pkmBlob = {
      shopping: {
        receipts_memory: {
          _canonical_index: { ...index, transactions: [{ ...transaction, subject: "Invoice from Supabase" }] },
        },
      },
    };
    await loadLegacyPkmContext({
      userId: "user_1",
      vaultOwnerToken: "vault_token",
      vaultKey: "vault_key",
      message: "show my receipts",
    });
    expect(peekReceiptMemoryIndex({ userId: "user_1" })).toBeNull();
  });

  it("sends communication preferences as standing style, never inside the memory packet", async () => {
    pkmBlob = {
      preferences: { writing: { default_style: "concise summaries" } },
      identity: {
        identity_profile: { city: "Synthetic City" },
        communication_preferences: {
          preferred_name: "Kay",
          tone: "executive",
          reply_style: "Short and direct replies",
          owner_style_note: "Write Hussh with two s's.",
          unknown_key: "dropped",
          updated_at: "2026-10-01T00:00:00.000Z",
        },
      },
    };
    pkmGetMetadataMock.mockResolvedValue({
      ...METADATA,
      domains: [...METADATA.domains, { ...METADATA.domains[0], key: "identity", displayName: "Identity" }],
    });

    const context = await loadLegacyPkmContext({
      userId: "user_1",
      vaultOwnerToken: "vault_token",
      vaultKey: "vault_key",
      message: "hello",
    });

    // Other identity facts stay in the packet; the reserved style branch does not.
    expect(context.text).toContain("Synthetic City");
    expect(context.text).not.toMatch(/Communication Preferences/i);
    for (const value of ["Kay", "two s's", "Short and direct"]) expect(context.text).not.toContain(value);
    // Closed to the request schema: legacy sentence read as enums, unknown keys dropped.
    expect(context.communicationPreferences).toEqual({
      preferred_name: "Kay",
      tone: "executive",
      length: "short",
      owner_style_note: "Write Hussh with two s's.",
    });
    expect(
      AgentPkmContextStore.findLocalDuplicate({ userId: "user_1", candidate: "Kay" }),
    ).toBeNull();
  });

  it("keeps style out of the packet and Secrets label-only in the same identity domain", async () => {
    // Cross-lane: the style channel (communication_preferences) and label-only
    // Secrets (identity_documents, secrets.*) share the identity domain. A style
    // note holding a secret must not reach One through the style channel either.
    pkmBlob = {
      secrets: { items: { sec_00000000000000a1: { label: "openai API key ending 9f2a", kind: "credential", value: FAKE_API_KEY } } },
      identity: {
        identity_profile: { city: "Synthetic City" },
        identity_documents: { doc_1: { document_type: "passport", label: "Passport ending 4567", number: FAKE_PASSPORT } },
        communication_preferences: {
          preferred_name: "Kay",
          tone: "executive",
          owner_style_note: `Sign off with my key ${FAKE_API_KEY}`,
        },
      },
    };
    pkmGetMetadataMock.mockResolvedValue({
      ...METADATA,
      domains: [...METADATA.domains, ...["secrets", "identity"].map((key) => ({ ...METADATA.domains[0], key, displayName: key }))],
    });

    const context = await loadLegacyPkmContext({ userId: "user_1", vaultKey: "k", vaultOwnerToken: "t", message: "hello" });

    expect(context.text).toContain("Synthetic City");
    expect(context.text).toContain("- Secret exists: Passport ending 4567");
    expect(context.text).toContain("- Secret exists: openai API key ending 9f2a");
    expect(context.text).not.toMatch(/Communication Preferences|Kay|Sign off/i);
    expect(context.communicationPreferences).toEqual({ preferred_name: "Kay", tone: "executive" });
    const wire = JSON.stringify([context.text, context.communicationPreferences]);
    for (const value of FAKE_VALUES) expect(wire).not.toContain(value);
  });

  it("keeps a bounded local inventory and reports safety omissions", async () => {
    const deeplyNested: Record<string, unknown> = { favorite: "tea" };
    let cursor = deeplyNested;
    for (let index = 0; index < 18; index += 1) {
      cursor.next = {};
      cursor = cursor.next as Record<string, unknown>;
    }
    pkmBlob = {
      food: {
        drinks: { favorite: "tea" },
        nested: deeplyNested,
      },
    };
    pkmGetMetadataMock.mockResolvedValue({
      ...METADATA,
      domains: [
        ...METADATA.domains,
        { ...METADATA.domains[0], key: "food", displayName: "Food" },
      ],
    });

    const context = await loadLegacyPkmContext({
      userId: "user_1",
      vaultOwnerToken: "vault_token",
      vaultKey: "vault_key",
      message: "What drinks do I like?",
    });

    expect(context.text).toContain("Food > Drinks > Favorite: tea");
    expect(context.coverage?.safetyOmittedNodeCount).toBeGreaterThan(0);
  });

  it("removes pasted Markdown from the review title and the value that will be encrypted", async () => {
    apiFetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        agent_id: "agent", agent_name: "One", model: "test", used_fallback: false,
        preview_cards: [{
          card_id: "card_1",
          source_text: "## Synthetic diet\n- **Allergy:** peanuts\n- *Prefers* oat milk\n__Home city:__ Example Town",
          write_mode: "confirm_first",
          target_domain: "health",
          candidate_payload: {
            diet: { allergy: "**peanuts**", notes: "- oat milk\n- **no** dairy", language: "C#", rank: "#1 choice" },
            dates: ["**2026-01-01**"],
            count: 3,
          },
          structure_decision: { target_domain: "health" },
        }],
      }),
    });
    const preview = await previewAgentPkmMemory({
      userId: "user_1", vaultOwnerToken: "vault_token", message: "synthetic", currentDomains: [],
    });
    expect(preview.cards[0]!.source_text).toBe("Synthetic diet\nAllergy: peanuts\nPrefers oat milk\nHome city: Example Town");
    expect(preview.cards[0]!.candidate_payload).toEqual({
      diet: { allergy: "peanuts", notes: "oat milk\nno dairy", language: "C#", rank: "#1 choice" },
      dates: ["2026-01-01"],
      count: 3,
    });
  });

  it.each([
    ["C# and F# developer", "C# and F# developer"],
    ["#1 priority", "#1 priority"],
    ["5 * 3 = 15", "5 * 3 = 15"],
    ["snake_case_name and __init__", "snake_case_name and __init__"],
    ["well-known - fact", "well-known - fact"],
    ["**", "**"],
  ])("leaves text that is not Markdown markup unchanged: %s", (input, expected) => {
    expect(toPlainMemoryText(input)).toBe(expected);
  });

  it("previews PKM memory through the agent-lab structure route", async () => {
    apiFetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        agent_id: "agent",
        agent_name: "One",
        model: "test",
        used_fallback: false,
        preview_cards: [
          {
            card_id: "card_1",
            source_text: "",
            write_mode: "confirm_first",
            target_domain: "preferences",
            candidate_payload: { writing: { default_style: "concise" } },
            structure_decision: { target_domain: "preferences" },
          },
        ],
      }),
    });

    const preview = await previewAgentPkmMemory({
      userId: "user_1",
      vaultOwnerToken: "vault_token",
      message: "remember that I prefer concise summaries",
      currentDomains: ["preferences"],
    });

    expect(apiFetchMock).toHaveBeenCalledWith(
      "/api/pkm/memory/proposals",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          Authorization: "Bearer vault_token",
        }),
      })
    );
    expect(preview.cards[0]).toMatchObject({
      card_id: "card_1",
      source_text: "remember that I prefer concise summaries",
      write_mode: "confirm_first",
    });
  });

  it("carries a response-level fallback marker onto every preview card", async () => {
    apiFetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        agent_id: "agent",
        agent_name: "One",
        model: "test",
        used_fallback: true,
        preview_cards: [{
          card_id: "fallback-card",
          source_text: "",
          write_mode: "can_save",
          target_domain: "preferences",
          candidate_payload: { writing: { default_style: "concise" } },
          structure_decision: { target_domain: "preferences" },
        }],
      }),
    });

    const preview = await previewAgentPkmMemory({
      userId: "user_1",
      vaultOwnerToken: "vault_token",
      message: "remember that I prefer concise summaries",
      currentDomains: ["preferences"],
    });

    expect(preview.cards[0]).toMatchObject({
      card_id: "fallback-card",
      preview_degraded: true,
    });
  });

  it("redacts rejected proposal payloads from the user-facing error", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    apiFetchMock.mockResolvedValue({
      ok: false,
      status: 422,
      json: async () => ({
        detail: [{ type: "string_too_long", input: "private imported profile must not escape" }],
      }),
    });

    await expect(previewAgentPkmMemory({
      userId: "user_1",
      vaultOwnerToken: "vault_token",
      message: "private imported profile must not escape",
      currentDomains: ["identity"],
      ingestionId: "ingestion-1",
      chunkIndex: 2,
    })).rejects.toThrow("Memory preparation failed (string_too_long). Please try again.");

    expect(consoleError).toHaveBeenCalledWith(
      "[PKM_INGEST] proposal_failed",
      expect.objectContaining({
        ingestion_id: "ingestion-1",
        chunk_index: 2,
        status: 422,
        error_code: "string_too_long",
      }),
    );
    consoleError.mockRestore();
  });

  it("identifies an outdated backend contract without exposing rejected business details", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    apiFetchMock.mockResolvedValue({ ok: false, status: 422, json: async () => ({
      detail: [{ type: "literal_error", loc: ["body", "memory_profile"], input: "private source" }],
    }) });
    try {
      await expect(previewAgentPkmMemory({ userId: "user_1", vaultOwnerToken: "vault_token",
        message: "private source", currentDomains: [], memoryProfile: "business_directory_v1",
      })).rejects.toMatchObject({ name: "PkmBackendContractMismatch",
        message: "Review is unavailable until the backend update finishes." });
      expect(JSON.stringify(consoleError.mock.calls)).not.toContain("private source");
    } finally {
      consoleError.mockRestore();
    }
  });

  it("saves reviewed PKM cards through the write coordinator and invalidates cached context", async () => {
    await loadAgentPkmContext({ userId: "user_1", vaultKey: "vault_key", vaultOwnerToken: "vault_token" });
    await loadLegacyPkmContext({
      userId: "user_1",
      vaultOwnerToken: "vault_token",
      vaultKey: "vault_key",
      message: "writing",
    });
    expect(AgentPkmContextStore.peek({ userId: "user_1", message: "writing" })).not.toBeNull();

    const cards: AgentPkmPreviewCard[] = [
      {
        card_id: "card_1",
        source_text: "remember that I prefer concise summaries",
        write_mode: "can_save",
        target_domain: "preferences",
        primary_json_path: "preferences.writing.default_style",
        candidate_payload: { writing: { default_style: "concise" } },
        structure_decision: { target_domain: "preferences" },
      },
    ];

    const result = await addToPKM({
      userId: "user_1",
      cards,
      sourceMessage: "remember that I prefer concise summaries",
      vaultKey: "vault_key",
      vaultOwnerToken: "vault_token",
      source: "agent_chat",
      confirmation: {
        confirmedByUser: true,
        surface: "chat",
        source: "agent_chat_review_button",
      },
    });

    expect(result.saved).toBe(1);
    expect(pkmSavePreparedDomainMock).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "user_1",
        domain: "preferences",
        vaultKey: "vault_key",
        vaultOwnerToken: "vault_token",
      })
    );
    const write = pkmSavePreparedDomainMock.mock.calls[0]?.[0] as {
      build: () => Promise<{ summary: Record<string, unknown> }>;
    };
    const plan = await write.build();
    expect(JSON.stringify(plan.summary)).not.toContain(
      "remember that I prefer concise summaries"
    );
    expect(plan.summary).not.toHaveProperty("message_excerpt");
    expect(plan.summary).not.toHaveProperty("card_id");
    expect(plan.scopePath).toBe("preferences.writing.default_style");
    // Specialist writes invalidate the structured inventory, while Soul.md
    // retains its own cache and any pending browser-first facts.
    expect(AgentPkmContextStore.peek({ userId: "user_1", message: "writing" })).toBeNull();
    expect(peekAgentPkmContext({ userId: "user_1", message: "writing" })?.text).toContain("concise summaries");
  });

  it("writes independent domains concurrently while preserving per-domain merge order", async () => {
    const pendingWrites = new Map<string, Array<() => void>>();
    pkmSavePreparedDomainMock.mockImplementation(({ domain }: { domain: string }) =>
      new Promise((resolve) => {
        const resolvers = pendingWrites.get(domain) || [];
        resolvers.push(() => resolve({ success: true, saveState: "saved", message: "Saved", fullBlob: {} }));
        pendingWrites.set(domain, resolvers);
      }),
    );

    const saveTask = addToPKM({
      userId: "user_1",
      cards: [
        {
          card_id: "preference-1",
          source_text: "I prefer concise summaries.",
          write_mode: "can_save",
          target_domain: "preferences",
          candidate_payload: { writing: { default_style: "concise" } },
          structure_decision: { target_domain: "preferences" },
        },
        {
          card_id: "education-1",
          source_text: "I study engineering.",
          write_mode: "can_save",
          target_domain: "education",
          candidate_payload: { field: "engineering" },
          structure_decision: { target_domain: "education" },
        },
        {
          card_id: "preference-2",
          source_text: "I like gaming laptops.",
          write_mode: "can_save",
          target_domain: "preferences",
          candidate_payload: { hardware: { preference: "gaming laptop" } },
          structure_decision: { target_domain: "preferences" },
        },
      ],
      sourceMessage: "Imported profile",
      vaultKey: "vault_key",
      vaultOwnerToken: "owner-token",
      confirmation: {
        confirmedByUser: true,
        surface: "chat",
        source: "agent_chat_review_button",
      },
    });

    expect(pkmSavePreparedDomainMock.mock.calls.map(([params]) => params.domain)).toEqual([
      "preferences",
      "education",
    ]);
    expect(pendingWrites.get("preferences")).toHaveLength(1);

    pendingWrites.get("education")?.[0]?.();
    pendingWrites.get("preferences")?.[0]?.();
    await Promise.resolve();
    await Promise.resolve();

    expect(pkmSavePreparedDomainMock.mock.calls.map(([params]) => params.domain)).toEqual([
      "preferences",
      "education",
      "preferences",
    ]);
    pendingWrites.get("preferences")?.[1]?.();

    await expect(saveTask).resolves.toMatchObject({
      saved: 3,
      results: [
        { cardId: "preference-1", success: true },
        { cardId: "education-1", success: true },
        { cardId: "preference-2", success: true },
      ],
    });
  });

  it("batches simple KYC fields for one domain into one encrypted write", async () => {
    const result = await addToPKM({
      userId: "user_1",
      cards: [
        {
          card_id: "kyc-name",
          source_text: "My name is Akshat Kumar.",
          write_mode: "can_save",
          merge_mode: "extend_entity",
          target_domain: "identity",
          primary_json_path: "identity_profile.full_name",
          candidate_payload: { identity_profile: { full_name: "Akshat Kumar" } },
          structure_decision: { target_domain: "identity" },
        },
        {
          card_id: "kyc-institution",
          source_text: "I study at IIT Bombay.",
          write_mode: "can_save",
          merge_mode: "extend_entity",
          target_domain: "identity",
          primary_json_path: "identity_profile.education.institution",
          candidate_payload: {
            identity_profile: { education: { institution: "IIT Bombay" } },
          },
          structure_decision: { target_domain: "identity" },
        },
      ],
      sourceMessage: "KYC profile",
      vaultKey: "vault_key",
      vaultOwnerToken: "owner-token",
      source: "kyc_identity_onboarding",
      confirmation: {
        confirmedByUser: true,
        surface: "web",
        source: "kyc_identity_onboarding",
      },
      batchSimpleDomainExtensions: true,
    });

    expect(pkmSavePreparedDomainMock).not.toHaveBeenCalled();
    expect(pkmSaveMergedDomainMock).toHaveBeenCalledTimes(1);
    const write = pkmSaveMergedDomainMock.mock.calls[0]?.[0] as {
      domain: string;
      build: () => { domainData: Record<string, unknown> };
    };
    expect(write.domain).toBe("identity");
    expect(write.build().domainData).toEqual({
      identity_profile: {
        full_name: "Akshat Kumar",
        education: { institution: "IIT Bombay" },
      },
    });
    expect(result).toMatchObject({
      saved: 2,
      failed: 0,
      results: [
        { cardId: "kyc-name", success: true },
        { cardId: "kyc-institution", success: true },
      ],
    });
  });

  it("returns a scoped, private-agent save receipt for a reviewed preference", async () => {
    const result = await addToPKM({
      userId: "user_1",
      cards: [
        {
          card_id: "food-drink-card",
          source_text: "Remember that I prefer tea.",
          write_mode: "can_save",
          target_domain: "food",
          primary_json_path: "drinks.favorite",
          candidate_payload: { drinks: { favorite: "tea" } },
          structure_decision: { target_domain: "food" },
        },
      ],
      sourceMessage: "Remember that I prefer tea.",
      vaultKey: "vault_key",
      vaultOwnerToken: "vault_token",
      source: "agent_chat",
      confirmation: {
        confirmedByUser: true,
        surface: "chat",
        source: "agent_chat_review_button",
      },
    });

    expect(result.results[0]).toMatchObject({
      domain: "food",
      scope: "drinks.favorite",
      sharingPosture: "Private to Agent One. Consent is required before external sharing.",
      success: true,
    });
    expect(formatAgentPkmSaveSummary(result)).toBe(
      "Saved in Food > Drinks > Favorite. Private to Agent One. Consent is required before external sharing."
    );
  });

  it("lists each saved PKM location once in the receipt", () => {
    expect(
      formatAgentPkmSaveSummary({
        attempted: 3,
        saved: 3,
        failed: 0,
        domains: ["food"],
        results: [
          {
            cardId: "one",
            domain: "food",
            scope: "preferences",
            success: true,
            sharingPosture: "Private to your private agent.",
          },
          {
            cardId: "two",
            domain: "food",
            scope: "preferences",
            success: true,
            sharingPosture: "Private to your private agent.",
          },
          {
            cardId: "three",
            domain: "food",
            scope: "preferences",
            success: true,
            sharingPosture: "Private to your private agent.",
          },
        ],
      })
    ).toBe("Saved in Food > Preferences. Private to your private agent.");
  });

  it("fails closed when owner confirmation evidence is absent", async () => {
    const result = await addToPKM({
      userId: "user_1",
      cards: [
        {
          card_id: "card_1",
          source_text: "remember this",
          write_mode: "can_save",
          target_domain: "preferences",
          candidate_payload: { writing: { default_style: "concise" } },
          structure_decision: { target_domain: "preferences" },
        },
      ],
      sourceMessage: "remember this",
      vaultKey: "vault_key",
      vaultOwnerToken: "vault_token",
    } as unknown as Parameters<typeof addToPKM>[0]);

    expect(result.saved).toBe(0);
    expect(result.failed).toBe(1);
    expect(pkmSavePreparedDomainMock).not.toHaveBeenCalled();
  });

  it("names the destination the save path would write to, and never guesses one", () => {
    const card: AgentPkmPreviewCard = {
      card_id: "c1",
      source_text: "I hold 10 shares of ACME.",
      write_mode: "confirm_first",
      target_domain: "shopping",
      structure_decision: { target_domain: "financial" },
      primary_json_path: "investments.holdings",
    };
    // structure_decision outranks the flat target_domain, exactly as addToPKM resolves it.
    expect(
      describeAgentPkmCardDestination(card, new Map([["financial", "Finance"]])),
    ).toEqual({ kind: "location", label: "Finance › Investments › Holdings" });
    expect(describeAgentPkmCardDestination({ ...card, structure_decision: {} })).toEqual({
      kind: "location",
      label: "Shopping › Investments › Holdings",
    });
    // Negative controls: a location the structure agent did not settle, or a
    // preview the save path refuses, is reported honestly rather than faked.
    expect(
      describeAgentPkmCardDestination({ ...card, structure_decision: {}, target_domain: "unresolved" }),
    ).toEqual({ kind: "undetermined" });
    expect(describeAgentPkmCardDestination({ ...card, preview_degraded: true })).toEqual({
      kind: "undetermined",
    });
    expect(describeAgentPkmCardDestination({ ...card, write_mode: "do_not_save" })).toEqual({
      kind: "not_saved",
    });
  });
});
