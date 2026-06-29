import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

import { LocationChatPanel } from "@/components/one-location/redesign/location-chat-panel";
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
// Keep the overlay on its desktop (Dialog) branch if it mounts during a test.
vi.mock("@/hooks/use-mobile", () => ({ useIsMobile: () => false }));

const mockChat = vi.mocked(OneLocationService.chat);

describe("LocationChatPanel", () => {
  beforeEach(() => mockChat.mockReset());

  it("sends a message and renders the assistant reply", async () => {
    mockChat.mockResolvedValue({
      conversationId: "conv-1",
      response: "Stopped sharing with Mom.",
      isComplete: true,
      stateChanged: true,
    });

    render(<LocationChatPanel vaultOwnerToken="vault-token" />);

    fireEvent.change(screen.getByTestId("location-chat-input"), {
      target: { value: "stop sharing with Mom" },
    });
    fireEvent.click(screen.getByTestId("location-chat-send"));

    await waitFor(() =>
      expect(screen.getByText("Stopped sharing with Mom.")).toBeTruthy(),
    );
    expect(mockChat).toHaveBeenCalledWith({
      vaultOwnerToken: "vault-token",
      message: "stop sharing with Mom",
      conversationId: null,
    });
  });

  it("calls onStateChanged when the response reports a state change", async () => {
    mockChat.mockResolvedValue({
      conversationId: "conv-1",
      response: "Done.",
      isComplete: true,
      stateChanged: true,
    });
    const onStateChanged = vi.fn();

    render(<LocationChatPanel vaultOwnerToken="t" onStateChanged={onStateChanged} />);
    fireEvent.change(screen.getByTestId("location-chat-input"), {
      target: { value: "revoke all" },
    });
    fireEvent.click(screen.getByTestId("location-chat-send"));

    await waitFor(() => expect(onStateChanged).toHaveBeenCalledTimes(1));
  });

  it("reuses the conversationId returned by the first turn", async () => {
    mockChat.mockResolvedValue({
      conversationId: "conv-42",
      response: "ok",
      isComplete: true,
      stateChanged: false,
    });

    render(<LocationChatPanel vaultOwnerToken="t" />);
    const input = screen.getByTestId("location-chat-input");
    const send = screen.getByTestId("location-chat-send");

    fireEvent.change(input, { target: { value: "first" } });
    fireEvent.click(send);
    await waitFor(() => expect(mockChat).toHaveBeenCalledTimes(1));

    fireEvent.change(input, { target: { value: "second" } });
    fireEvent.click(send);
    await waitFor(() => expect(mockChat).toHaveBeenCalledTimes(2));

    expect(mockChat.mock.calls[1][0].conversationId).toBe("conv-42");
  });

  it("shows suggestion chips before any message and sends one on click", async () => {
    mockChat.mockResolvedValue({
      conversationId: "c",
      response: "Mom and Dad.",
      isComplete: true,
      stateChanged: false,
    });
    render(<LocationChatPanel vaultOwnerToken="t" />);

    fireEvent.click(screen.getByRole("button", { name: "Who can see me?" }));

    await waitFor(() =>
      expect(mockChat.mock.calls[0][0].message).toBe("Who can see me right now?"),
    );
  });

  it("renders a locked stub when there is no vault token", () => {
    render(<LocationChatPanel vaultOwnerToken={null} />);
    expect(screen.getByTestId("location-chat-panel")).toBeTruthy();
    expect(screen.getByText(/unlock your vault/i)).toBeTruthy();
    expect(screen.queryByTestId("location-chat-input")).toBeNull();
  });
});
