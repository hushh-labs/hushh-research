import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { CheckInFlow } from "@/components/one-location/redesign/check-in-flow";
import type { LocationHubViewModel } from "@/components/one-location/redesign/location-redesign-hub";
import type { OneLocationRecipient } from "@/lib/one-location/types";

function currentPoint() {
  return {
    latitude: 37.4275,
    longitude: -122.1697,
    accuracyM: 8,
    capturedAt: new Date().toISOString(),
    sourcePlatform: "web" as const,
  };
}

function recipient(userId: string, displayName: string): OneLocationRecipient {
  return {
    userId,
    displayName,
    phoneVerified: true,
    keyId: `${userId}-key`,
    publicKeyJwk: { kty: "EC" },
    keyAlgorithm: "ECDH-ES+A256GCM",
    canReceiveLocation: true,
  };
}

function viewModel(
  onCheckIn: LocationHubViewModel["onCheckIn"],
  onDiscardPrivateCheckInOperation: LocationHubViewModel["onDiscardPrivateCheckInOperation"] = vi.fn(),
): LocationHubViewModel {
  const point = currentPoint();
  const recipients = [
    recipient("user-aarav", "Aarav Mehta"),
    recipient("user-maya", "Maya Chen"),
  ];
  return {
    busy: null,
    circles: [],
    sosRecipients: recipients,
    myLocationPoint: point,
    myLocationError: null,
    onShowMyLocation: vi.fn(),
    onCheckIn,
    onDiscardPrivateCheckInOperation,
    isRecipientShareReady: () => true,
    recipientLabel: (value) => value.displayName,
    formatDateTime: () => "just now",
    renderMapPreview: () => null,
  } as unknown as LocationHubViewModel;
}

