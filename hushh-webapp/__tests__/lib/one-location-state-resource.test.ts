import { afterEach, describe, expect, it, vi } from "vitest";

import type { OneLocationState } from "@/lib/one-location/types";
import { OneLocationStateResource } from "@/lib/one-location/one-location-state-resource";
import { CacheService } from "@/lib/services/cache-service";

describe("OneLocationStateResource", () => {
  afterEach(() => {
    CacheService.getInstance().clear();
  });

  it("single-flights concurrent loads and publishes one memory snapshot", async () => {
    const userId = "location-resource-owner";
    let resolve!: (state: OneLocationState) => void;
    const loader = vi.fn(
      () =>
        new Promise<OneLocationState>((done) => {
          resolve = done;
        }),
    );
    const state = { recipients: [] } as unknown as OneLocationState;

    const first = OneLocationStateResource.load(userId, loader);
    const second = OneLocationStateResource.load(userId, loader);
    expect(first).toBe(second);
    expect(loader).toHaveBeenCalledTimes(1);

    resolve(state);
    await expect(first).resolves.toBe(state);
    expect(OneLocationStateResource.peek(userId)?.data).toBe(state);
  });

  it("does not publish a load invalidated before settlement", async () => {
    const userId = "location-resource-owner";
    let resolve!: (state: OneLocationState) => void;
    const request = OneLocationStateResource.load(
      userId,
      () =>
        new Promise<OneLocationState>((done) => {
          resolve = done;
        }),
    );
    OneLocationStateResource.invalidate(userId);
    resolve({ recipients: [] } as unknown as OneLocationState);
    await request;
    expect(OneLocationStateResource.peek(userId)).toBeNull();
  });

  it("keeps a user-scoped memory snapshot available for same-session route re-entry", () => {
    const userId = "location-resource-owner";
    const snapshot = { recipients: [] } as OneLocationState;

    OneLocationStateResource.write(userId, snapshot);

    expect(OneLocationStateResource.peek(userId)?.data).toBe(snapshot);
    expect(OneLocationStateResource.peek("another-owner")).toBeNull();
  });

  it("publishes SMS membership immediately and rejects an older in-flight snapshot", async () => {
    const userId = "location-resource-owner";
    const initial = {
      recipients: [],
      smsContactUserIds: ["selected"],
    } as unknown as OneLocationState;
    OneLocationStateResource.write(userId, initial);

    let resolve!: (state: OneLocationState) => void;
    const staleLoad = OneLocationStateResource.load(
      userId,
      () =>
        new Promise<OneLocationState>((done) => {
          resolve = done;
        }),
    );

    expect(OneLocationStateResource.replaceSmsContactUserIds(userId, [])).toBe(
      true,
    );
    expect(
      OneLocationStateResource.peek(userId)?.data.smsContactUserIds,
    ).toEqual([]);

    resolve(initial);
    await staleLoad;
    expect(
      OneLocationStateResource.peek(userId)?.data.smsContactUserIds,
    ).toEqual([]);
  });
});
