import { act, fireEvent, render, screen, waitFor, within, cleanup } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { PkmNaturalPanel } from "@/components/profile/pkm-natural-panel";
import * as AgentPkmAutoSavePolicy from "@/lib/agent/agent-pkm-auto-save-policy";
import { ConsentCenterService } from "@/lib/services/consent-center-service";
import { PersonalKnowledgeModelService } from "@/lib/services/personal-knowledge-model-service";
import { PkmWriteCoordinator } from "@/lib/services/pkm-write-coordinator";
import { PkmDomainResourceService } from "@/lib/pkm/pkm-domain-resource";
import { publishValidatedAuthSessionOwner } from "@/lib/auth/session-owner";
import { AgentPkmContextStore } from "@/lib/agent/agent-pkm-context-store";

const { addToPKM, clearAgentPkmContext, previewAgentPkmMemory, trackEvent } = vi.hoisted(() => ({
  addToPKM: vi.fn(),
  clearAgentPkmContext: vi.fn(),
  previewAgentPkmMemory: vi.fn(),
  trackEvent: vi.fn(),
}));

vi.mock("@/lib/agent/agent-pkm-memory", () => ({
  addToPKM,
  clearAgentPkmContext,
  getIgnoredPkmCards: () => [],
  previewAgentPkmMemory,
}));

vi.mock("@/lib/observability/client", () => ({ trackEvent }));

const push = vi.fn();
const getIdToken = vi.fn().mockResolvedValue("id-token");
const user = { uid: "reviewer", getIdToken };
const otherUser = { uid: "other-reviewer", getIdToken };
const authState = { user, loading: false, sessionVerificationRequired: false };
const vaultState = {
  isVaultUnlocked: true, vaultKey: "memory-only-key",
  vaultOwnerToken: "memory-only-owner-token", tokenExpiresAt: Date.now() + 60_000,
};

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push }),
}));

vi.mock("@/hooks/use-auth", () => ({
  useAuth: () => authState,
}));

vi.mock("@/lib/vault/vault-context", () => ({
  useVault: () => vaultState,
}));

const NOW = new Date().toISOString();
const WEEK_AGO = new Date(Date.now() - 8 * 86_400_000).toISOString();

function baseMetadata() {
  return {
    modelVersion: 6,
    contractVersion: 6,
    readableProjectionVersion: 2,
    domains: [
      {
        key: "financial",
        displayName: "Financial",
        icon: "wallet",
        color: "neutral",
        attributeCount: 0,
        summary: {},
        availableScopes: [],
        lastUpdated: NOW,
        readableUpdatedAt: NOW,
        readableSourceLabel: "finance setup",
      },
      {
        key: "preferences",
        displayName: "Preferences",
        icon: "star",
        color: "neutral",
        attributeCount: 0,
        summary: {},
        availableScopes: [],
        lastUpdated: WEEK_AGO,
        readableUpdatedAt: WEEK_AGO,
        readableSourceLabel: "a conversation",
      },
      {
        key: "work",
        displayName: "Work",
        icon: "briefcase",
        color: "neutral",
        attributeCount: 0,
        summary: {},
        availableScopes: [],
        lastUpdated: null,
        readableSourceLabel: null,
      },
      {
        key: "runtime_secrets",
        displayName: "Runtime Secrets",
        icon: "lock",
        color: "neutral",
        attributeCount: 0,
        summary: {},
        availableScopes: [],
        lastUpdated: NOW,
        readableSourceLabel: null,
      },
    ],
    totalAttributes: 3,
    lastUpdated: NOW,
    upgradableDomains: [],
    needsUpgrade: false,
  };
}

// A domain manifest whose `profile` scope is a materialized, consumer-visible
// share bundle — the shape buildPkmShareBundles() keeps. `posture` sets whether
// the scope is currently "ask before sharing" (consent_required) or private.
function financialManifest(posture: "consent_required" | "private") {
  return {
    domain: "financial",
    manifest_version: 7,
    scope_registry: [
      {
        scope_handle: "financial.profile",
        scope_label: "Profile",
        visibility_posture: posture,
        exposure_enabled: posture !== "private",
        summary_projection: {
          top_level_scope_path: "profile",
          materialization_state: "materialized",
          materialized_leaf_count: 2,
          consumer_visible: true,
          internal_only: false,
        },
      },
    ],
  };
}

const FULL_BLOB = {
  financial: {
    profile: { risk_profile: "balanced" },
    accounts: { primary_bank: "Chase" },
  },
  preferences: { travel: { seat_choice: "aisle seat" } },
  runtime_secrets: { provider_key: "sk-must-not-render" },
};

