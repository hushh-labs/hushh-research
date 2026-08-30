import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { PkmNaturalPanel } from "@/components/profile/pkm-natural-panel";
import * as AgentPkmAutoSavePolicy from "@/lib/agent/agent-pkm-auto-save-policy";
import { ConsentCenterService } from "@/lib/services/consent-center-service";
import { PersonalKnowledgeModelService } from "@/lib/services/personal-knowledge-model-service";
import { PkmWriteCoordinator } from "@/lib/services/pkm-write-coordinator";

const { addToPKM, clearAgentPkmContext, previewAgentPkmMemory } = vi.hoisted(() => ({
  addToPKM: vi.fn(),
  clearAgentPkmContext: vi.fn(),
  previewAgentPkmMemory: vi.fn(),
}));

vi.mock("@/lib/agent/agent-pkm-memory", () => ({
  addToPKM,
  clearAgentPkmContext,
  getIgnoredPkmCards: () => [],
  previewAgentPkmMemory,
}));

const push = vi.fn();
const getIdToken = vi.fn().mockResolvedValue("id-token");
const user = { uid: "reviewer", getIdToken };

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push }),
}));

vi.mock("@/hooks/use-auth", () => ({
  useAuth: () => ({ user, loading: false }),
}));

vi.mock("@/lib/vault/vault-context", () => ({
  useVault: () => ({
    isVaultUnlocked: true,
    vaultKey: "memory-only-key",
    vaultOwnerToken: "memory-only-owner-token",
  }),
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
    vi.spyOn(PersonalKnowledgeModelService, "loadFullBlob").mockResolvedValue(
      FULL_BLOB as never,
    );
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

  async function openMainScreen() {
    render(<PkmNaturalPanel />);
    return screen.findByRole("button", { name: "Open memory: Risk Profile" });
  }

  it("shows search, Recently learned, and Categories with newest memory first", async () => {
    await openMainScreen();

    expect(screen.getByRole("searchbox", { name: "Search Memory" })).toBeTruthy();

    const recent = screen.getByTestId("memory-recently-learned");
    const recentNames = within(recent)
      .getAllByRole("button")
      .map((node) => node.getAttribute("aria-label"));
    // Financial (updated today) sorts ahead of Preferences (updated a week ago).
    expect(recentNames[0]).toBe("Open memory: Risk Profile");
    expect(recentNames).toContain("Open memory: Seat Choice");
    expect(recentNames.indexOf("Open memory: Risk Profile")).toBeLessThan(
      recentNames.indexOf("Open memory: Seat Choice"),
    );

    expect(screen.getByText("Recently learned")).toBeTruthy();
    expect(screen.getByText("Categories")).toBeTruthy();

    // Tab viewport tracks the active pane's height (no frozen tallest-pane
    // height leaving dead space under shorter tabs like Sharing).
    expect(
      document.querySelector("[data-swipe-views-height-mode]")?.getAttribute("data-swipe-views-height-mode"),
    ).toBe("active");
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
    await openMainScreen();
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

    fireEvent.click(screen.getByRole("button", { name: "Memory" }));
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

    await openMainScreen();
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

    await openMainScreen();
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

    await openMainScreen();
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

    fireEvent.click(screen.getByRole("button", { name: "Add" }));
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
    fireEvent.click(screen.getByRole("button", { name: "Add" }));

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

  it("still renders the Saved screen when domain-level sharing verification fails", async () => {
    vi.spyOn(ConsentCenterService, "getCenter").mockRejectedValueOnce(new Error("consent unavailable"));

    await openMainScreen();
    // No crash, no false access claim, categories still browsable.
    expect(screen.getByTestId("memory-category-financial")).toBeTruthy();
    expect(screen.queryByText(/no active access/i)).toBeNull();
    expect(screen.queryByText(/shared/i)).toBeNull();
  });
});
