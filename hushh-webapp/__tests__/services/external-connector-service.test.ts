import { beforeEach, describe, expect, it, vi } from "vitest";

const apiFetch = vi.hoisted(() => vi.fn());

vi.mock("@/lib/services/api-service", () => ({
  ApiService: {
    apiFetch,
    getAuthHeaders: (token: string) => ({ Authorization: `Bearer ${token}` }),
  },
}));

import { ExternalConnectorService } from "@/lib/services/external-connector-service";

describe("ExternalConnectorService native Drive OAuth", () => {
  beforeEach(() => apiFetch.mockReset());

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
        }),
      }),
    );
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
