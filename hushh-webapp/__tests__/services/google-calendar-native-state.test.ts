import { beforeEach, describe, expect, it, vi } from "vitest";

const { apiFetch } = vi.hoisted(() => ({ apiFetch: vi.fn() }));
vi.mock("@/lib/services/api-service", () => ({ ApiService: { apiFetch } }));
import { GoogleCalendarError, GoogleCalendarService } from "@/lib/services/google-calendar-service";

describe("native Google attempt state", () => {
  beforeEach(() => apiFetch.mockReset());

  it("rejects an older server without bound state before native sign-in", async () => {
    apiFetch.mockResolvedValue(
      new Response(
        JSON.stringify({
          configured: true,
          server_client_id: "synthetic-client",
        }),
      ),
    );
    await expect(
      GoogleCalendarService.startNativeConnect({
        idToken: "synthetic-token",
        accessLevel: "read",
      }),
    ).rejects.toThrow("could not be prepared");
  });

  it("carries the exact server-issued state to completion", async () => {
    apiFetch.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          configured: true,
          server_client_id: "synthetic-client",
          service: "calendar",
          access_level: "read",
          state: "synthetic-bound-state",
        }),
      ),
    );
    const start = await GoogleCalendarService.startNativeConnect({
      idToken: "synthetic-token",
      accessLevel: "read",
    });
    apiFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ connected: true })),
    );
    await GoogleCalendarService.completeNativeConnect({
      idToken: "synthetic-token",
      userId: "synthetic-owner",
      accessLevel: "read",
      serverAuthCode: "synthetic-code",
      state: start.state,
    });
    const [path, request] = apiFetch.mock.calls[1];
    expect(path).toBe("/api/one/calendar/connect/native/complete");
    expect(JSON.parse(request.body)).toEqual({
      user_id: "synthetic-owner",
      access_level: "read",
      server_auth_code: "synthetic-code",
      state: "synthetic-bound-state",
    });
  });

  it("does not submit completion without state", async () => {
    await expect(
      GoogleCalendarService.completeNativeConnect({
        idToken: "synthetic-token",
        userId: "synthetic-owner",
        accessLevel: "read",
        serverAuthCode: "synthetic-code",
        state: "",
      }),
    ).rejects.toThrow("Restart");
    expect(apiFetch).not.toHaveBeenCalled();
  });
  it.each([
    ["calendar_not_connected", "connect"],
    ["calendar_reauthorization_required", "reconnect"],
    ["calendar_permission_required", "permission"],
    ["calendar_list_permission_required", "permission"],
    ["calendar_rate_limited", "retry"],
    ["calendar_timeout", "retry"],
    ["unknown_reason", "retry"],
  ])("preserves the typed reason %s without guessing recovery from prose", async (reason_code, recovery) => {
    apiFetch.mockResolvedValue(new Response(JSON.stringify({ detail: { message: "Reconnect is mentioned in arbitrary prose", reason_code } }), { status: 403 }));
    const failure = await GoogleCalendarService.listEvents({ vaultOwnerToken: "token", startAt: "2026-10-09T00:00:00Z", endAt: "2026-10-10T00:00:00Z" }).catch((error) => error);
    expect(failure).toBeInstanceOf(GoogleCalendarError);
    expect(failure.reasonCode).toBe(reason_code);
    expect(failure.recovery).toBe(recovery);
  });

});
