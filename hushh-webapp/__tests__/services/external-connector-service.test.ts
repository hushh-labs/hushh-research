import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const placement = vi.hoisted(() => vi.fn(async () => false));
vi.mock('@/lib/services/private-agent-specialist-chat', () => ({ ownerContentIsPrivate: placement }));


const apiFetch = vi.hoisted(() => vi.fn());

vi.mock("@/lib/services/api-service", () => ({
  ApiService: {
    apiFetch,
    getAuthHeaders: (token: string) => ({ Authorization: `Bearer ${token}` }),
  },
}));

import {
  CONNECTOR_OAUTH_START_TIMEOUT_MS,
  ExternalConnectorService,
} from "@/lib/services/external-connector-service";

describe("ExternalConnectorService native Drive OAuth", () => {
  beforeEach(() => { placement.mockResolvedValue(false); apiFetch.mockReset(); });
  afterEach(() => vi.useRealTimers());

  it('blocks legacy Drive credentials and picker grants after private placement before any hub request', async () => {
    placement.mockResolvedValue(true);
    await expect(ExternalConnectorService.completeOAuthConnect({ vaultOwnerToken: 'owner-token', state: 'state', code: 'never-hub' })).rejects.toMatchObject({ code: 'PRIVATE_GOOGLE_OPERATION_UNAVAILABLE' });
    await expect(ExternalConnectorService.completeWebOAuth({ idToken: 'token', state: 'state', code: 'never-hub', attemptId: 'attempt' })).rejects.toMatchObject({ code: 'PRIVATE_GOOGLE_OPERATION_UNAVAILABLE' });
    await expect(ExternalConnectorService.pickerSession('owner-token', 'https://app.test')).rejects.toMatchObject({ code: 'PRIVATE_GOOGLE_OPERATION_UNAVAILABLE' });
    await expect(ExternalConnectorService.documents('owner-token')).rejects.toMatchObject({ code: 'PRIVATE_GOOGLE_OPERATION_UNAVAILABLE' });
    await expect(ExternalConnectorService.verifyLiveDrive({ vaultOwnerToken: 'owner-token', isEffectCurrent: () => true })).rejects.toMatchObject({ code: 'PRIVATE_GOOGLE_OPERATION_UNAVAILABLE' });
    expect(apiFetch).not.toHaveBeenCalled();
  });

  it("rechecks live Drive through the owner-authorized endpoint without replaying OAuth", async () => {
    apiFetch.mockResolvedValue(Response.json({ connectorId: "google_drive", status: "connected" }));
    const signal = new AbortController().signal;
    const isEffectCurrent = () => true;
    await expect(ExternalConnectorService.verifyLiveDrive({ vaultOwnerToken: "owner-token", signal,
      isEffectCurrent })).resolves.toMatchObject({ status: "connected" });
    expect(apiFetch).toHaveBeenCalledExactlyOnceWith("/api/connectors/google_drive/live/verify",
      expect.objectContaining({ method: "POST", headers: { Authorization: "Bearer owner-token" },
        signal, isEffectCurrent }));
  });

  it("discards private OAuth delivery after vault authority changes", async () => {
    let current = true;
    apiFetch.mockImplementationOnce(async () => {
      current = false;
      return Response.json({ tokens: { access_token: "synthetic-private" } });
    });
    await expect(ExternalConnectorService.privateMcpOAuth({ vaultOwnerToken: "owner-token",
      connectorId: "custom_" + "a".repeat(32), operation: "complete", payload: {},
      signal: new AbortController().signal, isEffectCurrent: () => current,
    })).rejects.toThrow("Connection was not completed");
  });

  it("does not echo a provider failure or retry an OAuth completion", async () => {
    apiFetch.mockResolvedValue(Response.json({ detail: "synthetic-private-provider-error" }, { status: 409 }));
    await expect(ExternalConnectorService.privateMcpOAuth({ vaultOwnerToken: "owner-token",
      connectorId: "custom_" + "a".repeat(32), operation: "complete", payload: {},
      signal: new AbortController().signal, isEffectCurrent: () => true,
    })).rejects.toThrow("Connection was not completed. Please connect again.");
    expect(apiFetch).toHaveBeenCalledOnce();
  });

  it("starts a native attempt with the exact flow and effect guard", async () => {
    const isEffectCurrent = vi.fn(() => true);
    apiFetch.mockResolvedValue(
      Response.json({
        authorizeUrl:
          "https://accounts.google.com/o/oauth2/v2/auth?synthetic=1",
        expiresAt: "2026-09-23T12:00:00+00:00",
        attemptId: "attempt_123456789012",
        connectorId: "google_drive",
      }),
    );

    await expect(
      ExternalConnectorService.startOAuthConnect({
        vaultOwnerToken: "owner-token",
        connectorId: "google_drive",
        redirectUri:
          "https://api.uat.hushh.ai/api/connectors/oauth/native/callback",
        flow: "native",
        isEffectCurrent,
      }),
    ).resolves.toMatchObject({ attemptId: "attempt_123456789012" });

    expect(apiFetch).toHaveBeenCalledWith(
      "/api/connectors/google_drive/connect/oauth/start",
      expect.objectContaining({
        method: "POST",
        isEffectCurrent,
        body: JSON.stringify({
          redirectUri:
            "https://api.uat.hushh.ai/api/connectors/oauth/native/callback",
          flow: "native",
          profile: "selected",
        }),
      }),
    );
  });

  it("forwards cancellation to the web OAuth-start request", async () => {
    const ownerAbort = new AbortController();
    let resolveFetch!: (response: Response) => void;
    apiFetch.mockImplementationOnce(
      () => new Promise<Response>((resolve) => { resolveFetch = resolve; }),
    );

    const pending = ExternalConnectorService.startOAuthConnect({
      vaultOwnerToken: "owner-token",
      connectorId: "google_drive",
      redirectUri: "https://app.test/one/profile/connectors/oauth/return",
      flow: "web",
      signal: ownerAbort.signal,
    });
    await vi.waitFor(() => expect(apiFetch).toHaveBeenCalledOnce());
    const requestSignal = (apiFetch.mock.calls[0][1] as { signal: AbortSignal })
      .signal;
    ownerAbort.abort(new DOMException("Aborted", "AbortError"));

    await expect(pending).rejects.toThrow("Aborted");
    expect(requestSignal).not.toBe(ownerAbort.signal);
    expect(requestSignal.aborted).toBe(true);
    resolveFetch(Response.json({}));
  });

  it("bounds a stalled OAuth-start JSON response after headers arrive", async () => {
    vi.useFakeTimers();
    apiFetch.mockResolvedValue(
      new Response(new ReadableStream({ start() {} }), {
        headers: { "Content-Type": "application/json" },
      }),
    );

    const pending = ExternalConnectorService.startOAuthConnect({
      vaultOwnerToken: "owner-token",
      connectorId: "google_drive",
      redirectUri: "https://app.test/one/profile/connectors/oauth/return",
      flow: "web",
    });
    const assertion = expect(pending).rejects.toThrow(
      "OAuth sign-in took too long. Check the connection and try again.",
    );
    await vi.advanceTimersByTimeAsync(CONNECTOR_OAUTH_START_TIMEOUT_MS);
    await assertion;
  });

  it("reconciles only the opaque pending reference before finalization", async () => {
    const isEffectCurrent = vi.fn(() => true);
    apiFetch
      .mockResolvedValueOnce(
        Response.json({
          pending: {
            attemptId: "attempt_123456789012",
            expiresAt: "2026-09-23T12:00:00+00:00",
          },
        }),
      )
      .mockResolvedValueOnce(
        Response.json({ status: "verifying", connectorId: "google_drive" }),
      );

    await expect(
      ExternalConnectorService.pendingNative({
        vaultOwnerToken: "owner-token",
        isEffectCurrent,
      }),
    ).resolves.toEqual({
      attemptId: "attempt_123456789012",
      expiresAt: "2026-09-23T12:00:00+00:00",
    });
    await expect(
      ExternalConnectorService.finalizeNative({
        vaultOwnerToken: "owner-token",
        attemptId: "attempt_123456789012",
        isEffectCurrent,
      }),
    ).resolves.toEqual({ status: "verifying", connectorId: "google_drive" });

    expect(apiFetch.mock.calls[0][0]).toBe(
      "/api/connectors/oauth/native/pending",
    );
    expect(apiFetch.mock.calls[0][1]).toMatchObject({
      method: "GET",
      cache: "no-store",
      isEffectCurrent,
    });
    expect(apiFetch.mock.calls[1][0]).toBe(
      "/api/connectors/oauth/native/finalize",
    );
    expect(apiFetch.mock.calls[1][1]).toMatchObject({
      method: "POST",
      isEffectCurrent,
      body: JSON.stringify({ attemptId: "attempt_123456789012" }),
    });
    expect(JSON.stringify(apiFetch.mock.calls)).not.toContain("accessToken");
    expect(JSON.stringify(apiFetch.mock.calls)).not.toContain("refreshToken");
  });

  it("keeps native Picker candidates server-staged until the owner confirms", async () => {
    const isEffectCurrent = vi.fn(() => true);
    apiFetch
      .mockResolvedValueOnce(
        Response.json({
          authorizeUrl:
            "https://accounts.google.com/o/oauth2/v2/auth?synthetic=picker",
          expiresAt: "2026-09-23T12:00:00+00:00",
          attemptId: "picker_1234567890123",
        }),
      )
      .mockResolvedValueOnce(
        Response.json({
          pending: {
            attemptId: "picker_1234567890123",
            expiresAt: "2026-09-23T12:00:00+00:00",
            files: [
              {
                documentId: "drive_file_123456789012",
                name: "Statement.pdf",
                mimeType: "application/pdf",
              },
            ],
          },
        }),
      )
      .mockResolvedValueOnce(Response.json({ documents: [] }))
      .mockResolvedValueOnce(Response.json({}));

    await expect(
      ExternalConnectorService.startNativePicker({
        vaultOwnerToken: "owner-token",
        redirectUri:
          "https://api.uat.hushh.ai/api/connectors/google_drive/picker/native/callback",
        isEffectCurrent,
      }),
    ).resolves.toMatchObject({ attemptId: "picker_1234567890123" });
    await expect(
      ExternalConnectorService.pendingNativePicker({
        vaultOwnerToken: "owner-token",
        isEffectCurrent,
      }),
    ).resolves.toMatchObject({ attemptId: "picker_1234567890123" });

    // Reading a staged candidate does not confirm it.
    expect(apiFetch.mock.calls.map((call) => call[0])).not.toContain(
      "/api/connectors/google_drive/picker/native/confirm",
    );

    await ExternalConnectorService.confirmNativePicker({
      vaultOwnerToken: "owner-token",
      attemptId: "picker_1234567890123",
      isEffectCurrent,
    });
    await ExternalConnectorService.cancelNativePicker({
      vaultOwnerToken: "owner-token",
      attemptId: "picker_1234567890123",
      isEffectCurrent,
    });

    expect(apiFetch.mock.calls.map((call) => call[0])).toEqual([
      "/api/connectors/google_drive/picker/native/start",
      "/api/connectors/google_drive/picker/native/pending",
      "/api/connectors/google_drive/picker/native/confirm",
      "/api/connectors/google_drive/picker/native/cancel",
    ]);
    expect(JSON.stringify(apiFetch.mock.calls)).not.toContain("accessToken");
    expect(JSON.stringify(apiFetch.mock.calls)).not.toContain("refreshToken");
  });
});