describe("PkmNaturalPanel — Memory redesign", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    authState.user = user;
    authState.loading = false;
    authState.sessionVerificationRequired = false;
    vaultState.tokenExpiresAt = Date.now() + 60_000;
    publishValidatedAuthSessionOwner("reviewer");
    vi.spyOn(PersonalKnowledgeModelService, "getMetadata").mockResolvedValue(
      baseMetadata() as never,
    );
    vi.spyOn(ConsentCenterService, "getCenter").mockResolvedValue({
      pending_requests: [],
      active_grants: [],
      recent_activity: [],
    } as never);
    vi.spyOn(PersonalKnowledgeModelService, "getDomainManifest").mockResolvedValue(null);
    vi.spyOn(PersonalKnowledgeModelService, "loadDomainData").mockResolvedValue(
      FULL_BLOB.financial as never,
    );
    vi.spyOn(PkmDomainResourceService, "getManyStaleFirst").mockImplementation(async (params) => {
      const snapshots = Object.fromEntries(
        params.domains
          .filter((domain) => domain in FULL_BLOB)
          .map((domain) => [domain, { data: FULL_BLOB[domain as keyof typeof FULL_BLOB] }]),
      );
      for (const [domain, snapshot] of Object.entries(snapshots)) {
        params.onProgress?.({ domain, snapshot: snapshot as never, failed: false });
      }
      return { snapshots: snapshots as never, failedDomains: [] };
    });
    vi.spyOn(PersonalKnowledgeModelService, "getMutationSharingImpact").mockImplementation(
      async ({ domain, scopePath }) => ({
        activeRecipientCount: domain === "financial" && scopePath === "profile" ? 1 : 0,
        recipientLabels: domain === "financial" && scopePath === "profile" ? ["Planner Pro"] : [],
        entersNextExportRevision: false,
        summary: "ok",
        affectedGrantIds: [],
        affectedExportIds: [],
      }),
    );
    vi.spyOn(AgentPkmAutoSavePolicy, "loadAgentPkmAutoSavePolicy").mockResolvedValue({
      enabled: false,
      version: 1,
      enabledAt: null,
    });
    vi.spyOn(AgentPkmAutoSavePolicy, "saveAgentPkmAutoSavePolicy").mockImplementation(
      async ({ enabled }) => ({
        enabled,
        version: 1,
        enabledAt: enabled ? NOW : null,
      }),
    );
    previewAgentPkmMemory.mockResolvedValue({
      cards: [
        { card_id: "memory-card-1", write_mode: "confirm_first", sharing_impact: { active_recipient_count: 0 } },
      ],
    });
    addToPKM.mockResolvedValue({ attempted: 1, saved: 1, failed: 0, domains: ["financial"], results: [] });
  });

  // Home shows one "Recently learned" row into /one/pkm/recent; the memory
  // rows themselves render in the recent view.
  async function openMainScreen(view: "home" | "recent" = "home") {
    render(<PkmNaturalPanel view={view} />);
    if (view === "recent") {
      return screen.findByRole("button", { name: "Open memory: Risk Profile" });
    }
    return screen.findByTestId("memory-recently-learned-row");
  }

  it("shows search, one Recently learned row into its route, and Categories", async () => {
    await openMainScreen();

    expect(screen.getByRole("searchbox", { name: "Search Memory" })).toBeTruthy();

    const recentRow = screen.getByTestId("memory-recently-learned-row");
    expect(recentRow).toHaveTextContent("Recently learned");
    expect(recentRow).toHaveTextContent("3 memories");
    expect(screen.queryByRole("button", { name: "Open memory: Risk Profile" })).toBeNull();
    fireEvent.click(within(recentRow).getByRole("button"));
    expect(push).toHaveBeenCalledWith("/one/pkm/recent");

    expect(screen.getByText("Categories")).toBeTruthy();

    // Tab viewport tracks the active pane's height (no frozen tallest-pane
    // height leaving dead space under shorter tabs like Sharing).
    expect(
      document.querySelector("[data-swipe-views-height-mode]")?.getAttribute("data-swipe-views-height-mode"),
    ).toBe("active");
  });

  it("recent view lists memories newest first", async () => {
    await openMainScreen("recent");
    const recentNames = within(screen.getByTestId("memory-recent-list"))
      .getAllByRole("button")
      .map((node) => node.getAttribute("aria-label"));
    // Financial (updated today) sorts ahead of Preferences (updated a week ago).
    expect(recentNames[0]).toBe("Open memory: Risk Profile");
    expect(recentNames).toContain("Open memory: Seat Choice");
    expect(recentNames.indexOf("Open memory: Risk Profile")).toBeLessThan(
      recentNames.indexOf("Open memory: Seat Choice"),
    );
  });

  it("lists only consumer-visible, non-empty categories with correct counts", async () => {
    await openMainScreen();

    const categories = screen.getByTestId("memory-categories");
    expect(within(categories).getByTestId("memory-category-financial")).toHaveTextContent(
      "2 memories",
    );
    expect(within(categories).getByTestId("memory-category-preferences")).toHaveTextContent(
      "1 memory",
    );
    // Empty domain and reserved internal domain never appear.
    expect(screen.queryByTestId("memory-category-work")).toBeNull();
    expect(screen.queryByTestId("memory-category-runtime_secrets")).toBeNull();
    expect(screen.queryByText(/sk-must-not-render/)).toBeNull();
  });

  it("keeps available memories visible when another domain cannot be opened", async () => {
    vi.spyOn(PkmDomainResourceService, "getManyStaleFirst").mockImplementation(async (params) => {
      const snapshot = { data: FULL_BLOB.financial };
      params.onProgress?.({ domain: "financial", snapshot: snapshot as never, failed: false });
      return {
        snapshots: { financial: snapshot } as never,
        failedDomains: ["preferences"],
      };
    });

    await openMainScreen();

    expect(screen.getByTestId("memory-recently-learned-row")).toHaveTextContent("2 memories");
    expect(
      await screen.findByText(
        "Some saved details couldn’t be refreshed. Your available details are still here.",
      ),
    ).toBeTruthy();
    expect(screen.queryByText("One hasn’t saved anything yet.")).toBeNull();
  });

  it("opens a category into nested levels and Back walks up one level", async () => {
    await openMainScreen();
    fireEvent.click(screen.getByRole("button", { name: "Open category: Financial" }));

    expect(await screen.findByRole("heading", { name: "Financial" })).toBeTruthy();
    // Immediate children only — groups with a chevron, not flattened leaves.
    expect(await screen.findByTestId("memory-group-profile")).toHaveTextContent("Profile");
    expect(screen.getByTestId("memory-group-accounts")).toHaveTextContent("Accounts");
    expect(screen.queryByRole("button", { name: "Open memory: Primary Bank" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Open Accounts" }));
    expect(await screen.findByRole("heading", { name: "Accounts" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Open memory: Primary Bank" })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Financial" }));
    expect(await screen.findByRole("heading", { name: "Financial" })).toBeTruthy();
    expect(screen.getByTestId("memory-group-accounts")).toBeTruthy();
  });

  it("shows a readable path on deep search hits and returns to the same results", async () => {
    await openMainScreen();
    const box = screen.getByRole("searchbox", { name: "Search Memory" });
    fireEvent.change(box, { target: { value: "balanced" } });

    const result = await screen.findByRole("button", { name: "Open memory: Risk Profile" });
    expect(
      within(screen.getByTestId("memory-search-results")).getByText("Financial › Profile"),
    ).toBeTruthy();

    fireEvent.click(result);
    expect(await screen.findByRole("heading", { name: "Risk Profile" })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Memory" }));
    // The query and its results are still there — search is a shortcut, not a drill.
    expect(screen.getByRole("searchbox", { name: "Search Memory" })).toHaveValue("balanced");
    expect(
      await screen.findByRole("button", { name: "Open memory: Risk Profile" }),
    ).toBeTruthy();
  });

  it("searches title/value and shows a clean empty state", async () => {
    await openMainScreen();
    const box = screen.getByRole("searchbox", { name: "Search Memory" });

    fireEvent.change(box, { target: { value: "balanced" } });
    expect(await screen.findByTestId("memory-search-results")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Open memory: Risk Profile" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Open memory: Primary Bank" })).toBeNull();

    fireEvent.change(box, { target: { value: "zzz-nothing" } });
    expect(await screen.findByText('No memories match “zzz-nothing”.')).toBeTruthy();
  });

  it("shows value and per-scope sharing only — never a guessed source or timestamp", async () => {
    await openMainScreen("recent");
    fireEvent.click(screen.getByRole("button", { name: "Open memory: Risk Profile" }));

    expect(await screen.findByRole("heading", { name: "Risk Profile" })).toBeTruthy();
    expect(screen.getByText("balanced")).toBeTruthy();
    // Domain-level provenance must not be dressed up as this memory's own.
    expect(screen.queryByText("Learned from")).toBeNull();
    expect(screen.queryByText("Last updated")).toBeNull();

    const meta = screen.getByTestId("memory-detail-meta");
    expect(meta).toHaveTextContent("Sharing");
    // profile scope is shared for financial in this fixture.
    await waitFor(() => expect(meta).toHaveTextContent("Shared"));

    // Categories live on the home; the recent view only lists memories.
    cleanup();
    await openMainScreen();
    fireEvent.click(screen.getByRole("button", { name: "Open category: Financial" }));
    fireEvent.click(await screen.findByRole("button", { name: "Open Accounts" }));
    fireEvent.click(await screen.findByRole("button", { name: "Open memory: Primary Bank" }));
    const meta2 = await screen.findByTestId("memory-detail-meta");
    // accounts scope is NOT shared even though another scope in the same domain is.
    await waitFor(() => expect(meta2).toHaveTextContent("Private"));
    expect(meta2).not.toHaveTextContent("Shared");
  });

  it("edits a memory through the existing write coordinator on the exact path", async () => {
    let writtenDomain: Record<string, unknown> | null = null;
    vi.spyOn(PkmWriteCoordinator, "saveMergedDomain").mockImplementationOnce(async (params) => {
      const plan = await params.build({
        currentDomainData: { profile: { risk_profile: "balanced" }, accounts: { primary_bank: "Chase" } },
        currentManifest: null,
        currentEncryptedDomain: null,
        baseFullBlob: {},
        attempt: 1,
        upgradedInSession: false,
      });
      writtenDomain = plan.domainData;
      expect(plan.operation).toBe("update");
      expect(plan.scopePath).toBe("profile");
      return { saveState: "saved", success: true, fullBlob: { financial: plan.domainData } };
    });

    await openMainScreen("recent");
    fireEvent.click(screen.getByRole("button", { name: "Open memory: Risk Profile" }));
    await screen.findByRole("heading", { name: "Risk Profile" });
    await waitFor(() =>
      expect(PersonalKnowledgeModelService.getMutationSharingImpact).toHaveBeenCalled(),
    );

    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    const input = await screen.findByRole("textbox", { name: "New value for Risk Profile" });
    fireEvent.change(input, { target: { value: "growth" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(PkmWriteCoordinator.saveMergedDomain).toHaveBeenCalledTimes(1));
    expect(writtenDomain).toEqual({
      profile: { risk_profile: "growth" },
      accounts: { primary_bank: "Chase" },
    });
    expect(clearAgentPkmContext).toHaveBeenCalledWith("reviewer");
    // Returns to the list after a successful edit.
    await waitFor(() =>
      expect(screen.queryByRole("heading", { name: "Risk Profile" })).toBeNull(),
    );
  });

  it("keeps a confirmed memory write successful when only metadata refresh fails", async () => {
    vi.spyOn(PkmWriteCoordinator, "saveMergedDomain").mockImplementationOnce(async (params) => {
      const plan = await params.build({
        currentDomainData: FULL_BLOB.financial,
        currentManifest: null,
        currentEncryptedDomain: null,
        baseFullBlob: FULL_BLOB,
        attempt: 1,
        upgradedInSession: false,
      });
      return { saveState: "saved", success: true, fullBlob: { financial: plan.domainData } };
    });

    await openMainScreen("recent");
    fireEvent.click(screen.getByRole("button", { name: "Open memory: Risk Profile" }));
    await screen.findByRole("heading", { name: "Risk Profile" });
    await waitFor(() =>
      expect(PersonalKnowledgeModelService.getMutationSharingImpact).toHaveBeenCalled(),
    );
    vi.mocked(PersonalKnowledgeModelService.getMetadata).mockRejectedValueOnce(
      new Error("refresh unavailable"),
    );

    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    fireEvent.change(
      await screen.findByRole("textbox", { name: "New value for Risk Profile" }),
      { target: { value: "growth" } },
    );
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() =>
      expect(trackEvent).toHaveBeenCalledWith("one_memory_action", {
        route_id: "pkm",
        action: "detail_edited",
        result: "success",
      }),
    );
    expect(trackEvent).not.toHaveBeenCalledWith(
      "one_memory_action",
      expect.objectContaining({ action: "detail_edited", result: "error" }),
    );
  });

  it("requires confirmation before forgetting and deletes the exact path", async () => {
    vi.spyOn(PkmWriteCoordinator, "saveMergedDomain").mockImplementationOnce(async (params) => {
      const plan = await params.build({
        currentDomainData: { profile: { risk_profile: "balanced" }, accounts: { primary_bank: "Chase" } },
        currentManifest: null,
        currentEncryptedDomain: null,
        baseFullBlob: {},
        attempt: 0,
        upgradedInSession: false,
      });
      expect(plan.operation).toBe("delete");
      expect(plan.domainData).toEqual({ profile: {}, accounts: { primary_bank: "Chase" } });
      return { saveState: "saved", success: true, fullBlob: { financial: plan.domainData } };
    });

    await openMainScreen("recent");
    fireEvent.click(screen.getByRole("button", { name: "Open memory: Risk Profile" }));
    await screen.findByRole("heading", { name: "Risk Profile" });
    await waitFor(() =>
      expect(PersonalKnowledgeModelService.getMutationSharingImpact).toHaveBeenCalled(),
    );

    // The action row does not delete on its own — a confirm dialog is required.
    fireEvent.click(screen.getByRole("button", { name: "Forget Memory" }));
    const dialog = await screen.findByRole("alertdialog");
    expect(PkmWriteCoordinator.saveMergedDomain).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole("button", { name: "Forget Memory" }));

    await waitFor(() => expect(PkmWriteCoordinator.saveMergedDomain).toHaveBeenCalledTimes(1));
    await waitFor(() =>
      expect(screen.queryByRole("heading", { name: "Risk Profile" })).toBeNull(),
    );
  });

  it("fails closed: no verified sharing impact disables edit and delete", async () => {
    vi.spyOn(PersonalKnowledgeModelService, "getMutationSharingImpact").mockRejectedValue(
      new Error("impact unavailable"),
    );

    await openMainScreen("recent");
    fireEvent.click(screen.getByRole("button", { name: "Open memory: Risk Profile" }));
    await screen.findByRole("heading", { name: "Risk Profile" });

    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Edit" })).toBeDisabled(),
    );
    expect(screen.getByRole("button", { name: "Forget Memory" })).toBeDisabled();
    expect(screen.getByTestId("memory-detail-meta")).toHaveTextContent("Not available");
  });

  it("keeps the automatic-memory preference (on the Add screen, off the Saved list)", async () => {
    await openMainScreen();
    // Not cluttering the primary Saved screen.
    const savedPanel = document.querySelector('[data-pkm-saved-panel="true"]') as HTMLElement;
    expect(within(savedPanel).queryByRole("switch")).toBeNull();
    expect(within(savedPanel).queryByTestId("memory-auto-save-row")).toBeNull();

    fireEvent.click(screen.getByRole("tab", { name: "Add" }));
    const toggle = await screen.findByRole("switch", {
      name: "Turn automatic memory saving on",
    });
    expect(toggle).toHaveAttribute("aria-checked", "false");
    fireEvent.click(toggle);

    await waitFor(() =>
      expect(AgentPkmAutoSavePolicy.saveAgentPkmAutoSavePolicy).toHaveBeenCalledWith(
        expect.objectContaining({
          enabled: true,
          confirmation: expect.objectContaining({ confirmedByUser: true }),
        }),
      ),
    );
  });

  it("keeps the review-first Add flow intact", async () => {
    await openMainScreen();
    fireEvent.click(screen.getByRole("tab", { name: "Add" }));

    const note = await screen.findByRole("textbox", { name: "Memory note" });
    fireEvent.change(note, { target: { value: "I prefer morning flights whenever possible." } });
    fireEvent.click(screen.getByRole("button", { name: "Review memory" }));

    await waitFor(() =>
      expect(previewAgentPkmMemory).toHaveBeenCalledWith(
        expect.objectContaining({ userId: "reviewer" }),
      ),
    );
    fireEvent.click(await screen.findByRole("button", { name: "Save to Memory" }));
    await waitFor(() =>
      expect(addToPKM).toHaveBeenCalledWith(
        expect.objectContaining({
          source: "memory_workspace",
          confirmation: expect.objectContaining({ confirmedByUser: true }),
        }),
      ),
    );
  });

  it("records an exact local duplicate as an expected preparation outcome", async () => {
    vi.spyOn(AgentPkmContextStore, "findLocalDuplicate").mockReturnValueOnce({
      kind: "exact", domain: "preferences", path: ["travel", "seat_choice"],
    });
    await openMainScreen();
    fireEvent.click(screen.getByRole("tab", { name: "Add" }));
    fireEvent.change(await screen.findByRole("textbox", { name: "Memory note" }), {
      target: { value: "I prefer morning flights whenever possible." },
    });
    fireEvent.click(screen.getByRole("button", { name: "Review memory" }));
    expect(await screen.findByText(/exact detail is already saved/i)).toBeTruthy();
    expect(previewAgentPkmMemory).not.toHaveBeenCalled();
    expect(trackEvent).toHaveBeenCalledWith("one_memory_action", {
      route_id: "pkm", action: "capture_prepared", result: "expected_error",
    });
  });

  it("requires sharing-impact acknowledgment before saving a shared detail", async () => {
    previewAgentPkmMemory.mockResolvedValueOnce({
      cards: [{
        card_id: "shared-memory-card",
        source_text: "I prefer asynchronous written updates for work.",
        write_mode: "confirm_first",
        target_domain: "professional",
        target_entity_scope: "work_preferences",
        candidate_payload: { communication: { preference: "written" } },
        merge_decision: { merge_mode: "create_entity" },
        structure_decision: { target_domain: "professional" },
        sharing_impact: {
          active_recipient_count: 2,
          recipient_labels: ["Reviewer A", "Reviewer B"],
          enters_next_export_revision: true,
          summary: "This detail is already shared with the current recipients.",
          affected_grant_ids: [],
          affected_export_ids: [],
        },
      }],
    });

    await openMainScreen();
    fireEvent.click(screen.getByRole("tab", { name: "Add" }));
    fireEvent.change(await screen.findByRole("textbox", { name: "Memory note" }), {
      target: { value: "I prefer asynchronous written updates for work." },
    });
    fireEvent.click(screen.getByRole("button", { name: "Review memory" }));

    const acknowledgment = await screen.findByRole("checkbox", {
      name: /already shared and will be refreshed/i,
    });
    const save = await screen.findByRole("button", { name: "Save to Memory" });
    expect(screen.getByText("This detail is already shared with the current recipients.")).toBeTruthy();
    expect(save).toBeDisabled();
    expect(addToPKM).not.toHaveBeenCalled();

    fireEvent.click(acknowledgment);
    expect(save).not.toBeDisabled();
    fireEvent.click(save);
    await waitFor(() =>
      expect(addToPKM).toHaveBeenCalledWith(
        expect.objectContaining({
          confirmation: expect.objectContaining({
            confirmedByUser: true,
            sharingImpactAcknowledged: true,
          }),
        }),
      ),
    );
  });

  it("keeps a failed review retryable without asking the owner to relock the vault", async () => {
    previewAgentPkmMemory.mockRejectedValueOnce(new Error("proposal unavailable"));
    await openMainScreen();
    fireEvent.click(screen.getByRole("tab", { name: "Add" }));
    const note = await screen.findByRole("textbox", { name: "Memory note" });
    fireEvent.change(note, { target: { value: "Synthetic review note" } });
    fireEvent.click(screen.getByRole("button", { name: "Review memory" }));
    expect(await screen.findByText("That note couldn’t be prepared. Nothing was saved. Please try again.")).toBeTruthy();
    expect(note).toHaveValue("Synthetic review note");
    expect(screen.queryByRole("button", { name: "Save to Memory" })).toBeNull();
    expect(addToPKM).not.toHaveBeenCalled();
  });

  it("retains unresolved source even after every prepared card saves successfully", async () => {
    await openMainScreen();
    fireEvent.click(screen.getByRole("tab", { name: "Add" }));
    const note = await screen.findByRole("textbox", { name: "Memory note" });
    const source = "# Historical project\n" + "A qualified synthetic detail. ".repeat(240) +
      "\n# Separate preference\nI prefer morning flights.";
    fireEvent.change(note, { target: { value: source } });
    fireEvent.click(screen.getByRole("button", { name: "Review memory" }));
    expect(await screen.findByText(/Some sections need another review/)).toBeTruthy();
    expect(await screen.findByRole("button", { name: "Save to Memory" })).toBeDisabled();
    expect(addToPKM).not.toHaveBeenCalled();
    expect(note).toHaveValue(source);
  });

  it("shows the proposed source detail and invalidates it when the note changes", async () => {
    previewAgentPkmMemory.mockResolvedValueOnce({ cards: [{
      card_id: "synthetic-review", source_text: "My test role is Synthetic Reviewer.",
      write_mode: "confirm_first",
    }] });
    await openMainScreen();
    fireEvent.click(screen.getByRole("tab", { name: "Add" }));
    const note = await screen.findByRole("textbox", { name: "Memory note" });
    fireEvent.change(note, { target: { value: "My test role is Synthetic Reviewer." } });
    fireEvent.click(screen.getByRole("button", { name: "Review memory" }));
    expect(await screen.findByText("My test role is Synthetic Reviewer.", { selector: ":not(textarea)" })).toBeTruthy();
    fireEvent.change(note, { target: { value: "A different note" } });
    expect(screen.queryByRole("button", { name: "Save to Memory" })).toBeNull();
    expect(addToPKM).not.toHaveBeenCalled();
  });

  it("ignores an old review response after the draft is edited", async () => {
    let finish!: (value: unknown) => void;
    previewAgentPkmMemory.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    await openMainScreen();
    fireEvent.click(screen.getByRole("tab", { name: "Add" }));
    const note = await screen.findByRole("textbox", { name: "Memory note" });
    fireEvent.change(note, { target: { value: "First synthetic note" } });
    fireEvent.click(screen.getByRole("button", { name: "Review memory" }));
    await waitFor(() => expect(finish).toBeTypeOf("function"));
    fireEvent.change(note, { target: { value: "Second synthetic note" } });
    await act(async () => finish({ cards: [{ card_id: "stale", source_text: "Stale preview" }] }));
    expect(note).toHaveValue("Second synthetic note");
    expect(screen.queryByRole("button", { name: "Save to Memory" })).toBeNull();
    expect(screen.queryByText("Stale preview")).toBeNull();
  });

  it.each(["verification", "loading", "expiry"])("rejects an in-flight preview after %s readiness is lost", async (reason) => {
    let finish!: (value: unknown) => void;
    previewAgentPkmMemory.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const view = render(<PkmNaturalPanel />);
    await screen.findByTestId("memory-recently-learned-row");
    fireEvent.click(screen.getByRole("tab", { name: "Add" }));
    fireEvent.change(await screen.findByRole("textbox", { name: "Memory note" }), { target: { value: "Synthetic preference" } });
    fireEvent.click(screen.getByRole("button", { name: "Review memory" }));
    await waitFor(() => expect(finish).toBeTypeOf("function"));
    const current = previewAgentPkmMemory.mock.calls.at(-1)?.[0].isEffectCurrent;
    expect(current()).toBe(true);
    if (reason === "verification") authState.sessionVerificationRequired = true;
    if (reason === "loading") authState.loading = true;
    if (reason === "expiry") vaultState.tokenExpiresAt = Date.now() - 1;
    view.rerender(<PkmNaturalPanel />);
    expect(current()).toBe(false);
    await act(async () => finish({ cards: [{ card_id: "stale", source_text: "Stale preview" }] }));
    authState.loading = false;
    authState.sessionVerificationRequired = false;
    view.rerender(<PkmNaturalPanel />);
    expect(screen.queryByText("Stale preview")).toBeNull();
    expect(screen.queryByRole("button", { name: "Save to Memory" })).toBeNull();
    expect(addToPKM).not.toHaveBeenCalled();
  });

  it.each(["verification", "loading", "expiry"])("stops save dispatch/publication after %s readiness is lost", async (reason) => {
    let finish!: (value: unknown) => void;
    addToPKM.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const view = render(<PkmNaturalPanel />);
    await screen.findByTestId("memory-recently-learned-row");
    fireEvent.click(screen.getByRole("tab", { name: "Add" }));
    fireEvent.change(await screen.findByRole("textbox", { name: "Memory note" }), { target: { value: "Synthetic preference" } });
    fireEvent.click(screen.getByRole("button", { name: "Review memory" }));
    fireEvent.click(await screen.findByRole("button", { name: "Save to Memory" }));
    await waitFor(() => expect(finish).toBeTypeOf("function"));
    const options = addToPKM.mock.calls.at(-1)?.[0];
    expect(options.mayPublish()).toBe(true);
    if (reason === "verification") authState.sessionVerificationRequired = true;
    if (reason === "loading") authState.loading = true;
    if (reason === "expiry") vaultState.tokenExpiresAt = Date.now() - 1;
    view.rerender(<PkmNaturalPanel />);
    await expect(options.beforeEffect()).rejects.toMatchObject({ name: "AbortError" });
    expect(options.mayPublish()).toBe(false);
    await act(async () => finish({ attempted: 1, saved: 0, failed: 1, results: [], domains: [] }));
    expect(clearAgentPkmContext).not.toHaveBeenCalled();
  });

  it("holds an interrupted save until settlement and retires its cards before another review", async () => {
    let finish!: (value: unknown) => void;
    addToPKM.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const view = render(<PkmNaturalPanel />);
    await screen.findByTestId("memory-recently-learned-row");
    fireEvent.click(screen.getByRole("tab", { name: "Add" }));
    const note = await screen.findByRole("textbox", { name: "Memory note" });
    fireEvent.change(note, { target: { value: "Synthetic preference" } });
    fireEvent.click(screen.getByRole("button", { name: "Review memory" }));
    fireEvent.click(await screen.findByRole("button", { name: "Save to Memory" }));
    await waitFor(() => expect(finish).toBeTypeOf("function"));
    authState.sessionVerificationRequired = true;
    view.rerender(<PkmNaturalPanel />);
    authState.sessionVerificationRequired = false;
    view.rerender(<PkmNaturalPanel />);
    expect(note).toBeDisabled();
    expect(screen.queryByRole("button", { name: "Save to Memory" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Review memory" }));
    expect(addToPKM).toHaveBeenCalledTimes(1);
    expect(previewAgentPkmMemory).toHaveBeenCalledTimes(1);
    await act(async () => finish({ attempted: 1, saved: 1, failed: 0, domains: ["preferences"],
      results: [{ cardId: "memory-card-1", success: true }] }));
    expect(note).not.toBeDisabled();
    expect(note).toHaveValue("Synthetic preference");
    expect(screen.getByText(/1 reviewed detail saved. Check Memory/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Save to Memory" })).toBeNull();
    expect(clearAgentPkmContext).not.toHaveBeenCalled();
  });

  it("does not let a late owner-A settlement unlock owner-B's pending save", async () => {
    let finishA!: (value: unknown) => void;
    let finishB!: (value: unknown) => void;
    addToPKM
      .mockImplementationOnce(() => new Promise(resolve => { finishA = resolve; }))
      .mockImplementationOnce(() => new Promise(resolve => { finishB = resolve; }));

    const view = render(<PkmNaturalPanel />);
    await screen.findByTestId("memory-recently-learned-row");
    fireEvent.click(screen.getByRole("tab", { name: "Add" }));
    const noteA = await screen.findByRole("textbox", { name: "Memory note" });
    fireEvent.change(noteA, { target: { value: "Owner A synthetic detail" } });
    fireEvent.click(screen.getByRole("button", { name: "Review memory" }));
    fireEvent.click(await screen.findByRole("button", { name: "Save to Memory" }));
    await waitFor(() => expect(finishA).toBeTypeOf("function"));

    authState.user = otherUser;
    publishValidatedAuthSessionOwner(otherUser.uid);
    view.rerender(<PkmNaturalPanel />);
    await screen.findByTestId("memory-recently-learned-row");
    fireEvent.click(screen.getByRole("tab", { name: "Add" }));
    const noteB = await screen.findByRole("textbox", { name: "Memory note" });
    fireEvent.change(noteB, { target: { value: "Owner B synthetic detail" } });
    fireEvent.click(screen.getByRole("button", { name: "Review memory" }));
    fireEvent.click(await screen.findByRole("button", { name: "Save to Memory" }));
    await waitFor(() => expect(finishB).toBeTypeOf("function"));

    await act(async () => finishA({ attempted: 1, saved: 1, failed: 0, domains: ["preferences"], results: [] }));
    expect(noteB).toBeDisabled();
    await act(async () => finishB({ attempted: 1, saved: 1, failed: 0, domains: ["preferences"], results: [] }));
    expect(noteB).not.toBeDisabled();
  });

  it("reconciles a save acknowledged during verification recovery with a fresh read", async () => {
    let finish!: (value: unknown) => void;
    addToPKM.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const view = render(<PkmNaturalPanel />);
    await screen.findByTestId("memory-recently-learned-row");
    fireEvent.click(screen.getByRole("tab", { name: "Add" }));
    const note = await screen.findByRole("textbox", { name: "Memory note" });
    fireEvent.change(note, { target: { value: "Recovered synthetic detail" } });
    fireEvent.click(screen.getByRole("button", { name: "Review memory" }));
    fireEvent.click(await screen.findByRole("button", { name: "Save to Memory" }));
    await waitFor(() => expect(finish).toBeTypeOf("function"));

    authState.sessionVerificationRequired = true;
    view.rerender(<PkmNaturalPanel />);
    await act(async () => finish({ attempted: 1, saved: 1, failed: 0, domains: ["preferences"], results: [] }));
    const metadataCallsBeforeRecovery = vi.mocked(PersonalKnowledgeModelService.getMetadata).mock.calls.length;
    authState.sessionVerificationRequired = false;
    view.rerender(<PkmNaturalPanel />);

    await waitFor(() => expect(
      vi.mocked(PersonalKnowledgeModelService.getMetadata).mock.calls.slice(metadataCallsBeforeRecovery)
        .some(([userId, force]) => userId === "reviewer" && force === true),
    ).toBe(true));
  });

  it("keeps a pending save locked across a route remount", async () => {
    let finish!: (value: unknown) => void;
    addToPKM.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const first = render(<PkmNaturalPanel />);
    await screen.findByTestId("memory-recently-learned-row");
    fireEvent.click(screen.getByRole("tab", { name: "Add" }));
    const firstNote = await screen.findByRole("textbox", { name: "Memory note" });
    fireEvent.change(firstNote, { target: { value: "Remount synthetic detail" } });
    fireEvent.click(screen.getByRole("button", { name: "Review memory" }));
    fireEvent.click(await screen.findByRole("button", { name: "Save to Memory" }));
    await waitFor(() => expect(finish).toBeTypeOf("function"));

    first.unmount();
    render(<PkmNaturalPanel />);
    await screen.findByTestId("memory-recently-learned-row");
    fireEvent.click(screen.getByRole("tab", { name: "Add" }));
    expect(await screen.findByRole("textbox", { name: "Memory note" })).toBeDisabled();
    await act(async () => finish({ attempted: 1, saved: 1, failed: 0, domains: ["preferences"], results: [] }));
  });

  it("still renders the Saved screen when domain-level sharing verification fails", async () => {
    vi.spyOn(ConsentCenterService, "getCenter").mockRejectedValueOnce(new Error("consent unavailable"));

    await openMainScreen();
    // No crash, no false access claim, categories still browsable.
    expect(screen.getByTestId("memory-category-financial")).toBeTruthy();
    expect(screen.queryByText(/no active access/i)).toBeNull();
    expect(screen.queryByText(/shared/i)).toBeNull();
  });

  // ── Issue #6307: item sharing acts in place, never opens the Consent Center ──
  describe("memory item sharing — in place, no Consent Center redirect", () => {
    async function openRiskProfileSharing() {
      await openMainScreen("recent");
      fireEvent.click(screen.getByRole("button", { name: "Open memory: Risk Profile" }));
      await screen.findByRole("heading", { name: "Risk Profile" });
      fireEvent.click(screen.getByRole("button", { name: "Open sharing settings" }));
      return screen.findByRole("switch", { name: "Make this memory private" });
    }

    it("opens sharing on the same memory screen and never routes to /consents", async () => {
      vi.spyOn(PersonalKnowledgeModelService, "getDomainManifest").mockResolvedValue(
        financialManifest("consent_required") as never,
      );

      const toggle = await openRiskProfileSharing();

      // The control is right here, and the memory screen is still mounted.
      expect(toggle).toBeTruthy();
      expect(screen.getByRole("heading", { name: "Risk Profile" })).toBeTruthy();
      // No navigation at all — specifically not to the Consent Center.
      expect(push).not.toHaveBeenCalled();
      expect(push).not.toHaveBeenCalledWith(expect.stringContaining("/consent"));
    });

    it("changes this memory's own scope through the PKM scope-exposure contract", async () => {
      vi.spyOn(PersonalKnowledgeModelService, "getDomainManifest").mockResolvedValue(
        financialManifest("consent_required") as never,
      );
      const updateScopeExposure = vi
        .spyOn(PersonalKnowledgeModelService, "updateScopeExposure")
        .mockResolvedValue({
          success: true,
          manifest: financialManifest("private") as never,
          revokedGrantCount: 1,
          revokedGrantIds: ["grant_1"],
        } as never);

      const toggle = await openRiskProfileSharing();
      fireEvent.click(toggle);

      await waitFor(() => expect(updateScopeExposure).toHaveBeenCalledTimes(1));
      expect(updateScopeExposure).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: "reviewer",
          domain: "financial",
          expectedManifestVersion: 7,
          changes: [{ scopeHandle: "financial.profile", visibilityPosture: "private" }],
        }),
      );
      // Grant revocation is left to the backend default — never opted out of here.
      expect(updateScopeExposure.mock.calls[0][0]).not.toHaveProperty(
        "revokeMatchingActiveGrants",
      );
      expect(push).not.toHaveBeenCalled();
    });

    it("surfaces a redacted error and stays on the memory when the change fails", async () => {
      vi.spyOn(PersonalKnowledgeModelService, "getDomainManifest").mockResolvedValue(
        financialManifest("consent_required") as never,
      );
      vi.spyOn(PersonalKnowledgeModelService, "updateScopeExposure").mockRejectedValue(
        new Error("scope_exposure server stack trace"),
      );

      const toggle = await openRiskProfileSharing();
      fireEvent.click(toggle);

      expect(
        await screen.findByText("Sharing choices couldn’t be updated. Refresh and try again."),
      ).toBeTruthy();
      // No server detail leaked, no crash, no redirect.
      expect(screen.queryByText(/server stack trace/)).toBeNull();
      expect(screen.getByRole("heading", { name: "Risk Profile" })).toBeTruthy();
      expect(push).not.toHaveBeenCalled();
    });

    it("re-verifies recipients after revoking sharing so the row drops 'Shared'", async () => {
      let financialProfileShared = true;
      vi.spyOn(PersonalKnowledgeModelService, "getMutationSharingImpact").mockImplementation(
        async ({ domain, scopePath }) => {
          const shared =
            domain === "financial" && scopePath === "profile" && financialProfileShared;
          return {
            activeRecipientCount: shared ? 1 : 0,
            recipientLabels: shared ? ["Planner Pro"] : [],
            entersNextExportRevision: false,
            summary: "ok",
            affectedGrantIds: [],
            affectedExportIds: [],
          };
        },
      );
      vi.spyOn(PersonalKnowledgeModelService, "getDomainManifest").mockResolvedValue(
        financialManifest("consent_required") as never,
      );
      vi.spyOn(PersonalKnowledgeModelService, "updateScopeExposure").mockImplementation(
        async () => {
          // Backend revokes the matching grant; the next impact check must see it.
          financialProfileShared = false;
          return {
            success: true,
            manifest: financialManifest("private") as never,
            revokedGrantCount: 1,
            revokedGrantIds: ["grant_1"],
          } as never;
        },
      );

      await openMainScreen("recent");
      fireEvent.click(screen.getByRole("button", { name: "Open memory: Risk Profile" }));
      await screen.findByRole("heading", { name: "Risk Profile" });
      const meta = screen.getByTestId("memory-detail-meta");
      await waitFor(() => expect(meta).toHaveTextContent("Shared"));

      fireEvent.click(screen.getByRole("button", { name: "Open sharing settings" }));
      fireEvent.click(await screen.findByRole("switch", { name: "Make this memory private" }));

      await waitFor(() =>
        expect(PersonalKnowledgeModelService.updateScopeExposure).toHaveBeenCalled(),
      );
      await waitFor(() => expect(meta).toHaveTextContent("Private"));
      expect(meta).not.toHaveTextContent("Shared");
      expect(push).not.toHaveBeenCalled();
    });

    it("fails closed when the scope has no materialized share bundle", async () => {
      vi.spyOn(PersonalKnowledgeModelService, "getDomainManifest").mockResolvedValue(null);
      const updateScopeExposure = vi.spyOn(
        PersonalKnowledgeModelService,
        "updateScopeExposure",
      );

      await openMainScreen("recent");
      fireEvent.click(screen.getByRole("button", { name: "Open memory: Risk Profile" }));
      await screen.findByRole("heading", { name: "Risk Profile" });
      fireEvent.click(screen.getByRole("button", { name: "Open sharing settings" }));

      expect(
        await screen.findByText(/Sharing controls for this memory aren’t available right now/),
      ).toBeTruthy();
      expect(screen.queryByRole("switch")).toBeNull();
      expect(updateScopeExposure).not.toHaveBeenCalled();
      expect(push).not.toHaveBeenCalled();
    });
  });
});
