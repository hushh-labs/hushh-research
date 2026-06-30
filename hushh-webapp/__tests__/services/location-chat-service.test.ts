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
      body: JSON.stringify({
        message: "stop sharing with Mom",
        conversationId: "conv-1",
        actionResult: null,
        selectionResult: null,
      }),
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
    expect(body).toEqual({ message: "hi", conversationId: null, actionResult: null, selectionResult: null });
  });
});

describe("OneLocationService.chat actionResult", () => {
  beforeEach(() => mockApiJson.mockReset());

  it("sends actionResult and omits message when reporting completion", async () => {
    mockApiJson.mockResolvedValue({
      conversationId: "c1",
      response: "Done.",
      isComplete: true,
      stateChanged: true,
    });

    await OneLocationService.chat({
      vaultOwnerToken: "tok",
      conversationId: "c1",
      actionResult: { id: "a1", type: "publish_share", status: "completed" },
    });

    const body = JSON.parse((mockApiJson.mock.calls[0][1] as RequestInit).body as string);
    expect(body.actionResult).toEqual({ id: "a1", type: "publish_share", status: "completed" });
    expect(body.message ?? null).toBeNull();
  });
});

describe("OneLocationService.chat selectionResult", () => {
  beforeEach(() => mockApiJson.mockReset());

  it("sends selectionResult and omits message", async () => {
    mockApiJson.mockResolvedValue({ conversationId: "c1", response: "ok", isComplete: true, stateChanged: true });
    await OneLocationService.chat({
      vaultOwnerToken: "tok",
      conversationId: "c1",
      selectionResult: { id: "prm-1", kind: "select", selected: [{ grantId: "g1" }], status: "answered" },
    });
    const body = JSON.parse((mockApiJson.mock.calls[0][1] as RequestInit).body as string);
    expect(body.selectionResult).toEqual({ id: "prm-1", kind: "select", selected: [{ grantId: "g1" }], status: "answered" });
    expect(body.message ?? null).toBeNull();
  });
});
