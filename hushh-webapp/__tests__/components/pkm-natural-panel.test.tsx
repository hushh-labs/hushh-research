import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { PkmNaturalPanel } from "@/components/profile/pkm-natural-panel";
import { ConsentCenterService } from "@/lib/services/consent-center-service";
import { PersonalKnowledgeModelService } from "@/lib/services/personal-knowledge-model-service";
import { PkmWriteCoordinator } from "@/lib/services/pkm-write-coordinator";

const { clearAgentPkmContext } = vi.hoisted(() => ({
  clearAgentPkmContext: vi.fn(),
}));

vi.mock("@/lib/agent/agent-pkm-memory", () => ({
  clearAgentPkmContext,
}));

const push = vi.fn();
const getIdToken = vi.fn().mockResolvedValue("id-token");
const user = { uid: "reviewer", getIdToken };

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push }),
}));

vi.mock("@/hooks/use-auth", () => ({
  useAuth: () => ({
    user,
    loading: false,
  }),
}));

vi.mock("@/lib/vault/vault-context", () => ({
  useVault: () => ({
    isVaultUnlocked: true,
    vaultKey: "memory-only-key",
    vaultOwnerToken: "memory-only-owner-token",
  }),
}));

vi.mock("@/components/profile/pkm-data-manager", () => ({
  PkmDataManagerPanel: ({
    domains,
    onOpenDomain,
    sharingReady,
    sharingError,
  }: {
    domains: Array<{ key: string; title: string; accessSummary: string }>;
    onOpenDomain: (domain: { key: string; title: string; accessSummary: string }) => void;
    sharingReady: boolean;
    sharingError: string | null;
  }) => (
    <div>
      <div data-testid="sharing-ready">{String(sharingReady)}</div>
      {sharingError ? <div>{sharingError}</div> : null}
      {domains.map((domain) => (
        <div key={domain.key}>
          <button type="button" onClick={() => onOpenDomain(domain)}>
            Open {domain.title}
          </button>
          <span>{domain.accessSummary}</span>
        </div>
      ))}
    </div>
  ),
}));

vi.mock("@/components/profile/pkm-section-preview", () => ({
  PkmSectionPreview: () => <div>Exact category preview</div>,
}));

