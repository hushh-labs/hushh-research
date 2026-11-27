import { publishValidatedAuthSessionPrincipal } from "@/lib/auth/session-owner";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  apiFetch: vi.fn(),
  ownerPodRequest: vi.fn(),
  getPersonalAgentStatus: vi.fn(),
  trackEvent: vi.fn(),
  currentUserId: "owner" as string | null,
}));

vi.mock("@/lib/services/api-service", () => ({
  ApiService: {
    apiFetch: mocks.apiFetch,
    ownerPodRequest: mocks.ownerPodRequest,
    getPersonalAgentStatusForRouting: mocks.getPersonalAgentStatus,
  },
}));
vi.mock("@/lib/observability/client", () => ({
  trackEvent: mocks.trackEvent,
}));
vi.mock("@/lib/services/auth-service", () => ({
  AuthService: {
    getCurrentUser: () =>
      mocks.currentUserId ? { uid: mocks.currentUserId } : null,
  },
}));

import { GmailReceiptsService } from "@/lib/services/gmail-receipts-service";

function response(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("native Gmail observability", () => {
  beforeEach(() => {
  publishValidatedAuthSessionPrincipal({ firebaseUid: "owner", ownerId: "owner", accountGeneration: 0 });
    vi.resetAllMocks();
    mocks.currentUserId = "owner";
    // Provider-observability cases run only after explicit Shared admission.
    mocks.getPersonalAgentStatus.mockResolvedValue({ hostingMode: "shared" });
  });

  const privateScan = () => GmailReceiptsService.scanReceipts({
    idToken: "synthetic-token", vaultOwnerToken: "synthetic-vault-token", userId: "owner",
    privateMailbox: { accountId: "synthetic-account", credentialId: "synthetic-credential" }, perPage: 6,
  });
  const emptyScan = () => ({
    items: [], page: 1, per_page: 6, returned_count: 0, has_more: false,
    coverage: { source: "gmail_live", listed_count: 0, candidate_count: 0, matched_count: 0,
      pages_scanned: 1, max_messages: 6, max_pages: 10, reached_limit: false,
      query_scope: "receipt_signals_all_mail_except_spam_trash",
      rejection_counts: { missing_receipt_signal: 0, extractor_not_receipt: 0 },
      evidence_counts: { gmail_category: 0, subject_signal: 0, body_signal: 0,
        verified_merchant: 0, order_candidate: 0, total_candidate: 0 } },
  });

  it.each(["success", "provider error", "invalid response", "transport error"] as const)(
    "records private receipt scan %s once at its admitted read boundary", async (outcome) => {
      if (outcome === "transport error") mocks.ownerPodRequest.mockRejectedValueOnce(new Error("Synthetic private failure"));
      else mocks.ownerPodRequest.mockResolvedValueOnce(response(
        outcome === "success" ? emptyScan() : outcome === "provider error" ? { detail: "Synthetic private failure" } : {},
        outcome === "provider error" ? 503 : 200,
      ));
      if (outcome === "success") await expect(privateScan()).resolves.toMatchObject({ items: [], returned_count: 0 });
      else await expect(privateScan()).rejects.toThrow();
      expect(mocks.ownerPodRequest).toHaveBeenCalledTimes(1);
      expect(mocks.apiFetch).not.toHaveBeenCalled();
      expect(mocks.trackEvent.mock.calls).toEqual([
        ["gmail_receipts_loaded", { result: outcome === "success" ? "success" : "error" }],
      ]);
    },
  );

  it("withholds a private receipt scan result after its admitted owner changes", async () => {
    let finish!: (value: Response) => void;
    mocks.ownerPodRequest.mockReturnValueOnce(new Promise<Response>((resolve) => { finish = resolve; }));
    const scanning = privateScan();
    await vi.waitFor(() => expect(mocks.ownerPodRequest).toHaveBeenCalledTimes(1));
    mocks.currentUserId = "other-owner";
    publishValidatedAuthSessionPrincipal({ firebaseUid: "other-owner", ownerId: "other-owner", accountGeneration: 0 });
    finish(response(emptyScan()));
    await expect(scanning).rejects.toThrow("Mail session changed");
    expect(mocks.trackEvent).not.toHaveBeenCalled();
  });

  it("does not accept a read-only native result for a send upgrade", async () => {
    mocks.apiFetch.mockResolvedValueOnce(
      response({
        configured: true,
        connected: true,
        status: "connected",
        send_permission_granted: false,
      }),
    );

    await expect(
      GmailReceiptsService.completeNativeConnect({
        idToken: "token",
        userId: "owner",
        serverAuthCode: "one-time-code",
        purpose: "send",
      }),
    ).rejects.toThrow("sending permission");
    expect(mocks.trackEvent).toHaveBeenCalledWith("gmail_connect_result", {
      action: "complete",
      result: "error",
    });
    expect(mocks.trackEvent).not.toHaveBeenCalledWith(
      "gmail_connect_result",
      { action: "complete", result: "success" },
    );
  });

  it("suppresses a service result after the authenticated owner changes", async () => {
    let resolveResponse!: (value: Response) => void;
    mocks.apiFetch.mockReturnValueOnce(
      new Promise<Response>((resolve) => {
        resolveResponse = resolve;
      }),
    );

    const completion = GmailReceiptsService.startConnect({
      idToken: "token",
      userId: "owner",
      includeGrantedScopes: false,
    });
    await vi.waitFor(() => expect(mocks.apiFetch).toHaveBeenCalledTimes(1));
    // An owner change replaces both the Firebase identity and the validated owner.
    mocks.currentUserId = "other-owner";
    publishValidatedAuthSessionPrincipal({ firebaseUid: "other-owner", ownerId: "other-owner", accountGeneration: 0 });
    resolveResponse(
      response({
        configured: true,
        authorize_url: "https://accounts.google.com/o/oauth2/v2/auth",
        state: "state",
        redirect_uri: "https://one.hushh.ai/profile/gmail/oauth/return",
        expires_at: "2026-09-25T10:00:00Z",
      }),
    );
    await completion;

    expect(mocks.trackEvent).toHaveBeenCalledWith("gmail_connect_started", {
      action: "full",
      result: "success",
    });
    expect(mocks.trackEvent).not.toHaveBeenCalledWith(
      "gmail_connect_result",
      expect.anything(),
    );
  });

  it("suppresses start telemetry from a stale initiating owner", async () => {
    mocks.currentUserId = "other-owner";
    mocks.apiFetch.mockResolvedValueOnce(
      response({
        configured: true,
        authorize_url: "https://accounts.google.com/o/oauth2/v2/auth",
        state: "state",
        redirect_uri: "https://one.hushh.ai/profile/gmail/oauth/return",
        expires_at: "2026-09-25T10:00:00Z",
      }),
    );

    await expect(GmailReceiptsService.startConnect({
      idToken: "token",
      userId: "owner",
      includeGrantedScopes: false,
    })).rejects.toThrow("PRIVATE_AGENT_SIGN_IN_REQUIRED");

    expect(mocks.trackEvent).not.toHaveBeenCalledWith(
      "gmail_connect_started",
      expect.anything(),
    );
  });

  it("emits the same start and completion stages as web OAuth", async () => {
    mocks.apiFetch
      .mockResolvedValueOnce(response({ configured: true, server_client_id: "public-client", purpose: "read" }))
      .mockResolvedValueOnce(response({ configured: true, connected: true, status: "connected" }));

    await GmailReceiptsService.startNativeConnect({ idToken: "token", userId: "owner", purpose: "read" });
    await GmailReceiptsService.completeNativeConnect({
      idToken: "token",
      userId: "owner",
      serverAuthCode: "one-time-code",
    });

    expect(mocks.trackEvent.mock.calls).toEqual([
      ["gmail_connect_started", { action: "full", result: "success" }],
      ["gmail_connect_result", { action: "start", result: "success" }],
      ["gmail_connect_result", { action: "complete", result: "success" }],
    ]);
  });

  it("records a bounded error outcome without provider payloads", async () => {
    mocks.apiFetch.mockResolvedValueOnce(response({ detail: "provider rejected request" }, 500));

    await expect(
      GmailReceiptsService.startNativeConnect({ idToken: "token", userId: "owner", purpose: "send" }),
    ).rejects.toThrow();

    expect(mocks.trackEvent.mock.calls).toEqual([
      ["gmail_connect_started", { action: "incremental", result: "success" }],
      ["gmail_connect_result", { action: "start", result: "error" }],
    ]);
    expect(JSON.stringify(mocks.trackEvent.mock.calls)).not.toContain("provider rejected request");
  });

  it("records a native OAuth completion failure exactly once", async () => {
    mocks.apiFetch.mockResolvedValueOnce(response({ detail: "authorization code rejected" }, 400));

    await expect(
      GmailReceiptsService.completeNativeConnect({
        idToken: "token",
        userId: "owner",
        serverAuthCode: "one-time-code",
      }),
    ).rejects.toThrow();

    expect(mocks.trackEvent.mock.calls).toEqual([
      ["gmail_connect_result", { action: "complete", result: "error" }],
    ]);
    expect(JSON.stringify(mocks.trackEvent.mock.calls)).not.toContain("authorization code rejected");
  });

  it.each([
    ["native", () => GmailReceiptsService.completeNativeConnect({
      idToken: "token",
      userId: "owner",
      serverAuthCode: "one-time-code",
    })],
    ["web", () => GmailReceiptsService.completeConnect({
      idToken: "token",
      userId: "owner",
      code: "code",
      state: "state",
    })],
  ] as const)("does not report %s completion success for an inactive status", async (_surface, invoke) => {
    mocks.apiFetch.mockResolvedValueOnce(
      response({ configured: true, connected: false, status: "disconnected" }),
    );

    await expect(invoke()).rejects.toThrow("invalid response");
    expect(mocks.trackEvent).toHaveBeenCalledWith("gmail_connect_result", {
      action: "complete",
      result: "error",
    });
    expect(mocks.trackEvent).not.toHaveBeenCalledWith(
      "gmail_connect_result",
      { action: "complete", result: "success" },
    );
  });

  it.each([
    [{ code: "USER_CANCELLED" }, "expected_error"],
    [new Error("native SDK failed"), "error"],
  ] as const)("records native consent failures as a terminal outcome", (error, result) => {
    GmailReceiptsService.recordConsentFailure(error);

    expect(mocks.trackEvent.mock.calls).toEqual([
      ["gmail_connect_result", { action: "complete", result }],
    ]);
  });

  it.each([
    ["start", () => GmailReceiptsService.startNativeConnect({ idToken: "token", userId: "owner", purpose: "read" })],
    ["complete", () => GmailReceiptsService.completeNativeConnect({
      idToken: "token",
      userId: "owner",
      serverAuthCode: "one-time-code",
    })],
  ] as const)("does not report %s success for an invalid 2xx payload", async (action, invoke) => {
    mocks.apiFetch.mockResolvedValueOnce(response({}));

    await expect(invoke()).rejects.toThrow("invalid response");

    expect(mocks.trackEvent.mock.calls).toContainEqual([
      "gmail_connect_result",
      { action, result: "error" },
    ]);
    expect(mocks.trackEvent.mock.calls).not.toContainEqual([
      "gmail_connect_result",
      { action, result: "success" },
    ]);
  });

  it.each([
    ["start", () => GmailReceiptsService.startConnect({
      idToken: "token",
      userId: "owner",
      includeGrantedScopes: false,
    })],
    ["complete", () => GmailReceiptsService.completeConnect({
      idToken: "token",
      userId: "owner",
      code: "code",
      state: "state",
    })],
  ] as const)("does not report web %s success for an invalid 2xx payload", async (action, invoke) => {
    mocks.apiFetch.mockResolvedValueOnce(response({}));

    await expect(invoke()).rejects.toThrow("invalid response");
    expect(mocks.trackEvent.mock.calls).toContainEqual([
      "gmail_connect_result",
      { action, result: "error" },
    ]);
    expect(mocks.trackEvent.mock.calls).not.toContainEqual([
      "gmail_connect_result",
      { action, result: "success" },
    ]);
  });

  it("rejects a blank native client id before reporting start success", async () => {
    mocks.apiFetch.mockResolvedValueOnce(
      response({ configured: true, server_client_id: "   ", purpose: "read" }),
    );
    await expect(
      GmailReceiptsService.startNativeConnect({ idToken: "token", userId: "owner", purpose: "read" }),
    ).rejects.toThrow("invalid response");
    expect(mocks.trackEvent.mock.calls).toContainEqual([
      "gmail_connect_result", { action: "start", result: "error" },
    ]);
    expect(mocks.trackEvent.mock.calls).not.toContainEqual([
      "gmail_connect_result", { action: "start", result: "success" },
    ]);
  });
});

afterEach(() => publishValidatedAuthSessionPrincipal(null));
