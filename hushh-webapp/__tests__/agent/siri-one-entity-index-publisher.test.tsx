import { render, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  auth: { user: { uid: "owner-1" } as { uid: string } | null, loading: false },
  vaultOwnerToken: "vault-owner-token" as string | null,
  updateEntityIndex: vi.fn(),
  clear: vi.fn(),
  listRecipients: vi.fn(),
  listCircles: vi.fn(),
}));

vi.mock("@/hooks/use-auth", () => ({ useAuth: () => mocks.auth }));
vi.mock("@/lib/vault/vault-context", () => ({
  useVault: () => ({ vaultOwnerToken: mocks.vaultOwnerToken }),
}));
vi.mock("@/lib/capacitor/one-system-action-invocation", () => ({
  OneSystemActionInvocationBridge: {
    isSupported: () => true,
    updateEntityIndex: mocks.updateEntityIndex,
    clear: mocks.clear,
  },
}));
vi.mock("@/lib/one-location/service", () => ({
  OneLocationService: {
    listRecipients: mocks.listRecipients,
    listCircles: mocks.listCircles,
  },
}));

import { SiriOneEntityIndexPublisher } from "@/components/agent/siri-one-entity-index-publisher";

describe("SiriOneEntityIndexPublisher", () => {
  beforeEach(() => {
    mocks.auth = { user: { uid: "owner-1" }, loading: false };
    mocks.vaultOwnerToken = "vault-owner-token";
    mocks.updateEntityIndex.mockReset().mockResolvedValue(true);
    mocks.clear.mockReset().mockResolvedValue(undefined);
    mocks.listRecipients.mockReset().mockResolvedValue([
      {
        userId: "contact-1",
        displayName: "Kushal",
        phoneNumber: "+15550000000",
        latitude: 47.61,
        longitude: -122.33,
      },
    ]);
    mocks.listCircles.mockReset().mockResolvedValue([
      {
        id: "circle-1",
        name: "Family",
        inviteCode: "private-code",
        memberIds: ["contact-1"],
      },
    ]);
  });

  it("publishes only stable ids and display names from existing Location models", async () => {
    render(<SiriOneEntityIndexPublisher />);

    await waitFor(() =>
      expect(mocks.updateEntityIndex).toHaveBeenCalledWith({
        ownerId: "owner-1",
        contacts: [{ id: "contact-1", name: "Kushal" }],
        circles: [{ id: "circle-1", name: "Family" }],
      }),
    );
    expect(mocks.listRecipients).toHaveBeenCalledWith("vault-owner-token");
    expect(mocks.listCircles).toHaveBeenCalledWith("vault-owner-token");
  });

  it("clears the owner-bound index after sign-out", async () => {
    mocks.auth = { user: null, loading: false };
    mocks.vaultOwnerToken = null;

    render(<SiriOneEntityIndexPublisher />);

    await waitFor(() =>
      expect(mocks.clear).toHaveBeenCalledWith({
        outcome: "sign_out",
        clearEntityIndex: true,
      }),
    );
    expect(mocks.updateEntityIndex).not.toHaveBeenCalled();
  });
});