describe("PkmNaturalPanel", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(PersonalKnowledgeModelService, "getMetadata").mockResolvedValue({
      modelVersion: 6,
      contractVersion: 6,
      readableProjectionVersion: 2,
      domains: [
        {
          key: "financial",
          displayName: "Financial",
          icon: "wallet",
          color: "neutral",
          attributeCount: 3,
          summary: { consumer_item_count: 3 },
          availableScopes: [],
          lastUpdated: "2026-07-14T12:00:00Z",
          readableSourceLabel: "finance setup",
        },
      ],
      totalAttributes: 3,
      lastUpdated: "2026-07-14T12:00:00Z",
      upgradableDomains: [],
      needsUpgrade: false,
    });
    vi.spyOn(ConsentCenterService, "getCenter").mockResolvedValue({
      pending_requests: [],
      active_grants: [],
      recent_activity: [],
    });
    vi.spyOn(PersonalKnowledgeModelService, "getDomainManifest").mockResolvedValue(null);
    vi.spyOn(PersonalKnowledgeModelService, "loadDomainData").mockResolvedValue({
      profile: { risk_profile: "balanced" },
    });
    vi.spyOn(PersonalKnowledgeModelService, "getMutationSharingImpact").mockResolvedValue({
      activeRecipientCount: 0,
      recipientLabels: [],
      entersNextExportRevision: false,
      summary: "No active recipients are affected.",
      affectedGrantIds: [],
      affectedExportIds: [],
    });
  });

  it("loads metadata and the private memory preference before decrypting a category", async () => {
    render(<PkmNaturalPanel />);

    const openFinancial = await screen.findByRole("button", { name: "Open Financial" });
    expect(PersonalKnowledgeModelService.getMetadata).toHaveBeenCalledTimes(1);
    expect(PersonalKnowledgeModelService.getDomainManifest).not.toHaveBeenCalled();
    expect(PersonalKnowledgeModelService.loadDomainData).not.toHaveBeenCalledWith(
      expect.objectContaining({ domain: "financial" })
    );

    fireEvent.click(openFinancial);

    await waitFor(() => {
      expect(PersonalKnowledgeModelService.loadDomainData).toHaveBeenCalledWith(
        expect.objectContaining({ domain: "financial", userId: "reviewer" })
      );
    });
    expect(PersonalKnowledgeModelService.getDomainManifest).toHaveBeenCalledWith(
      "reviewer",
      "financial",
      "memory-only-owner-token"
    );
    expect(await screen.findByText("Exact category preview")).toBeTruthy();
  });

  it("renders saved categories without waiting for the slower sharing request", async () => {
    let resolveSharing: ((value: {
      pending_requests: never[];
      active_grants: never[];
      recent_activity: never[];
    }) => void) | null = null;
    vi.spyOn(ConsentCenterService, "getCenter").mockReturnValueOnce(
      new Promise((resolve) => {
        resolveSharing = resolve;
      }),
    );

    render(<PkmNaturalPanel />);

    expect(await screen.findByRole("button", { name: "Open Financial" })).toBeTruthy();
    expect(screen.getByTestId("sharing-ready").textContent).toBe("false");

    resolveSharing?.({
      pending_requests: [],
      active_grants: [],
      recent_activity: [],
    });
    await waitFor(() => {
      expect(screen.getByTestId("sharing-ready").textContent).toBe("true");
    });
  });

  it("does not claim there is no active access when sharing status cannot be verified", async () => {
    vi.spyOn(ConsentCenterService, "getCenter").mockRejectedValueOnce(
      new Error("consent unavailable")
    );

    render(<PkmNaturalPanel />);

    await screen.findByRole("button", { name: "Open Financial" });
    expect(screen.getByTestId("sharing-ready").textContent).toBe("false");
    expect(
      screen.getByText("Sharing access couldn’t be verified. Refresh to try again.")
    ).toBeTruthy();
    expect(screen.getByText("Access status unavailable")).toBeTruthy();
    expect(screen.queryByText("No active access")).toBeNull();
  });

  it("corrects only the confirmed path against the coordinator's latest domain state", async () => {
    let writtenDomain: Record<string, unknown> | null = null;
    vi.spyOn(PkmWriteCoordinator, "saveMergedDomain").mockImplementationOnce(
      async (params) => {
        const plan = await params.build({
          currentDomainData: {
            profile: { risk_profile: "balanced", sibling: "preserve-me" },
          },
          currentManifest: null,
          currentEncryptedDomain: null,
          baseFullBlob: {},
          attempt: 1,
          upgradedInSession: false,
        });
        writtenDomain = plan.domainData;
        expect(plan.operation).toBe("update");
        expect(plan.scopePath).toBe("profile");
        expect(JSON.stringify(plan.summary)).not.toContain("balanced");
        expect(JSON.stringify(plan.summary)).not.toContain("growth");
        return {
          saveState: "saved",
          success: true,
          fullBlob: { financial: plan.domainData },
        };
      }
    );

    render(<PkmNaturalPanel />);
    fireEvent.click(await screen.findByRole("button", { name: "Open Financial" }));
    await waitFor(() =>
      expect(PersonalKnowledgeModelService.getMutationSharingImpact).toHaveBeenCalled()
    );
    fireEvent.click(await screen.findByRole("button", { name: "Correct saved detail" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Corrected detail value" }), {
      target: { value: "growth" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save corrected detail" }));

    await waitFor(() => expect(PkmWriteCoordinator.saveMergedDomain).toHaveBeenCalledTimes(1));
    expect(writtenDomain).toEqual({
      profile: { risk_profile: "growth", sibling: "preserve-me" },
    });
    expect(clearAgentPkmContext).toHaveBeenCalledWith("reviewer");
    expect(PersonalKnowledgeModelService.getMetadata).toHaveBeenLastCalledWith(
      "reviewer",
      true,
      "memory-only-owner-token"
    );
    expect(await screen.findByText("Saved detail corrected.")).toBeTruthy();
  });

  it("requires delete confirmation and records the confirmed delete operation", async () => {
    vi.spyOn(PkmWriteCoordinator, "saveMergedDomain").mockImplementationOnce(
      async (params) => {
        const plan = await params.build({
          currentDomainData: { profile: { risk_profile: "balanced", sibling: "keep" } },
          currentManifest: null,
          currentEncryptedDomain: null,
          baseFullBlob: {},
          attempt: 0,
          upgradedInSession: false,
        });
        expect(plan.operation).toBe("delete");
        expect(plan.scopePath).toBe("profile");
        expect(plan.domainData).toEqual({ profile: { sibling: "keep" } });
        return {
          saveState: "saved",
          success: true,
          fullBlob: { financial: plan.domainData },
        };
      }
    );

    render(<PkmNaturalPanel />);
    fireEvent.click(await screen.findByRole("button", { name: "Open Financial" }));
    await waitFor(() =>
      expect(PersonalKnowledgeModelService.getMutationSharingImpact).toHaveBeenCalled()
    );
    fireEvent.click(await screen.findByRole("button", { name: "Remove saved detail" }));
    await screen.findByText("Remove this saved detail?");
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(PkmWriteCoordinator.saveMergedDomain).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Remove saved detail" }));
    fireEvent.click(await screen.findByRole("button", { name: "Remove" }));

    await waitFor(() => expect(PkmWriteCoordinator.saveMergedDomain).toHaveBeenCalledTimes(1));
    expect(await screen.findByText("Saved detail removed.")).toBeTruthy();
  });

  it("surfaces a failed correction without claiming success", async () => {
    vi.spyOn(PkmWriteCoordinator, "saveMergedDomain").mockResolvedValueOnce({
      saveState: "failed",
      success: false,
      message: "The latest saved detail must be refreshed.",
      fullBlob: {},
    });

    render(<PkmNaturalPanel />);
    fireEvent.click(await screen.findByRole("button", { name: "Open Financial" }));
    await waitFor(() =>
      expect(PersonalKnowledgeModelService.getMutationSharingImpact).toHaveBeenCalled()
    );
    fireEvent.click(await screen.findByRole("button", { name: "Correct saved detail" }));
    fireEvent.click(screen.getByRole("button", { name: "Save corrected detail" }));

    expect(await screen.findByText("The latest saved detail must be refreshed.")).toBeTruthy();
    expect(screen.queryByText("Saved detail corrected.")).toBeNull();
    expect(clearAgentPkmContext).not.toHaveBeenCalled();
  });

  it("shows and forwards the authenticated sharing impact for a shared correction", async () => {
    vi.spyOn(PersonalKnowledgeModelService, "getMutationSharingImpact").mockResolvedValueOnce({
      activeRecipientCount: 1,
      recipientLabels: ["Planner Pro"],
      entersNextExportRevision: true,
      summary: "This change will enter the next encrypted export revision for Planner Pro.",
      affectedGrantIds: ["grant-current"],
      affectedExportIds: ["export-current"],
    });
    vi.spyOn(PkmWriteCoordinator, "saveMergedDomain").mockImplementationOnce(async (params) => {
      expect(params.confirmation).toMatchObject({
        sharingImpactAcknowledged: true,
        sharingImpact: {
          activeRecipientCount: 1,
          recipientLabels: ["Planner Pro"],
          affectedGrantIds: ["grant-current"],
          affectedExportIds: ["export-current"],
        },
      });
      return { saveState: "saved", success: true, fullBlob: {} };
    });

    render(<PkmNaturalPanel />);
    fireEvent.click(await screen.findByRole("button", { name: "Open Financial" }));
    expect(
      await screen.findByText(
        "This change will enter the next encrypted export revision for Planner Pro."
      )
    ).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Correct saved detail" }));
    expect(
      screen.getByText(
        "This change will enter the next encrypted export revision for Planner Pro."
      )
    ).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Save corrected detail" }));

    await waitFor(() => expect(PkmWriteCoordinator.saveMergedDomain).toHaveBeenCalled());
  });

  it("fails closed when sharing impact cannot be verified", async () => {
    vi.spyOn(PersonalKnowledgeModelService, "getMutationSharingImpact").mockRejectedValueOnce(
      new Error("impact unavailable")
    );

    render(<PkmNaturalPanel />);
    fireEvent.click(await screen.findByRole("button", { name: "Open Financial" }));

    expect(
      await screen.findByText(
        "Current sharing couldn’t be verified. Refresh before changing details."
      )
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: "Correct saved detail" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Remove saved detail" })).toBeDisabled();
  });
});
