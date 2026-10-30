/**
 * Approving an agent update binds the exact release the person was shown.
 *
 * An Azure agent records that approval through the same hub route as every
 * other home, under one key per release, and only then starts the person's
 * own Microsoft sign-in, which the hub's `upgrade/begin` requires.
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
  agentUpdateApprovalToast,
  approveAgentUpdate,
  azureUpdateApprovalErrorMessage,
  azureUpdateIdempotencyKey,
} from "@/lib/one/agent-update-approval";
import { AzureSignInUnavailableError } from "@/lib/one/azure-sign-in";
import { AzureByocError } from "@/lib/services/azure-byoc-contract";

const SIGN_IN = "https://login.microsoftonline.com/tenant/oauth2/v2.0/authorize?state=s";
const RELEASE = `rel_${"a".repeat(32)}`;
const AZURE = { deploymentTarget: "user_azure", releaseId: RELEASE, idempotencyKey: "random-click-key" };

function approvedStatus(releaseId: string, phase = "scheduled") {
  return {
    updateInProgress: true,
    update: { releaseId, operationId: `op_${"b".repeat(32)}`, presentationState: "scheduled", phase },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.native.mockReturnValue(false);
  mocks.upgrade.mockResolvedValue({ authorizationUrl: SIGN_IN });
  mocks.approve.mockResolvedValue({ operationId: "op", releaseId: RELEASE, status: "scheduled" });
  mocks.status.mockResolvedValue({});
});

describe("approving an agent update", () => {
  it.each(["user_gcp", "gcp", null])("schedules through the hub with the caller's key for a %s agent", async (deploymentTarget) => {
    await expect(
      approveAgentUpdate({ deploymentTarget, releaseId: "rel-1", idempotencyKey: "key-1" }),
    ).resolves.toBe("scheduled");
    expect(mocks.approve).toHaveBeenCalledWith({ releaseId: "rel-1", idempotencyKey: "key-1" });
    expect(mocks.upgrade).not.toHaveBeenCalled();
  });

  it("records the exact Azure release before the Microsoft sign-in starts", async () => {
    await expect(approveAgentUpdate(AZURE)).resolves.toBe("signing_in");
    expect(mocks.approve).toHaveBeenCalledWith({
      releaseId: RELEASE,
      idempotencyKey: azureUpdateIdempotencyKey(RELEASE),
    });
    expect(mocks.approve.mock.invocationCallOrder[0]).toBeLessThan(mocks.upgrade.mock.invocationCallOrder[0]);
    expect(mocks.assign).toHaveBeenCalledWith(SIGN_IN);
  });

  it("uses one key per release, so a person who cancelled can come back", async () => {
    await approveAgentUpdate(AZURE);
    await approveAgentUpdate({ ...AZURE, idempotencyKey: "another-click-key" });
    const [first, second] = mocks.approve.mock.calls.map(([input]) => input.idempotencyKey);
    expect(first).toBe(second);
    expect(azureUpdateIdempotencyKey(`rel_${"c".repeat(32)}`)).not.toBe(first);
    expect(first.length).toBeLessThanOrEqual(128);
    expect(() => azureUpdateIdempotencyKey(" ")).toThrow();
    expect(() => azureUpdateIdempotencyKey("r".repeat(128))).toThrow();
  });

  it("continues to the sign-in when this same release is already approved", async () => {
    mocks.approve.mockRejectedValue(new Error("AGENT_UPDATE_APPROVE_FAILED:409"));
    mocks.status.mockResolvedValue(approvedStatus(RELEASE));
    await expect(approveAgentUpdate(AZURE)).resolves.toBe("signing_in");
    expect(mocks.assign).toHaveBeenCalledWith(SIGN_IN);
  });

  it.each([
    ["no approval on record", {}],
    ["another release approved", approvedStatus(`rel_${"d".repeat(32)}`)],
    ["the update already moving", approvedStatus(RELEASE, "preparing")],
  ])("never signs in after a refused approval with %s", async (_label, status) => {
    mocks.approve.mockRejectedValue(new Error("AGENT_UPDATE_APPROVE_FAILED:409"));
    mocks.status.mockResolvedValue(status);
    await expect(approveAgentUpdate(AZURE)).rejects.toThrow("AGENT_UPDATE_APPROVE_FAILED:409");
    expect(mocks.upgrade).not.toHaveBeenCalled();
    expect(mocks.assign).not.toHaveBeenCalled();
  });

  it("records nothing on a device that cannot carry on to Microsoft", async () => {
    mocks.native.mockReturnValue(true);
    await expect(approveAgentUpdate(AZURE)).rejects.toBeInstanceOf(AzureSignInUnavailableError);
    expect(mocks.approve).not.toHaveBeenCalled();
    expect(mocks.upgrade).not.toHaveBeenCalled();
  });

  it("speaks one plain sentence for either half failing", () => {
    expect(azureUpdateApprovalErrorMessage(new Error("AGENT_UPDATE_APPROVE_FAILED:409"))).toMatch(/update changed/);
    expect(azureUpdateApprovalErrorMessage(new Error("AGENT_UPDATE_APPROVE_FAILED:503"))).toMatch(/keeps its current version/);
    expect(
      azureUpdateApprovalErrorMessage(
        new AzureByocError("AZURE_UPGRADE_BEGIN_FAILED", { serverCode: "X", serverMessage: "Sign in with the directory that holds your agent." }),
      ),
    ).toBe("Sign in with the directory that holds your agent.");
    expect(azureUpdateApprovalErrorMessage(new Error("NETWORK"))).toMatch(/keeps its current version/);
  });

  it("words the approve toast for the agent's home", () => {
    expect(agentUpdateApprovalToast("user_azure").loading).toBe("Opening Microsoft sign-in…");
    expect(agentUpdateApprovalToast("user_gcp")).toEqual({
      loading: "Scheduling your update…",
      success: "Update scheduled.",
      error: "We couldn’t complete that request. Try again.",
    });
  });
});
