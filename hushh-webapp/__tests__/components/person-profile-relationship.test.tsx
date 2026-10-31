import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { viewerProfile } from "./person-profile/fixtures";

const mocks = vi.hoisted(() => ({
  getViewer: vi.fn(), getPublic: vi.fn(), getRelationship: vi.fn(),
  removeConnection: vi.fn(), featureReadiness: vi.fn(), packets: vi.fn(),
  user: { uid: "viewer", getIdToken: async () => "viewer-token" },
}));

vi.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => "/people/actual-public-ref",
  useRouter: () => ({ push: vi.fn() }),
}));
vi.mock("@capacitor/core", () => ({
  Capacitor: { getPlatform: () => "web", isNativePlatform: () => false },
  registerPlugin: () => ({}),
}));
vi.mock("@/hooks/use-auth", () => ({
  useAuth: () => ({ user: mocks.user, userId: mocks.user.uid, loading: false }),
}));
vi.mock("@/lib/vault/vault-context", () => ({
  useVault: () => ({ vaultOwnerToken: "owner-token", isVaultUnlocked: true }),
}));
vi.mock("@/lib/services/auth-service", () => ({
  AuthService: { getIdToken: async () => "viewer-token" },
}));
vi.mock("@/lib/services/person-profile-service", async (original) => ({
  ...await original<typeof import("@/lib/services/person-profile-service")>(),
  PersonProfileService: {
    getPublic: mocks.getPublic, getViewer: mocks.getViewer, getRelationship: mocks.getRelationship,
    removeConnection: mocks.removeConnection, getRequestHistory: async () => ({ bundles: [], nextCursor: null }),
  },
}));
vi.mock("@/lib/services/external-connector-service", () => ({
  ExternalConnectorService: { featureReadiness: mocks.featureReadiness },
}));
vi.mock("@/lib/services/drive-packet-service", () => ({
  DrivePacketService: { packets: mocks.packets },
}));
vi.mock("@/components/app-ui/app-page-shell", () => ({
  AppPageShell: ({ children }: { children: ReactNode }) => <main>{children}</main>,
}));
// These sibling flows are outside relationship and packet-browsing regressions.
vi.mock("@/components/consent/document-request-button", () => ({ DocumentRequestButton: () => null }));
vi.mock("@/components/consent/request-scope-button", () => ({ RequestScopeButton: () => null }));
vi.mock("@/components/wallet/request-cards-button", () => ({ RequestCardsButton: () => null }));
vi.mock("@/components/consent/packets/financial-packet-summaries", () => ({ FinancialPacketSummaries: () => null }));
vi.mock("@/components/vault/vault-unlock-dialog", () => ({ VaultUnlockDialog: () => null }));
vi.mock("@/lib/consent/use-person-information-request", () => ({
  usePersonInformationRequest: () => ({ pending: false, available: true, error: null }),
}));

import { PersonProfilePage } from "@/components/connections/person-profile-page";
import { CacheService } from "@/lib/services/cache-service";
import { publishValidatedAuthSessionPrincipal } from "@/lib/auth/session-owner";

beforeEach(() => {
  vi.clearAllMocks();
  CacheService.getInstance().clear();
  publishValidatedAuthSessionPrincipal({ firebaseUid: "viewer", ownerId: "viewer", accountGeneration: 0 });
  mocks.getPublic.mockResolvedValue({ personRef: "actual-public-ref", displayName: "Actual Person", photoUrl: null, verifiedRole: null });
  mocks.getViewer.mockResolvedValue(viewerProfile());
  mocks.getRelationship.mockImplementation(() => new Promise(() => {}));
  mocks.featureReadiness.mockResolvedValue({ driveAgentPackagesEnabled: false, features: { drive_period_packets: false } });
  mocks.packets.mockResolvedValue({ packets: [], nextCursor: null });
});

afterEach(() => {
  cleanup();
  CacheService.getInstance().clear();
  publishValidatedAuthSessionPrincipal(null);
});

describe("Person profile relationship controls", () => {
  it("opens removal from Connected without changing the connection on open", async () => {
    mocks.removeConnection.mockResolvedValue({ status: "none", connectionId: null, connectedAt: null, requestId: null });
    render(<PersonProfilePage personRef="actual-public-ref" initialProfile={null} />);

    const connection = await screen.findByRole("button", { name: "Connected, connection options" });
    expect(connection).toHaveTextContent("Connected");
    fireEvent.keyDown(connection, { key: "ArrowDown" });
    const remove = await screen.findByRole("menuitem", { name: "Remove connection" });
    expect(mocks.removeConnection).not.toHaveBeenCalled();

    mocks.getViewer.mockResolvedValue(viewerProfile({ relationship: {
      status: "none", connectionId: null, connectedAt: null, requestId: null,
    } }));
    fireEvent.click(remove);
    await waitFor(() => expect(mocks.removeConnection).toHaveBeenCalledWith("actual-public-ref", "viewer-token"));
    await screen.findByText("Not connected");
    expect(screen.queryByRole("button", { name: "Connected, connection options" })).toBeNull();
  });

  it("keeps listed packets browsable when period packets alone are enabled", async () => {
    mocks.featureReadiness.mockResolvedValue({ driveAgentPackagesEnabled: false, features: { drive_period_packets: true } });
    mocks.packets.mockImplementation(async (_token: string, guard: () => void) => {
      guard();
      return { packets: [{ packetId: "00000001-3333-4333-8333-333333333333", version: 2, listingRevision: 1,
        title: "Example Bank statements", description: "Synthetic statements", state: "ready", coverageSummary: "January to June 2026",
        gaps: [], documentCount: 3, verifiedAt: null, freshness: "current", assessmentScore: 95, importance: 100,
        suggestedPriceCents: 1234, priceCents: 1234, listingEnabled: true, canRequest: true, canList: false }], nextCursor: null };
    });
    render(<PersonProfilePage personRef="actual-public-ref" initialProfile={null} />);

    const list = await screen.findByRole("region", { name: "Available document packets" });
    expect(await within(list).findByRole("button", { name: /^Example Bank statements/ })).toHaveTextContent("$12.34");
    expect(within(list).getByRole("heading", { name: "Other document packets" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Available packets" })).not.toBeInTheDocument();
    expect(mocks.packets).toHaveBeenCalledWith("owner-token", expect.any(Function), "actual-public-ref", undefined);
  });
});
