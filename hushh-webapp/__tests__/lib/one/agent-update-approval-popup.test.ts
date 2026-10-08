/**
 * Approving an Azure update keeps the person where they are.
 *
 * The click opens the Microsoft window before any await (popup blockers need
 * the gesture); the approval is recorded first, then that window, not this
 * tab, goes to Microsoft. A blocked popup still works: the tab redirects, as
 * it always did. Founder report 2026-10-05: approving from the profile pane
 * left for a whole new route.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  native: vi.fn(() => false),
  assign: vi.fn(),
  upgrade: vi.fn(),
  approve: vi.fn(),
  status: vi.fn(),
}));

vi.mock("@capacitor/core", () => ({ Capacitor: { isNativePlatform: mocks.native } }));
vi.mock("@/lib/utils/browser-navigation", () => ({ assignWindowLocation: mocks.assign }));
vi.mock("@/lib/services/api-service", () => ({
  ApiService: {
    beginAzureByocUpgrade: mocks.upgrade,
    approvePersonalAgentUpdate: mocks.approve,
    getPersonalAgentStatus: mocks.status,
  },
}));

import {
  approveAgentUpdate,
  azureUpdateIdempotencyKey,
  openAzureUpdateSignInPopup,
} from "@/lib/one/agent-update-approval";

const SIGN_IN = "https://login.microsoftonline.com/tenant/oauth2/v2.0/authorize?state=p";
const RELEASE = `rel_${"f".repeat(32)}`;

function fakePopup() {
  return { closed: false, location: { assign: vi.fn() }, focus: vi.fn(), close: vi.fn() };
}

beforeEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
  mocks.native.mockReturnValue(false);
  mocks.upgrade.mockResolvedValue({ authorizationUrl: SIGN_IN });
  mocks.approve.mockResolvedValue({ operationId: "op", releaseId: RELEASE, status: "scheduled" });
  mocks.status.mockResolvedValue({});
});

describe("approving an Azure update beside the app", () => {
  it("records the release, then sends the click's popup to Microsoft and keeps this tab", async () => {
    const popup = fakePopup();
    await expect(
      approveAgentUpdate({
        deploymentTarget: "user_azure",
        releaseId: RELEASE,
        idempotencyKey: "click",
        popup: popup as unknown as Window,
      }),
    ).resolves.toBe("signing_in_popup");
    expect(mocks.approve).toHaveBeenCalledWith({ releaseId: RELEASE, idempotencyKey: azureUpdateIdempotencyKey(RELEASE) });
    expect(mocks.approve.mock.invocationCallOrder[0]).toBeLessThan(mocks.upgrade.mock.invocationCallOrder[0]);
    expect(popup.location.assign).toHaveBeenCalledWith(SIGN_IN);
    expect(popup.focus).toHaveBeenCalled();
    expect(mocks.assign).not.toHaveBeenCalled();
  });

  it("falls back to this tab when the popup was blocked", async () => {
    await expect(
      approveAgentUpdate({ deploymentTarget: "user_azure", releaseId: RELEASE, idempotencyKey: "click", popup: null }),
    ).resolves.toBe("signing_in");
    expect(mocks.assign).toHaveBeenCalledWith(SIGN_IN);
  });

  it("falls back to this tab when the person closed the popup before Microsoft answered", async () => {
    const popup = { ...fakePopup(), closed: true };
    await expect(
      approveAgentUpdate({
        deploymentTarget: "user_azure",
        releaseId: RELEASE,
        idempotencyKey: "click",
        popup: popup as unknown as Window,
      }),
    ).resolves.toBe("signing_in");
    expect(popup.location.assign).not.toHaveBeenCalled();
    expect(mocks.assign).toHaveBeenCalledWith(SIGN_IN);
  });

  it("closes the empty popup when the approval is refused, and never signs in", async () => {
    const popup = fakePopup();
    mocks.approve.mockRejectedValue(new Error("AGENT_UPDATE_APPROVE_FAILED:503"));
    await expect(
      approveAgentUpdate({
        deploymentTarget: "user_azure",
        releaseId: RELEASE,
        idempotencyKey: "click",
        popup: popup as unknown as Window,
      }),
    ).rejects.toThrow("AGENT_UPDATE_APPROVE_FAILED:503");
    expect(popup.close).toHaveBeenCalled();
    expect(mocks.upgrade).not.toHaveBeenCalled();
    expect(mocks.assign).not.toHaveBeenCalled();
  });

  it("closes the popup when the hub refuses to start the sign-in", async () => {
    const popup = fakePopup();
    mocks.upgrade.mockRejectedValue(new Error("AZURE_UPGRADE_BEGIN_FAILED"));
    await expect(
      approveAgentUpdate({
        deploymentTarget: "user_azure",
        releaseId: RELEASE,
        idempotencyKey: "click",
        popup: popup as unknown as Window,
      }),
    ).rejects.toThrow("AZURE_UPGRADE_BEGIN_FAILED");
    expect(popup.close).toHaveBeenCalled();
    expect(popup.location.assign).not.toHaveBeenCalled();
  });

  it("opens the window only for an Azure agent on the web", () => {
    const popup = fakePopup();
    const open = vi.spyOn(window, "open").mockReturnValue(popup as unknown as Window);
    expect(openAzureUpdateSignInPopup("user_gcp")).toBeNull();
    expect(openAzureUpdateSignInPopup(null)).toBeNull();
    expect(open).not.toHaveBeenCalled();
    expect(openAzureUpdateSignInPopup("user_azure")).toBe(popup);
    expect(open).toHaveBeenCalledWith("about:blank", "hussh-azure-sign-in", expect.stringContaining("popup"));
    mocks.native.mockReturnValue(true);
    expect(openAzureUpdateSignInPopup("user_azure")).toBeNull();
    expect(open).toHaveBeenCalledOnce();
  });
});