describe("CheckInFlow nearby private-sharing handoff", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("recenters a confirmed check-in without capturing location again", async () => {
    const onCheckIn = vi
      .fn<LocationHubViewModel["onCheckIn"]>()
      .mockResolvedValue({
        succeededRecipientIds: [],
        failedRecipientIds: ["user-aarav"],
      });
    const vm = viewModel(onCheckIn);
    vm.renderMapPreview = vi.fn((_point, _showNavigation, resetKey) => (
      <span data-testid="check-in-map-reset-key">{String(resetKey)}</span>
    ));

    render(
      <CheckInFlow vm={vm} entrySource="nearby" onClose={vi.fn()} />,
    );

    expect(screen.getByTestId("check-in-map-reset-key")).toHaveTextContent(
      "check-in:0",
    );
    fireEvent.click(screen.getByRole("button", { name: /Aarav Mehta/ }));
    fireEvent.click(
      screen.getByRole("button", {
        name: "Share encrypted location with 1 person",
      }),
    );
    await waitFor(() => expect(onCheckIn).toHaveBeenCalledTimes(1));

    fireEvent.click(
      screen.getByRole("button", {
        name: "Recenter map on the confirmed check-in location",
      }),
    );

    expect(screen.getByTestId("check-in-map-reset-key")).toHaveTextContent(
      "check-in:1",
    );
    expect(vm.onShowMyLocation).not.toHaveBeenCalled();
  });

  it("starts with explicit selection and retries only failed recipients", async () => {
    const onCheckIn = vi
      .fn<LocationHubViewModel["onCheckIn"]>()
      .mockResolvedValueOnce({
        succeededRecipientIds: ["user-aarav"],
        failedRecipientIds: ["user-maya"],
      })
      .mockResolvedValueOnce({
        succeededRecipientIds: ["user-maya"],
        failedRecipientIds: [],
      });

    render(
      <CheckInFlow
        vm={viewModel(onCheckIn)}
        entrySource="nearby"
        onClose={vi.fn()}
      />,
    );

    expect(
      screen.getByTestId("nearby-private-share-disclosure"),
    ).toHaveTextContent(/Nearby people can see your name only/i);
    expect(
      screen.getByRole("button", { name: "Select who should know" }),
    ).toBeDisabled();

    fireEvent.click(screen.getByRole("button", { name: /Aarav Mehta/ }));
    fireEvent.click(screen.getByRole("button", { name: /Maya Chen/ }));
    fireEvent.click(
      screen.getByRole("button", {
        name: "Share encrypted location with 2 people",
      }),
    );

    await waitFor(() => {
      expect(onCheckIn).toHaveBeenNthCalledWith(
        1,
        expect.objectContaining({
          recipientIds: ["user-aarav", "user-maya"],
          durationHours: "1",
          message: "I've checked in here, let's catch up",
          point: expect.objectContaining({
            latitude: 37.4275,
            longitude: -122.1697,
          }),
          clientOperationId: expect.any(String),
          confirmedAt: expect.any(String),
        }),
      );
    });
    const firstRequest = onCheckIn.mock.calls[0]![0];

    const retry = await screen.findByRole("button", {
      name: "Share encrypted location with 1 person",
    });
    expect(screen.getByRole("button", { name: /Aarav Mehta/ })).toBeDisabled();
    expect(screen.getByRole("button", { name: "30 min" })).toBeDisabled();
    expect(
      screen.getByPlaceholderText("I've checked in here, let's catch up"),
    ).toBeDisabled();
    expect(
      screen.getByText(/sends only to people who still failed/i),
    ).toBeInTheDocument();
    expect(
      screen.getByTestId("private-check-in-partial-success"),
    ).toHaveTextContent(
      /They keep the original encrypted location, duration, and message/i,
    );
    fireEvent.click(retry);

    await waitFor(() => {
      expect(onCheckIn).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({
          recipientIds: ["user-maya"],
          durationHours: "1",
          message: "I've checked in here, let's catch up",
          point: firstRequest.point,
          clientOperationId: firstRequest.clientOperationId,
          confirmedAt: firstRequest.confirmedAt,
        }),
      );
    });
  });

  it("expires an uncompleted confirmation and lets only remaining people be reconfirmed", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-31T08:00:00.000Z"));
    const onCheckIn = vi
      .fn<LocationHubViewModel["onCheckIn"]>()
      .mockResolvedValue({
        succeededRecipientIds: ["user-aarav"],
        failedRecipientIds: ["user-maya"],
      });
    const onDiscardPrivateCheckInOperation =
      vi.fn<LocationHubViewModel["onDiscardPrivateCheckInOperation"]>();

    render(
      <CheckInFlow
        vm={viewModel(onCheckIn, onDiscardPrivateCheckInOperation)}
        entrySource="nearby"
        onClose={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /Aarav Mehta/ }));
    fireEvent.click(screen.getByRole("button", { name: /Maya Chen/ }));
    await act(async () => {
      fireEvent.click(
        screen.getByRole("button", {
          name: "Share encrypted location with 2 people",
        }),
      );
      await Promise.resolve();
    });

    expect(
      screen.getByRole("button", {
        name: "Edit remaining details and reconfirm",
      }),
    ).toBeInTheDocument();

    act(() => {
      vi.advanceTimersByTime(10 * 60_000 + 5_000);
    });

    expect(
      screen.getByRole("button", { name: "Confirmation expired" }),
    ).toBeDisabled();
    expect(
      screen.getByText(/This confirmation expired/i),
    ).toBeInTheDocument();
    expect(onDiscardPrivateCheckInOperation).toHaveBeenCalledWith(
      expect.any(String),
    );

    fireEvent.click(
      screen.getByRole("button", {
        name: "Edit remaining details and reconfirm",
      }),
    );

    expect(screen.getByRole("button", { name: /Aarav Mehta/ })).toBeDisabled();
    expect(screen.getByRole("button", { name: /Maya Chen/ })).toBeEnabled();
    expect(screen.getByRole("button", { name: "30 min" })).toBeEnabled();
    expect(
      screen.getByPlaceholderText("I've checked in here, let's catch up"),
    ).toBeEnabled();
    expect(
      screen.getByTestId("private-check-in-partial-success"),
    ).toHaveTextContent(/Any edits apply only to people/i);
  });

  it("requires a new confirmation when a failed recipient rotates keys", async () => {
    const onCheckIn = vi
      .fn<LocationHubViewModel["onCheckIn"]>()
      .mockResolvedValue({
        succeededRecipientIds: [],
        failedRecipientIds: ["user-aarav"],
      });
    const onDiscardPrivateCheckInOperation =
      vi.fn<LocationHubViewModel["onDiscardPrivateCheckInOperation"]>();
    const vm = viewModel(onCheckIn, onDiscardPrivateCheckInOperation);
    const { rerender } = render(
      <CheckInFlow vm={vm} entrySource="nearby" onClose={vi.fn()} />,
    );

    fireEvent.click(screen.getByRole("button", { name: /Aarav Mehta/ }));
    fireEvent.click(
      screen.getByRole("button", {
        name: "Share encrypted location with 1 person",
      }),
    );
    await waitFor(() => expect(onCheckIn).toHaveBeenCalledTimes(1));
    await screen.findByRole("button", {
      name: "Edit details and reconfirm",
    });
    const operationId = onCheckIn.mock.calls[0]![0].clientOperationId;

    vm.sosRecipients = vm.sosRecipients.map((value) =>
      value.userId === "user-aarav"
        ? { ...value, keyId: "user-aarav-rotated-key" }
        : value,
    );
    rerender(<CheckInFlow vm={vm} entrySource="nearby" onClose={vi.fn()} />);

    expect(
      screen.getByRole("button", { name: "Secure key changed — reconfirm" }),
    ).toBeDisabled();
    expect(
      screen.getByText(/selected person's secure key changed/i),
    ).toBeInTheDocument();
    await waitFor(() =>
      expect(onDiscardPrivateCheckInOperation).toHaveBeenCalledWith(
        operationId,
      ),
    );
  });

  it("cancels without creating a private share", () => {
    const onCheckIn = vi.fn<LocationHubViewModel["onCheckIn"]>();
    const onDiscardPrivateCheckInOperation =
      vi.fn<LocationHubViewModel["onDiscardPrivateCheckInOperation"]>();
    const onClose = vi.fn();

    render(
      <CheckInFlow
        vm={viewModel(onCheckIn, onDiscardPrivateCheckInOperation)}
        entrySource="nearby"
        onClose={onClose}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onCheckIn).not.toHaveBeenCalled();
    expect(onDiscardPrivateCheckInOperation).toHaveBeenCalledWith(null);
  });
});
