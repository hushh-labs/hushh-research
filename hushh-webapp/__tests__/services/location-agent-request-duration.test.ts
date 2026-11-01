import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockApiJson } = vi.hoisted(() => ({
  mockApiJson: vi.fn(),
}));

vi.mock("@/lib/services/api-client", () => ({
  ApiError: class ApiError extends Error {
    constructor(
      message: string,
      public readonly status: number,
      public readonly payload?: unknown,
    ) {
      super(message);
      this.name = "ApiError";
    }
  },
  apiJson: mockApiJson,
}));

vi.mock("@/lib/capacitor", () => ({
  HushhLocation: {
    getPermissionState: vi.fn(),
    getCurrentPosition: vi.fn(),
  },
}));

vi.mock("@/lib/observability/location-events", () => ({
  trackNearbyCheckOutCompleted: vi.fn(),
}));

import { OneLocationService } from "@/lib/one-location/service";

describe("OneLocationService request duration", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockApiJson.mockResolvedValue({});
  });

  it("sends the requested duration with an authenticated access request", async () => {
    mockApiJson.mockResolvedValueOnce({
      request: {
        id: "request_1",
        ownerUserId: "user_b",
        requesterUserId: "user_a",
        status: "pending",
      },
    });

    await OneLocationService.requestAccess({
      vaultOwnerToken: "vault-token",
      ownerUserId: "user_b",
      message: "Can you share?",
      requestedDurationHours: 24,
    });

    expect(mockApiJson).toHaveBeenCalledWith("/api/one/location/requests", {
      method: "POST",
      headers: {
        Authorization: "Bearer vault-token",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        ownerUserId: "user_b",
        message: "Can you share?",
        requestedDurationHours: 24,
      }),
    });
  });
});