describe("ExternalConnectorService live Drive background preparation", () => {
  beforeEach(() => { placement.mockResolvedValue(false); apiFetch.mockReset(); });

  it("reads and sets live background preparation with explicit confirmation", async () => {
    apiFetch.mockResolvedValueOnce(Response.json({ enabled: true }));
    await expect(ExternalConnectorService.liveBackground("owner-token")).resolves.toBe(true);
    expect(apiFetch).toHaveBeenLastCalledWith(
      "/api/connectors/google_drive/live/background",
      expect.objectContaining({
        method: "GET",
        cache: "no-store",
        headers: { Authorization: "Bearer owner-token" },
      }),
    );

    // An invalid response must not masquerade as a user choice to turn it off.
    apiFetch.mockResolvedValueOnce(Response.json({ enabled: "true" }));
    await expect(ExternalConnectorService.liveBackground("owner-token")).rejects.toThrow("Invalid background Drive access state");
    apiFetch.mockResolvedValueOnce(Response.json({}));
    await expect(ExternalConnectorService.liveBackground("owner-token")).rejects.toThrow("Invalid background Drive access state");

    apiFetch.mockResolvedValueOnce(Response.json({ enabled: true }));
    await expect(ExternalConnectorService.setLiveBackground("owner-token", true)).resolves.toBe(true);
    const [path, init] = apiFetch.mock.calls.at(-1)!;
    expect(path).toBe("/api/connectors/google_drive/live/background");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body)).toEqual({ enabled: true, confirmed: true });
    expect(init.headers).toEqual({
      Authorization: "Bearer owner-token",
      "Content-Type": "application/json",
    });

    apiFetch.mockResolvedValueOnce(Response.json({ enabled: false }));
    await expect(ExternalConnectorService.setLiveBackground("owner-token", false)).resolves.toBe(false);
    apiFetch.mockResolvedValueOnce(Response.json({ enabled: true }));
    await expect(ExternalConnectorService.setLiveBackground("owner-token", false)).rejects.toThrow("Background Drive access state was not confirmed");
  });
});
