import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";

import {
  LOCATION_CHAT_ERROR_TEXT,
  useLocationChat,
} from "@/components/one-location/redesign/use-location-chat";
import { OneLocationService } from "@/lib/one-location/service";

vi.mock("@/lib/one-location/service", () => ({
  OneLocationService: { chat: vi.fn() },
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

const mockChat = vi.mocked(OneLocationService.chat);

describe("useLocationChat", () => {
  beforeEach(() => mockChat.mockReset());

  it("appends user + assistant messages and reuses conversationId across turns", async () => {
    mockChat.mockResolvedValue({
      conversationId: "conv-42",
      response: "Mom and Dad.",
      isComplete: true,
      stateChanged: false,
    });
    const { result } = renderHook(() =>
      useLocationChat({ vaultOwnerToken: "t" }),
    );

    await act(async () => {
      await result.current.send("who can see me");
    });

    expect(result.current.messages.map((m) => [m.role, m.text])).toEqual([
      ["user", "who can see me"],
      ["assistant", "Mom and Dad."],
    ]);
    expect(mockChat.mock.calls[0][0].conversationId).toBeNull();

    await act(async () => {
      await result.current.send("second");
    });
    expect(mockChat.mock.calls[1][0].conversationId).toBe("conv-42");
  });

  it("flags stateChanged and notifies onStateChanged", async () => {
    mockChat.mockResolvedValue({
      conversationId: "c",
      response: "Done.",
      isComplete: true,
      stateChanged: true,
    });
    const onStateChanged = vi.fn();
    const { result } = renderHook(() =>
      useLocationChat({ vaultOwnerToken: "t", onStateChanged }),
    );

    await act(async () => {
      await result.current.send("revoke mom");
    });

    const assistant = result.current.messages[1];
    expect(assistant.stateChanged).toBe(true);
    expect(onStateChanged).toHaveBeenCalledTimes(1);
  });

  it("renders an errored assistant bubble and retry replaces it with a reply", async () => {
    mockChat.mockRejectedValueOnce(new Error("boom"));
    const { result } = renderHook(() =>
      useLocationChat({ vaultOwnerToken: "t" }),
    );

    await act(async () => {
      await result.current.send("do it");
    });
    expect(result.current.messages[1]).toMatchObject({
      role: "assistant",
      text: LOCATION_CHAT_ERROR_TEXT,
      errored: true,
    });

    mockChat.mockResolvedValueOnce({
      conversationId: "c",
      response: "Fixed.",
      isComplete: true,
      stateChanged: false,
    });
    await act(async () => {
      await result.current.retry();
    });

    // still one user bubble; errored bubble replaced by the reply
    expect(result.current.messages.map((m) => m.text)).toEqual(["do it", "Fixed."]);
    expect(mockChat).toHaveBeenCalledTimes(2);
    expect(mockChat.mock.calls[1][0].message).toBe("do it");
  });

  it("clear() empties messages and resets conversationId", async () => {
    mockChat.mockResolvedValue({
      conversationId: "c",
      response: "ok",
      isComplete: true,
      stateChanged: false,
    });
    const { result } = renderHook(() =>
      useLocationChat({ vaultOwnerToken: "t" }),
    );
    await act(async () => {
      await result.current.send("hi");
    });
    act(() => result.current.clear());
    expect(result.current.messages).toEqual([]);

    await act(async () => {
      await result.current.send("again");
    });
    expect(mockChat.mock.calls[1][0].conversationId).toBeNull();
  });
});
