import { beforeEach, describe, expect, it, vi } from "vitest";
const { apiFetch } = vi.hoisted(() => ({ apiFetch: vi.fn() }));
vi.mock("@/lib/services/api-service", () => ({ ApiService: { apiFetch } }));
import {
  GoogleDriveService,
  captureDriveConnectionContext,
} from "@/lib/services/google-drive-service";
import { publishValidatedAuthSessionOwner } from "@/lib/auth/session-owner";
import { advanceVaultSessionEpoch } from "@/lib/vault/session-epoch";
import { CacheService } from "@/lib/services/cache-service";

const connected = {
  configured: true,
  connected: true,
  status: "connected",
  access_level: "read",
  google_email: null,
  scope_csv: "",
};
const disconnected = {
  ...connected,
  connected: false,
  status: "disconnected",
  access_level: null,
};
const response = (body: unknown) => ({ ok: true, json: async () => body });
function context(
  getIdToken = vi.fn(async () => "synthetic-token"),
  isCurrent = () => true,
) {
  return captureDriveConnectionContext(
    { uid: "owner-a", getIdToken },
    isCurrent,
  );
}
describe("Drive connection service", () => {
  beforeEach(() => {
    apiFetch.mockReset();
    CacheService.getInstance().clear();
    publishValidatedAuthSessionOwner(null);
    publishValidatedAuthSessionOwner("owner-a");
  });
  it("retains the exact server-issued native state and forces read-only", async () => {
    const start = {
      service: "drive",
      access_level: "read",
      state: "synthetic-exact-state",
      server_client_id: "synthetic-client",
    };
    apiFetch
      .mockResolvedValueOnce(response(start))
      .mockResolvedValueOnce(response(connected));
    const ctx = context();
    const prepared = await GoogleDriveService.startNative(ctx);
    await GoogleDriveService.completeNative(
      ctx,
      prepared.state,
      "synthetic-code",
    );
    expect(JSON.parse(apiFetch.mock.calls[1][1].body)).toEqual({
      user_id: "owner-a",
      state: start.state,
      server_auth_code: "synthetic-code",
      access_level: "read",
    });
    expect(apiFetch.mock.calls[1][1].isEffectCurrent()).toBe(true);
  });
  it.each([
    {
      service: "calendar",
      access_level: "read",
      state: "state",
      server_client_id: "client",
    },
    {
      service: "drive",
      access_level: "write",
      state: "state",
      server_client_id: "client",
    },
    {
      service: "drive",
      access_level: "read",
      state: " ",
      server_client_id: "client",
    },
  ])("rejects malformed or wrong-service native starts", async (body) => {
    apiFetch.mockResolvedValue(response(body));
    await expect(GoogleDriveService.startNative(context())).rejects.toThrow(
      "could not be prepared",
    );
  });
  it.each(["owner", "vault", "unmount"])(
    "rejects late token acquisition after %s changes",
    async (kind) => {
      let finish!: (token: string) => void;
      let mounted = true;
      const ctx = context(
        vi.fn(
          () =>
            new Promise<string>((resolve) => {
              finish = resolve;
            }),
        ),
        () => mounted,
      );
      const pending = GoogleDriveService.startWeb(ctx);
      if (kind === "owner") {
        publishValidatedAuthSessionOwner("owner-b");
        publishValidatedAuthSessionOwner("owner-a");
      } else if (kind === "vault") advanceVaultSessionEpoch();
      else mounted = false;
      finish("synthetic-token");
      await expect(pending).rejects.toMatchObject({ name: "AbortError" });
      expect(apiFetch).not.toHaveBeenCalled();
    },
  );
  it("rechecks the effect at final transport dispatch and rejects late responses", async () => {
    let finish!: (value: unknown) => void;
    apiFetch.mockResolvedValue({
      ok: true,
      json: () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    });
    const ctx = context();
    const pending = GoogleDriveService.status(ctx);
    await vi.waitFor(() => expect(apiFetch).toHaveBeenCalledOnce());
    advanceVaultSessionEpoch();
    expect(apiFetch.mock.calls[0][1].isEffectCurrent()).toBe(false);
    finish(connected);
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(
      CacheService.getInstance().get(GoogleDriveService.cacheKey(ctx)),
    ).toBeNull();
  });
  it("does not allow an old status read to overwrite a disconnect", async () => {
    let finish!: (value: unknown) => void;
    apiFetch
      .mockResolvedValueOnce({
        ok: true,
        json: () =>
          new Promise((resolve) => {
            finish = resolve;
          }),
      })
      .mockResolvedValueOnce(response(disconnected));
    const ctx = context();
    const pending = GoogleDriveService.status(ctx);
    await vi.waitFor(() => expect(apiFetch).toHaveBeenCalledOnce());
    await GoogleDriveService.disconnect(ctx);
    finish(connected);
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(await GoogleDriveService.status(ctx)).toEqual(disconnected);
    expect(apiFetch).toHaveBeenCalledTimes(2);
  });
  it("reuses only fresh memory status and purges it with the owner", async () => {
    apiFetch.mockResolvedValue(response(connected));
    const ctx = context();
    await GoogleDriveService.status(ctx);
    await GoogleDriveService.status(ctx);
    expect(apiFetch).toHaveBeenCalledOnce();
    CacheService.getInstance().invalidateUser("owner-a");
    await GoogleDriveService.status(ctx);
    expect(apiFetch).toHaveBeenCalledTimes(2);
  });
  it.each([
    "https://example.invalid/o/oauth2/v2/auth",
    "https://secret@accounts.google.com/o/oauth2/v2/auth",
    "https://accounts.google.com/wrong-path",
  ])("rejects unsafe authorization URLs", async (authorize_url) => {
    apiFetch.mockResolvedValue(response({ authorize_url }));
    await expect(GoogleDriveService.startWeb(context())).rejects.toThrow(
      "could not be prepared",
    );
  });
});
