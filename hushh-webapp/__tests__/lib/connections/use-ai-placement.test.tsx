import { renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { useAiPlacement } from "@/lib/connections/use-ai-placement";

const mocks = vi.hoisted(() => ({
  status: vi.fn(),
}));

vi.mock("@/lib/services/api-service", () => ({
  ApiService: {
    getPersonalAgentStatus: mocks.status,
  },
}));

describe("useAiPlacement", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("resolves active Hussh Pods on GCP and Azure to their backing cloud placement", async () => {
    const captureOwnerGuard = () => () => true;
    const resetVerification = vi.fn();

    mocks.status.mockResolvedValueOnce({
      hostingMode: "hussh_pods",
      deploymentTarget: "gcp",
      state: "active",
    });
    const gcp = renderHook(() => useAiPlacement(captureOwnerGuard, resetVerification));
    await waitFor(() => expect(gcp.result.current.placement).toBe("gcp"));
    expect(gcp.result.current.ownCloudProject).toBeNull();
    expect(resetVerification).toHaveBeenCalledWith(false);
    gcp.unmount();

    const azureGuard = () => () => true;
    const azureReset = vi.fn();
    mocks.status.mockResolvedValueOnce({
      hostingMode: "hussh_pods",
      deploymentTarget: "azure",
      state: "active",
    });
    const azure = renderHook(() => useAiPlacement(azureGuard, azureReset));
    await waitFor(() => expect(azure.result.current.placement).toBe("azure"));
    azure.unmount();
  });

  it("maps a failed pod status to unknown rather than leaving AI setup stuck pending", async () => {
    const captureOwnerGuard = () => () => true;
    const resetVerification = vi.fn();
    mocks.status.mockResolvedValueOnce({
      hostingMode: "byoc",
      deploymentTarget: "user_azure",
      state: "failed",
      cloudProject: "eastus2",
    });
    const failed = renderHook(() => useAiPlacement(captureOwnerGuard, resetVerification));
    await waitFor(() => expect(failed.result.current.placement).toBe("unknown"));
    failed.unmount();
  });

  it("maps Personal Sandbox (ace) non-failed states to shared so Setup > Cloud never locks during cold wake", async () => {
    for (const [state, expected] of [
      ["active", "shared"],
      ["connecting", "shared"],
      ["reserved", "shared"],
      ["provisioning", "shared"],
      ["failed", "unknown"],
    ] as const) {
      const guard = () => () => true;
      const reset = vi.fn();
      mocks.status.mockResolvedValueOnce({
        hostingMode: "hussh_pods",
        deploymentTarget: "ace",
        state,
      });
      const hook = renderHook(() => useAiPlacement(guard, reset));
      await waitFor(() => expect(hook.result.current.placement).toBe(expected));
      expect(hook.result.current.ownCloudProject).toBeNull();
      hook.unmount();
    }
  });
});
