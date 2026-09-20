import { afterEach, describe, expect, it, vi } from "vitest";

import { OneLocationMapPreferencesResource } from "@/lib/one-location/one-location-map-preferences-resource";
import type { OneLocationMapPreferences } from "@/lib/one-location/types";

const GHOST: OneLocationMapPreferences = {
  presenceMode: "ghost",
  rendererConsentVersion: null,
  updatedAt: "2026-09-20T00:00:00.000Z",
};
const VISIBLE: OneLocationMapPreferences = {
  presenceMode: "foreground_private",
  rendererConsentVersion: "google-maps-renderer-v1",
  updatedAt: "2026-09-20T01:00:00.000Z",
};

describe("OneLocationMapPreferencesResource", () => {
  afterEach(() => {
    OneLocationMapPreferencesResource.discard("owner-a");
    OneLocationMapPreferencesResource.discard("owner-b");
  });

  it("single-flights concurrent reads per account", async () => {
    let resolve!: (value: OneLocationMapPreferences) => void;
    const loader = vi.fn(
      () =>
        new Promise<OneLocationMapPreferences>((done) => {
          resolve = done;
        }),
    );
    const first = OneLocationMapPreferencesResource.load("owner-a", loader);
    const second = OneLocationMapPreferencesResource.load("owner-a", loader);
    expect(first).toBe(second);
    expect(loader).toHaveBeenCalledTimes(1);
    resolve(GHOST);
    await first;
    expect(OneLocationMapPreferencesResource.readPresentation("owner-a")).toBe(
      GHOST,
    );
  });

  it("does not let a pre-mutation read overwrite a committed preference", async () => {
    let resolve!: (value: OneLocationMapPreferences) => void;
    const stale = OneLocationMapPreferencesResource.load(
      "owner-a",
      () =>
        new Promise<OneLocationMapPreferences>((done) => {
          resolve = done;
        }),
    );
    OneLocationMapPreferencesResource.commit("owner-a", VISIBLE);
    resolve(GHOST);
    await stale;
    expect(OneLocationMapPreferencesResource.readPresentation("owner-a")).toBe(
      VISIBLE,
    );
  });

  it("keeps account snapshots isolated", () => {
    OneLocationMapPreferencesResource.commit("owner-a", VISIBLE);
    expect(
      OneLocationMapPreferencesResource.readPresentation("owner-b"),
    ).toBeNull();
  });

  it("purges every account snapshot at an unknown-user auth boundary", () => {
    OneLocationMapPreferencesResource.write("owner-a", VISIBLE);
    OneLocationMapPreferencesResource.write("owner-b", GHOST);

    OneLocationMapPreferencesResource.discardAll();

    expect(
      OneLocationMapPreferencesResource.readPresentation("owner-a"),
    ).toBeNull();
    expect(
      OneLocationMapPreferencesResource.readPresentation("owner-b"),
    ).toBeNull();
  });
});
