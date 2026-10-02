import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  native: vi.fn(() => false),
  assign: vi.fn(),
  begin: vi.fn(),
  upgrade: vi.fn(),
  approve: vi.fn(),
}));

vi.mock("@capacitor/core", () => ({ Capacitor: { isNativePlatform: mocks.native } }));
vi.mock("@/lib/utils/browser-navigation", () => ({ assignWindowLocation: mocks.assign }));
vi.mock("@/lib/services/api-service", () => ({
  ApiService: {
    beginAzureByocAuthorize: mocks.begin,
    beginAzureByocUpgrade: mocks.upgrade,
    approvePersonalAgentUpdate: mocks.approve,
  },
}));

import { approveAgentUpdate } from "@/lib/one/agent-update-approval";
import {
  AzureSignInUnavailableError,
  azureRetryKind,
  azureSignInErrorMessage,
  startAzureSignIn,
} from "@/lib/one/azure-sign-in";
import { AzureByocError } from "@/lib/services/azure-byoc-contract";

const SIGN_IN = "https://login.microsoftonline.com/tenant/oauth2/v2.0/authorize?state=s";

describe("starting the Microsoft sign-in", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.native.mockReturnValue(false);
    mocks.begin.mockResolvedValue({ authorizationUrl: SIGN_IN });
    mocks.upgrade.mockResolvedValue({ authorizationUrl: SIGN_IN });
  });

  it("navigates to the setup sign-in, scoped to a subscription when given", async () => {
    await startAzureSignIn("setup");
    expect(mocks.begin).toHaveBeenLastCalledWith({});
    await startAzureSignIn("setup", "sub-1");
    expect(mocks.begin).toHaveBeenLastCalledWith({ subscriptionId: "sub-1" });
    expect(mocks.assign).toHaveBeenCalledWith(SIGN_IN);
    expect(mocks.upgrade).not.toHaveBeenCalled();
  });

  it("navigates to the update sign-in", async () => {
    await startAzureSignIn("upgrade");
    expect(mocks.upgrade).toHaveBeenCalledOnce();
    expect(mocks.assign).toHaveBeenCalledWith(SIGN_IN);
  });

  it("never navigates when the hub refuses", async () => {
    mocks.begin.mockRejectedValue(new AzureByocError("AZURE_AUTHORIZE_BEGIN_FAILED"));
    await expect(startAzureSignIn("setup")).rejects.toBeInstanceOf(AzureByocError);
    expect(mocks.assign).not.toHaveBeenCalled();
  });

  it("refuses in the mobile shells, which have no return leg yet", async () => {
    mocks.native.mockReturnValue(true);
    await expect(startAzureSignIn("setup")).rejects.toBeInstanceOf(AzureSignInUnavailableError);
    expect(mocks.begin).not.toHaveBeenCalled();
  });

  it("speaks one plain sentence for every failure", () => {
    expect(
      azureSignInErrorMessage(
        new AzureByocError("AZURE_AUTHORIZE_BEGIN_FAILED", { serverCode: "X", serverMessage: "Verify your phone number first." }),
        "setup",
      ),
    ).toBe("Verify your phone number first.");
    expect(azureSignInErrorMessage(new AzureByocError("AZURE_RESPONSE_INVALID"), "setup")).toMatch(/safely/);
    expect(azureSignInErrorMessage(new Error("NETWORK"), "setup")).toMatch(/Nothing in your subscription changed/);
    expect(azureSignInErrorMessage(new Error("NETWORK"), "upgrade")).toMatch(/keeps its current version/);
    expect(azureSignInErrorMessage(new Error("NETWORK"), "complete")).toMatch(/sign-in again/);
    expect(azureSignInErrorMessage(new AzureSignInUnavailableError(), "upgrade")).toMatch(/mobile app/);
    for (const stage of ["setup", "upgrade", "complete"] as const) {
      expect(azureSignInErrorMessage(new Error("AZURE_AUTHORIZE_BEGIN_FAILED"), stage)).not.toMatch(/AZURE_|_FAILED/);
    }
  });

  it("restarts the update sign-in only for an agent already in Azure", () => {
    expect(azureRetryKind({ deploymentTarget: "user_azure", state: "active" })).toBe("upgrade");
    expect(azureRetryKind({ deploymentTarget: "user_azure", state: "reserved" })).toBe("setup");
    expect(azureRetryKind({ deploymentTarget: "user_gcp", state: "active" })).toBe("setup");
    expect(azureRetryKind(null)).toBe("setup");
  });
});

describe("approving an agent update", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.native.mockReturnValue(false);
    mocks.upgrade.mockResolvedValue({ authorizationUrl: SIGN_IN });
    mocks.approve.mockResolvedValue({ operationId: "op", releaseId: "rel", status: "scheduled" });
  });

  it.each(["user_gcp", "gcp", null])("schedules through the hub for a %s agent", async (deploymentTarget) => {
    await expect(
      approveAgentUpdate({ deploymentTarget, releaseId: "rel-1", idempotencyKey: "key-1" }),
    ).resolves.toBe("scheduled");
    expect(mocks.approve).toHaveBeenCalledWith({ releaseId: "rel-1", idempotencyKey: "key-1" });
    expect(mocks.upgrade).not.toHaveBeenCalled();
  });

  it("starts the person's own Microsoft sign-in for an Azure agent", async () => {
    await expect(
      approveAgentUpdate({ deploymentTarget: "user_azure", releaseId: "rel-1", idempotencyKey: "key-1" }),
    ).resolves.toBe("signing_in");
    expect(mocks.upgrade).toHaveBeenCalledOnce();
    expect(mocks.assign).toHaveBeenCalledWith(SIGN_IN);
    expect(mocks.approve).not.toHaveBeenCalled();
  });
});
