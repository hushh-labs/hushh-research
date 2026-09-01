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

  it("merges a duration response without losing identity or accepting an older refresh", async () => {
    const userId = "location-resource-owner";
    const initial = {
      recipients: [],
      ownerGrants: [
        {
          id: "grant_1",
          ownerUserId: userId,
          recipientUserId: "friend",
          recipientDisplayName: "Trusted Friend",
          recipientKeyId: "key_friend",
          status: "active",
          consentScope: "cap.location.live.view",
          capabilityScopes: ["cap.location.live.view"],
          durationMode: "timed",
          durationHours: 1,
          expiresAt: "2026-09-01T09:00:00.000Z",
        },
      ],
    } as unknown as OneLocationState;
    OneLocationStateResource.write(userId, initial);

    let resolveStale!: (state: OneLocationState) => void;
    const staleLoad = OneLocationStateResource.load(
      userId,
      () =>
        new Promise<OneLocationState>((resolve) => {
          resolveStale = resolve;
        }),
    );

    expect(
      OneLocationStateResource.mergeOwnerGrant(userId, {
        id: "grant_1",
        status: "active",
        durationMode: "until_stopped",
        durationHours: null,
        expiresAt: null,
      }),
    ).toBe(true);
    expect(
      OneLocationStateResource.peek(userId)?.data.ownerGrants[0],
    ).toMatchObject({
      id: "grant_1",
      recipientUserId: "friend",
      recipientDisplayName: "Trusted Friend",
      recipientKeyId: "key_friend",
      durationMode: "until_stopped",
      expiresAt: null,
    });

    resolveStale(initial);
    await staleLoad;
    expect(
      OneLocationStateResource.peek(userId)?.data.ownerGrants[0],
    ).toMatchObject({
      recipientDisplayName: "Trusted Friend",
      durationMode: "until_stopped",
      expiresAt: null,
    });
  });
});
