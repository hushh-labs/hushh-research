import { act, render, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  owner: "owner-a",
  token: "synthetic-owner-token" as string | null,
  sharing: { effective: "sharing", precision: "precise" },
  state: {
    ownerGrants: [{ id: "grant-a", ownerUserId: "owner-a", recipientUserId: "recipient-a", recipientKeyId: "key-a", status: "active" }],
    recipients: [{ userId: "recipient-a", keyId: "key-a", publicKeyJwk: { kty: "EC" } }],
  },
  sync: vi.fn(async (_options: { enabled: boolean; session: unknown }) => true),
  stop: vi.fn(async () => undefined),
}));
vi.mock("@capacitor/core", () => ({ Capacitor: { isNativePlatform: () => true } }));
vi.mock("@/hooks/use-auth", () => ({ useAuth: () => ({ userId: mocks.owner }) }));
vi.mock("@/lib/vault/vault-context", () => ({ useVault: () => ({ vaultOwnerToken: mocks.token }) }));
vi.mock("@/lib/location/sharing-state", () => ({
  useLocationSharingState: () => mocks.sharing,
  useOneLocationStateSnapshot: () => mocks.state,
  activeOwnerGrants: (state: typeof mocks.state) => state.ownerGrants,
}));
vi.mock("@/lib/capacitor", () => ({ HushhLocation: { stopBackgroundShare: mocks.stop, addListener: vi.fn(async () => ({ remove: vi.fn() })) } }));
vi.mock("@/lib/one-location/background-share-runtime", () => ({ syncBackgroundShare: mocks.sync }));
vi.mock("@/lib/services/api-service", () => ({ getApiBaseUrl: () => "https://fixture.invalid" }));
vi.mock("@/lib/morphy-ux/morphy", () => ({ morphyToast: { error: vi.fn() } }));

import { BackgroundLocationPublisherBridge } from "../background-location-publisher-bridge";
import { forgetOneLocationControlPreference, updateOneLocationControlState } from "@/lib/one-location/location-control-state";

function accept() {
  act(() => { updateOneLocationControlState("owner-a", (current) => ({ ...current, backgroundSharingEnabled: true, backgroundDisclosureVersion: 1 })); });
}
beforeEach(() => {
  vi.clearAllMocks(); mocks.sync.mockResolvedValue(true);
  mocks.owner = "owner-a"; mocks.token = "synthetic-owner-token";
  mocks.sharing = { effective: "sharing", precision: "precise" };
  forgetOneLocationControlPreference("owner-a"); forgetOneLocationControlPreference("owner-b");
});

describe("native background device intent", () => {
  it("requires disclosure opt-in and never borrows another owner's consent", async () => {
    const { rerender } = render(<BackgroundLocationPublisherBridge />);
    expect(mocks.sync).toHaveBeenLastCalledWith(expect.objectContaining({ enabled: false }));
    accept();
    await waitFor(() => expect(mocks.sync).toHaveBeenLastCalledWith(expect.objectContaining({ enabled: true })));
    mocks.sync.mockClear(); mocks.owner = "owner-b";
    rerender(<BackgroundLocationPublisherBridge />);
    expect(mocks.sync).toHaveBeenCalled();
    expect(mocks.sync.mock.calls.every(([options]) => !(options as { enabled: boolean }).enabled)).toBe(true);
  });

  it("stops on opt-out and clears a refused native start", async () => {
    accept();
    const { rerender } = render(<BackgroundLocationPublisherBridge />);
    mocks.sharing = { ...mocks.sharing, effective: "off" };
    rerender(<BackgroundLocationPublisherBridge />);
    expect(mocks.sync).toHaveBeenLastCalledWith(expect.objectContaining({ enabled: false }));
    mocks.sync.mockResolvedValueOnce(false);
    mocks.sharing = { ...mocks.sharing, effective: "sharing" };
    rerender(<BackgroundLocationPublisherBridge />);
    await waitFor(() => expect(mocks.sync).toHaveBeenLastCalledWith(expect.objectContaining({ enabled: false })));
  });
});

describe("native background authority inputs", () => {
  it("reconciles recipient-key arrival and precision changes", () => {
    accept();
    const recipients = mocks.state.recipients; mocks.state = { ...mocks.state, recipients: [] };
    const { rerender } = render(<BackgroundLocationPublisherBridge />);
    expect(mocks.sync).toHaveBeenLastCalledWith(expect.objectContaining({ session: expect.objectContaining({ grants: [] }) }));
    mocks.state = { ...mocks.state, recipients };
    mocks.sharing = { ...mocks.sharing, precision: "approximate" };
    rerender(<BackgroundLocationPublisherBridge />);
    expect(mocks.sync).toHaveBeenLastCalledWith(expect.objectContaining({ session: expect.objectContaining({ grants: [expect.objectContaining({ grantId: "grant-a", precision: "approximate" })] }) }));
  });

  it("removes native authority when the vault locks and on owner disposal", () => {
    accept();
    const { rerender, unmount } = render(<BackgroundLocationPublisherBridge />);
    mocks.token = null; rerender(<BackgroundLocationPublisherBridge />);
    expect(mocks.sync).toHaveBeenLastCalledWith(expect.objectContaining({ session: null }));
    unmount(); expect(mocks.stop).toHaveBeenCalled();
  });
});
