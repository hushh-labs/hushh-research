import { beforeEach, describe, expect, it, vi } from "vitest";

const { apiFetch } = vi.hoisted(() => ({ apiFetch: vi.fn() }));
vi.mock("@/lib/services/api-service", () => ({ ApiService: { apiFetch } }));
import { GoogleCalendarService } from "@/lib/services/google-calendar-service";

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
});
