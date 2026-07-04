import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";

import {
  LOCATION_CHAT_ERROR_TEXT,
  useLocationChat,
} from "@/components/one-location/redesign/use-location-chat";
import { OneLocationService } from "@/lib/one-location/service";
import * as encryption from "@/lib/one-location/encryption";

vi.mock("@/lib/one-location/service", () => ({
  OneLocationService: {
    chat: vi.fn(),
    captureCurrentPosition: vi.fn(),
    getState: vi.fn(),
    storeEnvelope: vi.fn(),
    viewEnvelope: vi.fn(),
    createPublicInvite: vi.fn(),
    revokeGrant: vi.fn(),
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
vi.mock("@/lib/one-location/encryption", () => ({
  encryptLocationForRecipient: vi.fn(),
  decryptLocationEnvelope: vi.fn(),
}));

const mockChat = vi.mocked(OneLocationService.chat);

describe("useLocationChat", () => {
  beforeEach(() => {
    mockChat.mockReset();
    vi.mocked(OneLocationService.captureCurrentPosition).mockReset();
    vi.mocked(OneLocationService.getState).mockReset();
    vi.mocked(OneLocationService.storeEnvelope).mockReset();
    vi.mocked(OneLocationService.viewEnvelope).mockReset();
    vi.mocked(OneLocationService.createPublicInvite).mockReset();
    vi.mocked(OneLocationService.revokeGrant).mockReset();
    vi.mocked(encryption.encryptLocationForRecipient).mockReset();
    vi.mocked(encryption.decryptLocationEnvelope).mockReset();
  });

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

describe("useLocationChat — action dispatcher", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("publish_share: confirm captures, encrypts per recipient, uploads, reports completed", async () => {
    const mockPoint = {
      latitude: 1,
      longitude: 2,
      capturedAt: "now",
      sourcePlatform: "web" as const,
    };
    const mockEnvelope = {
      algorithm: "ECDH-P256-AES256-GCM" as const,
      recipientKeyId: "k1",
      ciphertext: "x",
      iv: "iv",
      senderEphemeralPublicKeyJwk: {} as JsonWebKey,
      capturedAt: "now",
      sourcePlatform: "web" as const,
    };

    mockChat
      .mockResolvedValueOnce({
        conversationId: "c1",
        response: "Ready to share with Mom.",
        isComplete: true,
        stateChanged: false,
        clientAction: {
          id: "act-1",
          type: "publish_share" as const,
          shares: [
            {
              grantId: "g1",
              recipientUserId: "r1",
              recipientKeyId: "k1",
              label: "Mom",
            },
          ],
          summary: "Share your live location with Mom",
        },
      })
      .mockResolvedValueOnce({
        conversationId: "c1",
        response: "Done — shared.",
        isComplete: true,
        stateChanged: true,
      });

    vi.mocked(OneLocationService.captureCurrentPosition).mockResolvedValue(mockPoint);
    vi.mocked(OneLocationService.getState).mockResolvedValue({
      recipients: [{ userId: "r1", displayName: "Mom", phoneVerified: true, keyId: "k1", publicKeyJwk: { kid: "k1" } as JsonWebKey, keyAlgorithm: "ECDH-P256", canReceiveLocation: true }],
      ownerGrants: [],
      receivedGrants: [],
      requests: [],
      referrals: [],
      publicInvites: [],
      publicInviteSubmissions: [],
      capabilityScopes: [],
    });
    vi.mocked(encryption.encryptLocationForRecipient).mockResolvedValue(mockEnvelope);
    vi.mocked(OneLocationService.storeEnvelope).mockResolvedValue(mockEnvelope);

    const onStateChanged = vi.fn();
    const { result } = renderHook(() =>
      useLocationChat({ vaultOwnerToken: "tok", userId: "u1", onStateChanged }),
    );

    await act(async () => {
      await result.current.send("share with Mom");
    });
    expect(result.current.pendingAction?.type).toBe("publish_share");

    await act(async () => {
      await result.current.confirmAction();
    });

    expect(vi.mocked(OneLocationService.captureCurrentPosition)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(encryption.encryptLocationForRecipient)).toHaveBeenCalledWith(
      expect.objectContaining({ recipientKeyId: "k1", recipientPublicKeyJwk: { kid: "k1" } }),
    );
    expect(vi.mocked(OneLocationService.storeEnvelope)).toHaveBeenCalledWith(
      expect.objectContaining({ grantId: "g1" }),
    );
    expect(mockChat).toHaveBeenLastCalledWith(
      expect.objectContaining({
        actionResult: expect.objectContaining({ type: "publish_share", status: "completed" }),
      }),
    );
    expect(mockChat).toHaveBeenLastCalledWith(
      expect.objectContaining({
        actionResult: expect.not.objectContaining({ latitude: expect.anything() }),
      }),
    );
    await waitFor(() => expect(onStateChanged).toHaveBeenCalled());
    expect(result.current.pendingAction).toBeNull();
  });

  it("publish_share: cancel revokes the grant and reports cancelled", async () => {
    mockChat
      .mockResolvedValueOnce({
        conversationId: "c1",
        response: "Ready.",
        isComplete: true,
        stateChanged: false,
        clientAction: {
          id: "act-1",
          type: "publish_share" as const,
          shares: [
            {
              grantId: "g1",
              recipientUserId: "r1",
              recipientKeyId: "k1",
              label: "Mom",
            },
          ],
          summary: "Share with Mom",
        },
      })
      .mockResolvedValueOnce({
        conversationId: "c1",
        response: "No problem.",
        isComplete: true,
        stateChanged: false,
      });

    vi.mocked(OneLocationService.revokeGrant).mockResolvedValue({
      id: "g1",
      ownerUserId: "u1",
      recipientUserId: "r1",
      recipientKeyId: "k1",
      status: "revoked",
      consentScope: "",
      capabilityScopes: [],
      durationHours: 1,
    });

    const { result } = renderHook(() =>
      useLocationChat({ vaultOwnerToken: "tok", userId: "u1" }),
    );
    await act(async () => {
      await result.current.send("share with Mom");
    });
    await act(async () => {
      await result.current.cancelAction();
    });

    expect(vi.mocked(OneLocationService.revokeGrant)).toHaveBeenCalledWith(
      expect.objectContaining({ grantId: "g1" }),
    );
    expect(mockChat).toHaveBeenLastCalledWith(
      expect.objectContaining({
        actionResult: expect.objectContaining({ status: "cancelled" }),
      }),
    );
    expect(result.current.pendingAction).toBeNull();
  });

  it("view_envelope: confirm decrypts envelope and sets viewedPoint", async () => {
    const mockEnvelope = {
      algorithm: "ECDH-P256-AES256-GCM" as const,
      recipientKeyId: "k1",
      ciphertext: "c",
      iv: "iv",
      senderEphemeralPublicKeyJwk: {} as JsonWebKey,
      capturedAt: "now",
      sourcePlatform: "web" as const,
    };
    const mockPoint = {
      latitude: 37.5,
      longitude: -122.1,
      capturedAt: "now",
      sourcePlatform: "web" as const,
    };

    mockChat
      .mockResolvedValueOnce({
        conversationId: "c2",
        response: "I'll show you their location.",
        isComplete: true,
        stateChanged: false,
        clientAction: {
          id: "act-2",
          type: "view_envelope" as const,
          grantId: "g2",
          summary: "View shared location",
        },
      })
      .mockResolvedValueOnce({
        conversationId: "c2",
        response: "Shown.",
        isComplete: true,
        stateChanged: false,
      });

    vi.mocked(OneLocationService.viewEnvelope).mockResolvedValue({
      grant: {
        id: "g2",
        ownerUserId: "r1",
        recipientUserId: "u1",
        recipientKeyId: "k1",
        status: "active",
        consentScope: "",
        capabilityScopes: [],
        durationHours: 1,
      },
      envelope: mockEnvelope,
    });
    vi.mocked(encryption.decryptLocationEnvelope).mockResolvedValue(mockPoint);

    const { result } = renderHook(() =>
      useLocationChat({ vaultOwnerToken: "tok", userId: "u1" }),
    );

    await act(async () => {
      await result.current.send("show me their location");
    });
    expect(result.current.pendingAction?.type).toBe("view_envelope");

    await act(async () => {
      await result.current.confirmAction();
    });

    expect(vi.mocked(OneLocationService.viewEnvelope)).toHaveBeenCalledWith(
      expect.objectContaining({ grantId: "g2" }),
    );
    expect(vi.mocked(encryption.decryptLocationEnvelope)).toHaveBeenCalledWith(
      expect.objectContaining({ userId: "u1", envelope: mockEnvelope }),
    );
    expect(result.current.viewedPoint).toEqual(mockPoint);
    expect(result.current.pendingAction).toBeNull();
    expect(mockChat).toHaveBeenLastCalledWith(
      expect.objectContaining({
        actionResult: expect.objectContaining({ type: "view_envelope", status: "completed" }),
      }),
    );
  });

  it("view_envelope: reports failed with 'userId not configured' when hook has no userId", async () => {
    mockChat
      .mockResolvedValueOnce({
        conversationId: "c-noid",
        response: "I'll show you their location.",
        isComplete: true,
        stateChanged: false,
        clientAction: {
          id: "act-noid",
          type: "view_envelope" as const,
          grantId: "g-noid",
          summary: "View shared location",
        },
      })
      .mockResolvedValueOnce({
        conversationId: "c-noid",
        response: "Sorry — couldn't fetch.",
        isComplete: true,
        stateChanged: false,
      });

    const { result } = renderHook(() =>
      useLocationChat({ vaultOwnerToken: "tok" }), // no userId
    );

    await act(async () => {
      await result.current.send("show me their location");
    });
    expect(result.current.pendingAction?.type).toBe("view_envelope");

    await act(async () => {
      await result.current.confirmAction();
    });

    expect(vi.mocked(OneLocationService.viewEnvelope)).not.toHaveBeenCalled();
    expect(mockChat).toHaveBeenLastCalledWith(
      expect.objectContaining({
        actionResult: expect.objectContaining({
          type: "view_envelope",
          status: "failed",
          detail: "userId not configured",
        }),
      }),
    );
    expect(result.current.pendingAction).toBeNull();
  });

  it("create_public_link: confirm captures, creates invite, reports completed with publicUrl", async () => {
    const mockPoint = {
      latitude: 10,
      longitude: 20,
      capturedAt: "now",
      sourcePlatform: "web" as const,
    };

    mockChat
      .mockResolvedValueOnce({
        conversationId: "c3",
        response: "Creating a public link.",
        isComplete: true,
        stateChanged: false,
        clientAction: {
          id: "act-3",
          type: "create_public_link" as const,
          durationHours: 2,
          summary: "Create a public location link",
        },
      })
      .mockResolvedValueOnce({
        conversationId: "c3",
        response: "Link created!",
        isComplete: true,
        stateChanged: false,
      });

    vi.mocked(OneLocationService.captureCurrentPosition).mockResolvedValue(mockPoint);
    vi.mocked(OneLocationService.createPublicInvite).mockResolvedValue({
      invite: {
        id: "inv-1",
        ownerUserId: "u1",
        status: "active",
        durationHours: 2,
      },
      publicToken: "tok123",
      publicUrl: "https://hushh.ai/location/tok123",
    });

    const { result } = renderHook(() =>
      useLocationChat({ vaultOwnerToken: "tok", userId: "u1" }),
    );

    await act(async () => {
      await result.current.send("create a public link");
    });
    expect(result.current.pendingAction?.type).toBe("create_public_link");

    await act(async () => {
      await result.current.confirmAction();
    });

    expect(vi.mocked(OneLocationService.captureCurrentPosition)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(OneLocationService.createPublicInvite)).toHaveBeenCalledWith(
      expect.objectContaining({ durationHours: 2, locationSnapshot: mockPoint }),
    );
    expect(mockChat).toHaveBeenLastCalledWith(
      expect.objectContaining({
        actionResult: expect.objectContaining({
          type: "create_public_link",
          status: "completed",
          publicUrl: "https://hushh.ai/location/tok123",
        }),
      }),
    );
    expect(result.current.pendingAction).toBeNull();
  });

  it("confirmAction: reports failed when crypto throws", async () => {
    mockChat
      .mockResolvedValueOnce({
        conversationId: "c4",
        response: "Ready.",
        isComplete: true,
        stateChanged: false,
        clientAction: {
          id: "act-4",
          type: "publish_share" as const,
          shares: [
            {
              grantId: "g4",
              recipientUserId: "r4",
              recipientKeyId: "k4",
              label: "Alice",
            },
          ],
          summary: "Share with Alice",
        },
      })
      .mockResolvedValueOnce({
        conversationId: "c4",
        response: "Sorry, something went wrong.",
        isComplete: true,
        stateChanged: false,
      });

    vi.mocked(OneLocationService.captureCurrentPosition).mockResolvedValue({
      latitude: 1,
      longitude: 2,
      capturedAt: "now",
      sourcePlatform: "web" as const,
    });
    vi.mocked(OneLocationService.getState).mockResolvedValue({
      recipients: [],
      ownerGrants: [],
      receivedGrants: [],
      requests: [],
      referrals: [],
      publicInvites: [],
      publicInviteSubmissions: [],
      capabilityScopes: [],
    });

    const { result } = renderHook(() =>
      useLocationChat({ vaultOwnerToken: "tok", userId: "u1" }),
    );

    await act(async () => {
      await result.current.send("share with Alice");
    });

    await act(async () => {
      await result.current.confirmAction();
    });

    expect(mockChat).toHaveBeenLastCalledWith(
      expect.objectContaining({
        actionResult: expect.objectContaining({ status: "failed" }),
      }),
    );
    expect(result.current.pendingAction).toBeNull();
  });

  it("clear() resets pendingAction and viewedPoint", async () => {
    mockChat.mockResolvedValueOnce({
      conversationId: "c5",
      response: "Ready.",
      isComplete: true,
      stateChanged: false,
      clientAction: {
        id: "act-5",
        type: "publish_share" as const,
        shares: [],
        summary: "Share",
      },
    });

    const { result } = renderHook(() =>
      useLocationChat({ vaultOwnerToken: "tok", userId: "u1" }),
    );

    await act(async () => {
      await result.current.send("share");
    });
    expect(result.current.pendingAction).not.toBeNull();

    act(() => result.current.clear());
    expect(result.current.pendingAction).toBeNull();
    expect(result.current.viewedPoint).toBeNull();
  });
});

describe("useLocationChat — pending prompt", () => {
  const svc = vi.mocked(OneLocationService);

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("sets pendingPrompt from a clientPrompt response", async () => {
    svc.chat.mockResolvedValueOnce({
      conversationId: "c1",
      response: "Which sharing do you want to stop?",
      isComplete: true,
      stateChanged: false,
      clientPrompt: {
        id: "prm-1",
        kind: "select",
        purpose: "select_share",
        question: "Which sharing do you want to stop?",
        options: [{ label: "Mom", ref: { grantId: "g1" } }, { label: "Stop all", ref: { all: true } }],
      },
    });
    const { result } = renderHook(() => useLocationChat({ vaultOwnerToken: "tok", userId: "u1" }));
    await act(async () => { await result.current.send("stop sharing"); });
    expect(result.current.pendingPrompt?.purpose).toBe("select_share");
  });

  it("answerPrompt sends selected refs and clears the prompt", async () => {
    svc.chat
      .mockResolvedValueOnce({
        conversationId: "c1", response: "?", isComplete: true, stateChanged: false,
        clientPrompt: { id: "prm-1", kind: "select", purpose: "select_share", question: "?", options: [{ label: "Mom", ref: { grantId: "g1" } }] },
      })
      .mockResolvedValueOnce({ conversationId: "c1", response: "Stopped.", isComplete: true, stateChanged: true });
    const onStateChanged = vi.fn();
    const { result } = renderHook(() => useLocationChat({ vaultOwnerToken: "tok", userId: "u1", onStateChanged }));
    await act(async () => { await result.current.send("stop sharing"); });
    await act(async () => { await result.current.answerPrompt([{ grantId: "g1" }]); });
    expect(svc.chat).toHaveBeenLastCalledWith(
      expect.objectContaining({
        selectionResult: expect.objectContaining({ id: "prm-1", kind: "select", selected: [{ grantId: "g1" }], status: "answered" }),
      }),
    );
    expect(result.current.pendingPrompt).toBeNull();
    expect(onStateChanged).toHaveBeenCalled();
  });

  it("free text while a prompt is pending sends a freeText selection", async () => {
    svc.chat
      .mockResolvedValueOnce({
        conversationId: "c1", response: "?", isComplete: true, stateChanged: false,
        clientPrompt: { id: "prm-1", kind: "select", purpose: "select_recipient", question: "?", options: [] },
      })
      .mockResolvedValueOnce({ conversationId: "c1", response: "ok", isComplete: true, stateChanged: false });
    const { result } = renderHook(() => useLocationChat({ vaultOwnerToken: "tok", userId: "u1" }));
    await act(async () => { await result.current.send("share"); });
    await act(async () => { await result.current.send("my coworker Alex"); });
    expect(svc.chat).toHaveBeenLastCalledWith(
      expect.objectContaining({ selectionResult: expect.objectContaining({ freeText: "my coworker Alex", status: "answered" }) }),
    );
  });

  it("confirmPrompt(true) sends confirmed selectionResult and clears pendingPrompt", async () => {
    svc.chat
      .mockResolvedValueOnce({
        conversationId: "c1", response: "Stop all?", isComplete: true, stateChanged: false,
        clientPrompt: { id: "prm-c", kind: "confirm", purpose: "confirm_action", question: "Stop all?" },
      })
      .mockResolvedValueOnce({ conversationId: "c1", response: "Done.", isComplete: true, stateChanged: false });
    const { result } = renderHook(() => useLocationChat({ vaultOwnerToken: "tok", userId: "u1" }));
    await act(async () => { await result.current.send("stop all sharing"); });
    expect(result.current.pendingPrompt?.id).toBe("prm-c");
    await act(async () => { await result.current.confirmPrompt(true); });
    expect(svc.chat).toHaveBeenLastCalledWith(
      expect.objectContaining({
        selectionResult: expect.objectContaining({ id: "prm-c", kind: "confirm", confirmed: true, status: "answered" }),
      }),
    );
    expect(result.current.pendingPrompt).toBeNull();
  });

  it("cancelPrompt() sends cancelled selectionResult and clears pendingPrompt", async () => {
    svc.chat
      .mockResolvedValueOnce({
        conversationId: "c1", response: "Stop all?", isComplete: true, stateChanged: false,
        clientPrompt: { id: "prm-c", kind: "confirm", purpose: "confirm_action", question: "Stop all?" },
      })
      .mockResolvedValueOnce({ conversationId: "c1", response: "Cancelled.", isComplete: true, stateChanged: false });
    const { result } = renderHook(() => useLocationChat({ vaultOwnerToken: "tok", userId: "u1" }));
    await act(async () => { await result.current.send("stop all sharing"); });
    expect(result.current.pendingPrompt?.id).toBe("prm-c");
    await act(async () => { await result.current.cancelPrompt(); });
    expect(svc.chat).toHaveBeenLastCalledWith(
      expect.objectContaining({
        selectionResult: expect.objectContaining({ id: "prm-c", kind: "confirm", status: "cancelled" }),
      }),
    );
    expect(result.current.pendingPrompt).toBeNull();
  });
});
