import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import ts from "typescript";
import * as observability from "@/lib/observability/client";

import { CheckInFlow } from "@/components/one-location/redesign/check-in-flow";
import { prepareLocalOnboardingAction, resolveLocalOnboardingHandler } from "@/lib/agent/local-onboarding-actions";
import { commandContinuation } from "@/lib/one-location/command-continuation";
import type { LocationHubViewModel } from "@/components/one-location/redesign/location-redesign-hub";
import type {
  OneLocationCircleSummary,
  OneLocationRecipient,
} from "@/lib/one-location/types";

function currentPoint() {
  return {
    latitude: 37.4275,
    longitude: -122.1697,
    accuracyM: 8,
    capturedAt: new Date().toISOString(),
    sourcePlatform: "web" as const,
  };
}

function recipient(
  userId: string,
  displayName: string,
  connectedFromContacts = false,
): OneLocationRecipient {
  return {
    userId,
    displayName,
    phoneVerified: true,
    keyId: `${userId}-key`,
    publicKeyJwk: { kty: "EC" },
    keyAlgorithm: "ECDH-ES+A256GCM",
    canReceiveLocation: true,
    connectedFromContacts,
  };
}

function viewModel(
  onCheckIn: LocationHubViewModel["onCheckIn"],
  onDiscardPrivateCheckInOperation: LocationHubViewModel["onDiscardPrivateCheckInOperation"] = vi.fn(),
): LocationHubViewModel {
  const point = currentPoint();
  const recipients = [
    recipient("user-aarav", "Aarav Mehta", true),
    recipient("user-maya", "Maya Chen"),
  ];
  return {
    userId: "owner",
    activeOwnerGrants: [],
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

// Execute the real page callback without mounting the unrelated map, transport
// and account boot tree. Only its existing execution ports are synthetic; the
// callback body and result classifier come directly from the production page.
function pageCheckInHandler(encryptLocationForRecipient: ReturnType<typeof vi.fn>, createGrantWithEnvelope: ReturnType<typeof vi.fn>, recipients: OneLocationRecipient[]) {
  const file = ts.createSourceFile("page.tsx", readFileSync("app/one/location/page.tsx", "utf8"),
    ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let callback: ts.Node | undefined, classifier: ts.Node | undefined;
  const visit = (node: ts.Node) => {
    if (ts.isVariableDeclaration(node) && node.name.getText(file) === "handleCheckIn"
      && node.initializer && ts.isCallExpression(node.initializer)) callback = node.initializer.arguments[0];
    if (ts.isFunctionDeclaration(node) && node.name?.text === "oneLocationEventResult") classifier = node;
    ts.forEachChild(node, visit);
  };
  visit(file);
  if (!callback || !classifier) throw new Error("Missing production Check-in owner");
  const share = vi.fn();
  const ports = {
    auth: { userId: "owner" }, vaultOwnerToken: "synthetic-owner-token", permission: "granted",
    sosActionRecipients: recipients, isShareReadyRecipient: () => true, locationPermissionBlocksSharing: () => false,
    shareAudienceOwnerUserIdRef: { current: "owner" },
    checkInOperations: { current: { begin: () => ({}), finish: () => true } },
    setBusy: vi.fn(), ensureForegroundLocationReady: async () => ({ ready: true }), encryptLocationForRecipient,
    OneLocationService: { createGrantWithEnvelope },
    privateCheckInEnvelopeCacheRef: { current: new Map() }, trackLocationShareConfirmed: share,
    trackEvent: observability.trackEvent, oneLocationDurationBucket: (value: string) => value,
    toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() }, peopleCountLabel: String,
    setShareCompletedTick: vi.fn(), refresh: async () => undefined,
  };
  const javascript = ts.transpileModule(`${classifier.getText(file)}\nconst callback = ${callback.getText(file)};`,
    { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  const onCheckIn = new Function(...Object.keys(ports), `${javascript}\nreturn callback;`)(...Object.values(ports)) as LocationHubViewModel["onCheckIn"];
  return { onCheckIn, share };
}

describe("CheckInFlow nearby private-sharing handoff", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it.each([
    { label: "success", succeeded: ["user-aarav", "user-maya"], failed: [], result: "success", throws: false },
    { label: "partial failure", succeeded: ["user-aarav"], failed: ["user-maya"], result: "error", throws: false },
    { label: "all failed", succeeded: [], failed: ["user-aarav", "user-maya"], result: "error", throws: false },
    { label: "thrown failure", succeeded: [], failed: ["user-aarav", "user-maya"], result: "error", throws: true },
  ])("records $label exactly once through the page owner", async (outcome) => {
    const event = vi.spyOn(observability, "trackEvent").mockReturnValue(true);
    const encrypt = outcome.throws ? vi.fn().mockRejectedValue(new Error("Synthetic preparation failure"))
      : vi.fn().mockResolvedValue({ synthetic: true });
    const createGrant = vi.fn(async ({ recipientUserId }: { recipientUserId: string }) => {
      if (outcome.failed.includes(recipientUserId)) throw new Error("Synthetic delivery failure");
    });
    const vm = viewModel(vi.fn());
    const owner = pageCheckInHandler(encrypt, createGrant, vm.sosRecipients);
    vm.onCheckIn = owner.onCheckIn;
    render(<CheckInFlow vm={vm} entrySource="nearby" onClose={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: /^(?!View ).*Aarav Mehta/ }));
    fireEvent.click(screen.getByRole("button", { name: /^(?!View ).*Maya Chen/ }));
    fireEvent.click(screen.getByRole("button", { name: "Share location with 2 people" }));
    await waitFor(() => expect(event.mock.calls.filter(([name]) => name === "one_location_check_in_completed")).toHaveLength(1));
    expect(encrypt).toHaveBeenCalledTimes(2);
    expect(createGrant).toHaveBeenCalledTimes(outcome.throws ? 0 : 2);
    expect(owner.share).toHaveBeenCalledTimes(1);
    expect(event).toHaveBeenCalledWith("one_location_check_in_completed", {
      route_id: "one_location", result: outcome.result, selected_count: 2,
      success_count: outcome.succeeded.length, failure_count: outcome.failed.length, circle_targeted: false,
    });
    expect(owner.share).toHaveBeenCalledWith(expect.objectContaining({
      result: outcome.result, success_count: outcome.succeeded.length, failure_count: outcome.failed.length,
    }));
  });

  it("binds a private command draft without sending coordinates or its note to preparation", async () => {
    const onCheckIn = vi.fn<LocationHubViewModel["onCheckIn"]>().mockResolvedValue({succeededRecipientIds:["user-aarav"],failedRecipientIds:[]});
    const vm = viewModel(onCheckIn);
    render(<CheckInFlow vm={vm} entrySource="nearby" onClose={vi.fn()} />);
    fireEvent.click(screen.getByRole("button",{name:/^(?!View ).*Aarav Mehta/}));
    const note = screen.getByPlaceholderText("I've checked in here, let's catch up");
    fireEvent.change(note,{target:{value:"Synthetic private note"}});
    const first = await prepareLocalOnboardingAction("location.send_check_in",{});
    expect(first?.status).toBe("ready");
    if (first?.status !== "ready") throw new Error("Expected prepared command");
    expect(first.binding.owner).toBe("owner");
    expect(first.binding.recipientIds).toEqual(["user-aarav"]);
    expect(first.binding.privateDraftDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(first.binding)).not.toMatch(/latitude|longitude|Synthetic private note/);
    expect((await prepareLocalOnboardingAction("location.send_check_in",{}))).toEqual(first);
    fireEvent.change(note,{target:{value:"Changed private note"}});
    const changed = await prepareLocalOnboardingAction("location.send_check_in",{});
    expect(changed?.status === "ready" && changed.binding.privateDraftDigest).not.toBe(first.binding.privateDraftDigest);
    const handler = resolveLocalOnboardingHandler("location.send_check_in")!;
    const signal = new AbortController().signal;
    await act(async()=>{ await handler({}, {operationId:"a".repeat(64),confirmedAt:new Date().toISOString(),signal}); });
    expect(onCheckIn).toHaveBeenCalledWith(expect.objectContaining({commandOperationId:"a".repeat(64),commandOwner:"owner",commandSignal:signal,message:"Changed private note",point:vm.myLocationPoint}));
  });

  it("identifies a connected person who came from contact sync", () => {
    render(
      <CheckInFlow
        vm={viewModel(vi.fn())}
        entrySource="nearby"
        onClose={vi.fn()}
      />,
    );

    expect(
      screen.getByLabelText("Connected from your contacts"),
    ).toBeInTheDocument();
  });

  it("restores the exact private draft after remount and renews only pending delivery",async()=>{
    vi.useFakeTimers({toFake:["Date"]});
    const started=Date.now();
    const firstSend=vi.fn<LocationHubViewModel["onCheckIn"]>().mockResolvedValue({succeededRecipientIds:["user-aarav"],failedRecipientIds:["user-maya"]});
    const vm=viewModel(firstSend);
    const firstScreen=render(<CheckInFlow vm={vm} entrySource="nearby" onClose={vi.fn()}/>);
    fireEvent.click(screen.getByRole("button",{name:/^(?!View ).*Aarav Mehta/}));
    fireEvent.click(screen.getByRole("button",{name:/^(?!View ).*Maya Chen/}));
    fireEvent.change(screen.getByPlaceholderText("I've checked in here, let's catch up"),{target:{value:"Synthetic original note"}});
    let prepared=await prepareLocalOnboardingAction("location.send_check_in",{});
    if (prepared?.status!=="ready" || !prepared.privateContinuation) throw Error("Expected retained draft");
    const original=prepared;
    await act(async()=>{await resolveLocalOnboardingHandler("location.send_check_in")!({}, {
      operationId:"a".repeat(64),preparedBinding:original.binding,privateContinuation:original.privateContinuation,confirmedAt:new Date().toISOString(),
    });});
    firstScreen.unmount();
    vi.setSystemTime(started+120_000);
    const send=vi.fn<LocationHubViewModel["onCheckIn"]>().mockResolvedValue({succeededRecipientIds:["user-maya"],failedRecipientIds:[]});
    const nextVM=viewModel(send); // Fresh ambient position MUST NOT replace the original.
    render(<CheckInFlow vm={nextVM} entrySource="nearby" onClose={vi.fn()}/>);
    const continuation=commandContinuation({kind:"audience",operation_id:"a".repeat(64),snapshot:"b".repeat(64),total_units:2,completed_unit_indices:[0],pending_unit_indices:[1]},original.binding);
    await act(async()=>{prepared=await prepareLocalOnboardingAction("location.send_check_in",{},undefined,undefined,continuation,original.privateContinuation);});
    expect(prepared).toMatchObject({status:"ready",binding:original.binding,privateContinuation:original.privateContinuation});
    expect(screen.getByPlaceholderText("I've checked in here, let's catch up")).toHaveValue("Synthetic original note");
    await act(async()=>{await resolveLocalOnboardingHandler("location.send_check_in")!({}, {
      operationId:"a".repeat(64),directiveId:"renewed",preparedBinding:original.binding,privateContinuation:original.privateContinuation,
      continuation,confirmedAt:new Date().toISOString(),
    });});
    expect(send).toHaveBeenCalledOnce();
    expect(send).toHaveBeenCalledWith(expect.objectContaining({recipientIds:["user-maya"],point:vm.myLocationPoint,
      message:"Synthetic original note",confirmedAt:original.privateContinuation!.reviewedAt,commandDirectiveId:"renewed"}));
    expect(send.mock.calls[0]![0].point.capturedAt).not.toBe(nextVM.myLocationPoint?.capturedAt);
    vi.setSystemTime(started+11*60_000);
    expect(await prepareLocalOnboardingAction("location.send_check_in",{},undefined,undefined,continuation,original.privateContinuation))
      .toMatchObject({status:"blocked",waitForUser:true});
  });

  it("keeps Trusted out of private Check-In while preserving direct contacts and deliberate Circles", () => {
    const onCheckIn = vi.fn<LocationHubViewModel["onCheckIn"]>();
    const vm = viewModel(onCheckIn);
    const circles: OneLocationCircleSummary[] = [
      {
        id: "trusted-circle",
        name: "Trusted",
        kind: "other",
        role: "owner",
        memberCount: 5000,
        memberLimit: null,
        systemKind: "trusted",
      },
      {
        id: "family-circle",
        name: "Family",
        kind: "family",
        role: "owner",
        memberCount: 3,
        memberLimit: 100,
        systemKind: null,
      },
      {
        id: "sms-circle",
        name: "SMS Circle",
        kind: "other",
        role: "owner",
        memberCount: 4,
        memberLimit: 100,
        isSystem: true,
        systemKind: "sms",
      },
    ];
    vm.circles = circles;

    render(<CheckInFlow vm={vm} entrySource="nearby" onClose={vi.fn()} />);

    expect(screen.queryByText("Trusted")).not.toBeInTheDocument();
    expect(screen.getByText("Family")).toBeInTheDocument();
    expect(screen.getByText("SMS Circle")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^(?!View ).*Aarav Mehta/ })).toBeEnabled();
  });

  it("hides someone else's SMS Circle from private Check-In", () => {
    const onCheckIn = vi.fn<LocationHubViewModel["onCheckIn"]>();
    const vm = viewModel(onCheckIn);
    vm.circles = [
      {
        id: "own-sms-circle",
        name: "My SMS Circle",
        kind: "other",
        role: "owner",
        memberCount: 2,
        memberLimit: 100,
        isSystem: true,
        systemKind: "sms",
      },
      {
        id: "foreign-sms-circle",
        name: "Riya's SMS Circle",
        kind: "other",
        role: "member",
        memberCount: 3,
        memberLimit: 100,
        isSystem: true,
        systemKind: "sms",
      },
    ];

    render(<CheckInFlow vm={vm} entrySource="nearby" onClose={vi.fn()} />);

    expect(screen.getByText("My SMS Circle")).toBeInTheDocument();
    expect(screen.queryByText("Riya's SMS Circle")).not.toBeInTheDocument();
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
    fireEvent.click(screen.getByRole("button", { name: /^(?!View ).*Aarav Mehta/ }));
    fireEvent.click(
      screen.getByRole("button", {
        name: "Share location with 1 person",
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
    ).toHaveTextContent(/Nearby sees your name only/i);
    expect(
      screen.getByRole("button", { name: "Choose who to tell" }),
    ).toBeDisabled();

    fireEvent.click(screen.getByRole("button", { name: /^(?!View ).*Aarav Mehta/ }));
    fireEvent.click(screen.getByRole("button", { name: /^(?!View ).*Maya Chen/ }));
    fireEvent.click(
      screen.getByRole("button", {
        name: "Share location with 2 people",
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
      name: "Share location with 1 person",
    });
    expect(screen.getByRole("button", { name: /^(?!View ).*Aarav Mehta/ })).toBeDisabled();
    expect(screen.getByRole("button", { name: "30 min" })).toBeDisabled();
    expect(
      screen.getByPlaceholderText("I've checked in here, let's catch up"),
    ).toBeDisabled();
    expect(
      screen.getByText(/Sends again to the people it missed/i),
    ).toBeInTheDocument();
    expect(
      screen.getByTestId("private-check-in-partial-success"),
    ).toHaveTextContent(
      /Edits apply only to people still waiting/i,
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

    fireEvent.click(screen.getByRole("button", { name: /^(?!View ).*Aarav Mehta/ }));
    fireEvent.click(screen.getByRole("button", { name: /^(?!View ).*Maya Chen/ }));
    await act(async () => {
      fireEvent.click(
        screen.getByRole("button", {
          name: "Share location with 2 people",
        }),
      );
      await Promise.resolve();
    });

    expect(
      screen.getByRole("button", {
        name: "Edit and confirm again",
      }),
    ).toBeInTheDocument();

    act(() => {
      vi.advanceTimersByTime(10 * 60_000 + 5_000);
    });

    expect(
      screen.getByRole("button", { name: "Confirm your location again" }),
    ).toBeDisabled();
    expect(
      screen.getByText(/That expired\. Edit and confirm again/i),
    ).toBeInTheDocument();
    expect(onDiscardPrivateCheckInOperation).toHaveBeenCalledWith(
      expect.any(String),
    );

    fireEvent.click(
      screen.getByRole("button", {
        name: "Edit and confirm again",
      }),
    );

    expect(screen.getByRole("button", { name: /^(?!View ).*Aarav Mehta/ })).toBeDisabled();
    expect(screen.getByRole("button", { name: /^(?!View ).*Maya Chen/ })).toBeEnabled();
    expect(screen.getByRole("button", { name: "30 min" })).toBeEnabled();
    expect(
      screen.getByPlaceholderText("I've checked in here, let's catch up"),
    ).toBeEnabled();
    expect(
      screen.getByTestId("private-check-in-partial-success"),
    ).toHaveTextContent(/Edits apply only to people still waiting/i);
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

    fireEvent.click(screen.getByRole("button", { name: /^(?!View ).*Aarav Mehta/ }));
    fireEvent.click(
      screen.getByRole("button", {
        name: "Share location with 1 person",
      }),
    );
    await waitFor(() => expect(onCheckIn).toHaveBeenCalledTimes(1));
    await screen.findByRole("button", {
      name: "Edit and confirm again",
    });
    const operationId = onCheckIn.mock.calls[0]![0].clientOperationId;

    vm.sosRecipients = vm.sosRecipients.map((value) =>
      value.userId === "user-aarav"
        ? { ...value, keyId: "user-aarav-rotated-key" }
        : value,
    );
    rerender(<CheckInFlow vm={vm} entrySource="nearby" onClose={vi.fn()} />);

    expect(
      screen.getByRole("button", { name: "Their security key changed - confirm again" }),
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
