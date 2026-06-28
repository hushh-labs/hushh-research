import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockApiJson } = vi.hoisted(() => ({
  mockApiJson: vi.fn(),
}));

vi.mock("@/lib/services/api-client", () => ({
  apiJson: mockApiJson,
  ApiError: class ApiError extends Error {
    status: number;
    constructor(message: string, status: number) {
      super(message);
      this.status = status;
    }
  },
}));

vi.mock("@/lib/capacitor", () => ({
  HushhLocation: {
    getPermissionState: vi.fn(),
    getCurrentPosition: vi.fn(),
    watchPosition: vi.fn(),
    clearWatch: vi.fn(),
    openAppSettings: vi.fn(),
    openLocationSettings: vi.fn(),
    requestLocationPermission: vi.fn(),
  },
}));

import { OneLocationService } from "@/lib/one-location/service";

describe("OneLocationService.chat", () => {
  beforeEach(() => mockApiJson.mockReset());

  it("posts message + conversationId to the chat endpoint with auth header", async () => {
    mockApiJson.mockResolvedValue({
      conversationId: "conv-1",
      response: "Stopped sharing with Mom.",
      isComplete: true,
      stateChanged: true,
    });

    const result = await OneLocationService.chat({
      vaultOwnerToken: "vault-token",
      message: "stop sharing with Mom",
      conversationId: "conv-1",
    });

    expect(mockApiJson).toHaveBeenCalledWith("/api/one/location/chat", {
      method: "POST",
      headers: {
        Authorization: "Bearer vault-token",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ message: "stop sharing with Mom", conversationId: "conv-1" }),
    });
    expect(result.stateChanged).toBe(true);
  });

  it("sends null conversationId when not provided", async () => {
    mockApiJson.mockResolvedValue({
      conversationId: "conv-new",
      response: "ok",
      isComplete: true,
      stateChanged: true,
    });

    await OneLocationService.chat({ vaultOwnerToken: "t", message: "hi" });

    const body = JSON.parse((mockApiJson.mock.calls[0][1] as RequestInit).body as string);
    expect(body).toEqual({ message: "hi", conversationId: null });
  });
});
