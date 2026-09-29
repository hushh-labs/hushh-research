import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  epoch: 1, shares: vi.fn(), files: vi.fn(), memory: vi.fn(),
  bundle: vi.fn(), exports: vi.fn(), connector: vi.fn(), decrypt: vi.fn(),
}));
vi.mock("@/hooks/use-auth", () => ({ useAuth: () => ({ user: { uid: "viewer-1" } }) }));
vi.mock("@/lib/vault/vault-context", () => ({
  useVault: () => ({ isVaultUnlocked: true, vaultKey: "vault-key", vaultOwnerToken: "owner-a" }),
}));
vi.mock("@/lib/services/one-kyc-client-zk-service", () => ({
  OneKycClientZkService: { readStoredConnector: state.connector, decryptScopedExport: state.decrypt },
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock("@/lib/vault/session-epoch", () => ({
  snapshotVaultSessionEpoch: () => state.epoch,
  isVaultSessionEpochCurrent: (epoch: number) => epoch === state.epoch,
}));
vi.mock("@/lib/services/person-profile-service", () => ({
  PersonProfileService: {
    listSharedWithMe: state.memory,
    getInformationRequest: state.bundle,
    getInformationRequestExports: state.exports,
  },
}));
vi.mock("@/lib/services/drive-sharing-service", () => ({
  DriveSharingService: { receivedBulkShares: state.shares, receivedBulkFiles: state.files },
}));

import { SharedWithYouGroup } from "@/components/profile/shared-with-you-group";

beforeEach(() => {
  vi.resetAllMocks(); state.epoch = 1;
  state.memory.mockResolvedValue([]);
  state.shares.mockResolvedValue([{ shareId: "11111111-1111-4111-8111-111111111111",
    status: "running", sharedCount: 2, createdAt: "2026-09-27T00:00:00Z", updatedAt: "2026-09-27T00:00:00Z" }]);
  state.files.mockResolvedValue({ shareId: "11111111-1111-4111-8111-111111111111", sharedCount: 2,
    files: [{ name: "Statement", openUrl: "https://drive.google.com/file/d/test/view", modifiedTime: null }],
    nextCursor: null });
});
afterEach(() => cleanup());

describe("received bulk Drive collection", () => {
  it("shows confirmed links without a Drive connector and clears them on vault change", async () => {
    const view = render(<SharedWithYouGroup vaultOwnerToken="owner-a" />);
    fireEvent.click(await screen.findByRole("button", { name: /2 files/ }));
    expect(await screen.findByRole("link", { name: "Statement" })).toHaveAttribute(
      "href", "https://drive.google.com/file/d/test/view",
    );
    expect(state.files).toHaveBeenCalledWith("owner-a", expect.any(String), expect.any(Function), null);
    state.epoch = 2;
    view.rerender(<SharedWithYouGroup vaultOwnerToken="owner-b" />);
    expect(screen.queryByRole("link", { name: "Statement" })).toBeNull();
  });
});

describe("Shared with you on Profile", () => {
  const MANISH = "manish_public_ref_0001";
  const share = (requestId: string, label: string, sensitivity: string, person = "Manish Sainani", personRef = MANISH) => ({
    bundleId: `bundle-${personRef}`, requestId, person, personRef, profilePath: `/people/${personRef}`,
    label, purpose: "Preparing the joint return", expiresAt: Date.parse("2099-10-05T12:00:00Z"), sensitivity,
  });

  it("shows one secure card per person, with human labels and the values opened on this device", async () => {
    state.memory.mockResolvedValue([
      share("request_tax_0001", "Tax Record Domain", "sensitive"),
      share("request_food_001", "Food preferences", "standard"),
      share("request_role_001", "Professional role", "standard", "Kushal Trivedi", "kushal_public_ref_01"),
    ]);
    state.connector.mockResolvedValue({ connector_key_id: "ck_1" });
    state.bundle.mockImplementation(async ({ bundleId }: { bundleId: string }) => ({
      bundleId, personRef: bundleId.slice("bundle-".length), purpose: "p", durationSeconds: 86400, cancelled: false,
      items: bundleId.endsWith(MANISH)
        ? [{ requestId: "request_tax_0001", scopeRef: "s-tax", label: "Tax record", sensitivity: "sensitive", status: "granted" },
          { requestId: "request_food_001", scopeRef: "s-food", label: "Food preferences", sensitivity: "standard", status: "granted" }]
        : [{ requestId: "request_role_001", scopeRef: "s-role", label: "Professional role", sensitivity: "standard", status: "granted" }],
    }));
    state.exports.mockImplementation(async ({ bundleId }: { bundleId: string }) => {
      const requests = bundleId.endsWith(MANISH)
        ? [["request_tax_0001", "s-tax"], ["request_food_001", "s-food"]] : [["request_role_001", "s-role"]];
      return requests.map(([requestId, scopeRef]) => ({ requestId, scopeRef, encryptedExport: {
        request_id: requestId, scope: `attr.${scopeRef}`, export_revision: 1,
        export_envelope: { version: 2, export_id: `x-${requestId}`, aad: {
          version: 2, app_id: "agent_one", grant_id: requestId, export_id: `x-${requestId}`, revision: 1,
          machine_scope: `attr.${scopeRef}`, payload_algorithm: "AES-256-GCM", expires_at_ms: Date.now() + 3_600_000,
        } },
      } }));
    });
    state.decrypt.mockImplementation(async ({ exportPackage }: { exportPackage: { request_id: string } }) => ({
      request_tax_0001: { adjusted_gross_income: 85000 },
      request_food_001: { cuisine: "Neapolitan pizza" },
      request_role_001: { role: "Staff engineer" },
    }[exportPackage.request_id]));

    render(<SharedWithYouGroup vaultOwnerToken="owner-a" />);
    const cards = await screen.findAllByTestId("shared-with-you-card");
    expect(cards.map((card) => card.getAttribute("aria-label"))).toEqual([
      "Kushal Trivedi shared with you", "Manish Sainani shared with you",
    ]);
    const manish = cards[1]!;
    await waitFor(() => expect(manish).toHaveTextContent("85000"));
    expect(manish).toHaveTextContent("Neapolitan pizza");
    expect(manish).toHaveTextContent("Tax record");
    expect(manish.textContent).not.toMatch(/Tax Record Domain|grant|scope/i);
    // Only the tax item is sensitive; food is not.
    expect(manish.querySelectorAll("[data-sensitive='true']")).toHaveLength(1);
    await waitFor(() => expect(cards[0]).toHaveTextContent("Staff engineer"));
  });
});
