// @vitest-environment node
//
// The durable half of "One should just know where I am".
//
// Two properties matter more than the rest and are asserted directly rather
// than inferred:
//
//   1. A coordinate is NEVER written to storage in the clear. The test greps
//      the raw stored string for the latitude and longitude it just saved. If
//      someone ever swaps the envelope for a plain JSON write to make a test
//      easier, that assertion fails.
//   2. A remembered fix expires on two independent clocks — how long we keep it
//      (retention) and how long it may be presented as current (the caller's
//      budget). Conflating them would either strand a stale coordinate on the
//      device or throw away the fallback that makes a cold start work.
//
// Runs in the `node` environment for the same reason `encryption.test.ts` does:
// jsdom hands out cross-realm ArrayBuffers that Node's SubtleCrypto rejects.
// `window.localStorage` is therefore supplied by hand below.

import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/capacitor", () => ({
  HushhKeychain: {
    set: vi.fn(async () => undefined),
    get: vi.fn(async () => ({ value: null })),
    delete: vi.fn(async () => undefined),
  },
}));

// Not native: the Keychain mirror is `encryption.ts`'s concern and has its own
// test. Here the IndexedDB key alone must be enough.
vi.mock("@/lib/capacitor/platform", () => ({ isNative: () => false }));

import {
  LAST_KNOWN_FIX_RETENTION_MS,
  LOCATION_GRANT_TTL_MS,
  forgetLastKnownFix,
  forgetLocationMemory,
  hasRememberedLocationGrant,
  readLastKnownFix,
  readLocationGrant,
  rememberLastKnownFix,
  rememberLocationGrant,
} from "@/lib/one-location/location-grant-memory";
import type { PlainLocationPoint } from "@/lib/one-location/types";

const USER = "user-alpha";
const OTHER_USER = "user-beta";

const LAT = 19.0759837;
const LNG = 72.8776559;

const FIX_KEY = `one_location_last_fix_v1:${USER}`;
const GRANT_KEY = `one_location_grant_v1:${USER}`;

function point(overrides: Partial<PlainLocationPoint> = {}): PlainLocationPoint {
  return {
    latitude: LAT,
    longitude: LNG,
    accuracyM: 18,
    capturedAt: new Date().toISOString(),
    sourcePlatform: "web",
    ...overrides,
  };
}

/** Minimal Storage. Deliberately real enough to throw where a browser throws. */
function createStorage(): Storage & { failWrites: boolean } {
  const map = new Map<string, string>();
  return {
    failWrites: false,
    get length() {
      return map.size;
    },
    key: (index: number) => [...map.keys()][index] ?? null,
    getItem: (key: string) => (map.has(key) ? map.get(key)! : null),
    setItem(this: { failWrites: boolean }, key: string, value: string) {
      if (this.failWrites) throw new Error("QuotaExceededError");
      map.set(key, value);
    },
    removeItem: (key: string) => void map.delete(key),
    clear: () => map.clear(),
  } as Storage & { failWrites: boolean };
}

let storage: ReturnType<typeof createStorage>;

beforeEach(() => {
  storage = createStorage();
  (globalThis as { window?: unknown }).window = { localStorage: storage };
});

afterEach(() => {
  delete (globalThis as { window?: unknown }).window;
  vi.clearAllMocks();
});

/** Rewrite a stored record's timestamps to simulate the passage of time. */
function ageStoredFix(params: { capturedAgoMs?: number; storedAgoMs?: number }) {
  const raw = storage.getItem(FIX_KEY);
  if (!raw) throw new Error("no stored fix to age");
  const record = JSON.parse(raw) as { capturedAt: string; storedAt: string };
  if (params.capturedAgoMs !== undefined) {
    record.capturedAt = new Date(Date.now() - params.capturedAgoMs).toISOString();
  }
  if (params.storedAgoMs !== undefined) {
    record.storedAt = new Date(Date.now() - params.storedAgoMs).toISOString();
  }
  storage.setItem(FIX_KEY, JSON.stringify(record));
}

describe("the sealed last-known fix", () => {
  it("survives a cold start and returns the same coordinate", async () => {
    await rememberLastKnownFix({ userId: USER, point: point() });

    const restored = await readLastKnownFix({
      userId: USER,
      maxAgeMs: LAST_KNOWN_FIX_RETENTION_MS,
    });

    expect(restored?.latitude).toBeCloseTo(LAT, 10);
    expect(restored?.longitude).toBeCloseTo(LNG, 10);
  });

  it("never writes a coordinate to storage in the clear", async () => {
    await rememberLastKnownFix({ userId: USER, point: point() });

    const raw = storage.getItem(FIX_KEY);
    expect(raw).toBeTruthy();
    // The whole record, not just the ciphertext field: a future refactor that
    // adds a "convenient" plaintext lat/lng alongside the envelope must fail.
    expect(raw).not.toContain("19.07");
    expect(raw).not.toContain("72.87");
    expect(raw).not.toContain(String(LAT));
    expect(raw).not.toContain(String(LNG));
    expect(JSON.parse(raw!).envelope.metadata.plaintext).toBe(false);
  });

  it("drops a Drive destination rather than persisting it with the point", async () => {
    await rememberLastKnownFix({
      userId: USER,
      point: point({
        drive: {
          destinationLabel: "Home",
          destinationLatitude: 1,
          destinationLongitude: 2,
        } as PlainLocationPoint["drive"],
      }),
    });

    const restored = await readLastKnownFix({
      userId: USER,
      maxAgeMs: LAST_KNOWN_FIX_RETENTION_MS,
    });

    // A share's destination is justified by that share, not by "where I last
    // was", and must not outlive it on the device.
    expect(restored?.drive ?? null).toBeNull();
  });

  it("keeps a fix that is too old to present but still worth keeping", async () => {
    await rememberLastKnownFix({ userId: USER, point: point() });
    ageStoredFix({ capturedAgoMs: 30 * 60_000 });

    // The Nearby drawer's in-session budget refuses it...
    await expect(
      readLastKnownFix({ userId: USER, maxAgeMs: 10 * 60_000 }),
    ).resolves.toBeNull();
    // ...but it is still on disk, because a longer-budget caller may use it and
    // it is still a better starting point than nothing.
    expect(storage.getItem(FIX_KEY)).toBeTruthy();
    await expect(
      readLastKnownFix({ userId: USER, maxAgeMs: 60 * 60_000 }),
    ).resolves.not.toBeNull();
  });

  it("deletes a fix once retention has run out", async () => {
    await rememberLastKnownFix({ userId: USER, point: point() });
    ageStoredFix({ storedAgoMs: LAST_KNOWN_FIX_RETENTION_MS + 60_000 });

    await expect(
      readLastKnownFix({ userId: USER, maxAgeMs: LAST_KNOWN_FIX_RETENTION_MS }),
    ).resolves.toBeNull();
    // Not merely refused — gone. A coordinate nobody will ever use must not sit
    // on the device.
    expect(storage.getItem(FIX_KEY)).toBeNull();
  });

  it("refuses a fix timestamped in the future instead of trusting it forever", async () => {
    await rememberLastKnownFix({ userId: USER, point: point() });
    ageStoredFix({ capturedAgoMs: -60 * 60_000 });

    // A clock change is not a fresh fix. Treating "age is negative" as "young
    // enough" would make a skewed device reuse one coordinate indefinitely.
    await expect(
      readLastKnownFix({ userId: USER, maxAgeMs: 10 * 60_000 }),
    ).resolves.toBeNull();
  });

  it("does not hand one account's position to another", async () => {
    await rememberLastKnownFix({ userId: USER, point: point() });

    await expect(
      readLastKnownFix({
        userId: OTHER_USER,
        maxAgeMs: LAST_KNOWN_FIX_RETENTION_MS,
      }),
    ).resolves.toBeNull();
  });

  it("returns nothing it cannot open, but does not throw the record away", async () => {
    await rememberLastKnownFix({ userId: USER, point: point() });
    const raw = JSON.parse(storage.getItem(FIX_KEY)!);
    // The envelope now names a key this device does not currently hold.
    raw.envelope.recipientKeyId = "not-the-current-key";
    storage.setItem(FIX_KEY, JSON.stringify(raw));

    await expect(
      readLastKnownFix({ userId: USER, maxAgeMs: LAST_KNOWN_FIX_RETENTION_MS }),
    ).resolves.toBeNull();
    // A key that has rotated away for good and a key that has not finished
    // being provisioned fail identically here. Deleting would turn that race
    // into permanent loss of a good fix, so retention is left to clear it.
    expect(storage.getItem(FIX_KEY)).toBeTruthy();
  });

  it("drops an unparseable record without throwing", async () => {
    storage.setItem(FIX_KEY, "{not json");

    await expect(
      readLastKnownFix({ userId: USER, maxAgeMs: LAST_KNOWN_FIX_RETENTION_MS }),
    ).resolves.toBeNull();
    expect(storage.getItem(FIX_KEY)).toBeNull();
  });

  it("refuses a point with no usable coordinate", async () => {
    await rememberLastKnownFix({
      userId: USER,
      point: point({ latitude: Number.NaN }),
    });

    expect(storage.getItem(FIX_KEY)).toBeNull();
  });
});

describe("the remembered grant", () => {
  it("is recorded once and renewed on every later fix", () => {
    rememberLocationGrant(USER);
    const first = readLocationGrant(USER);
    expect(first).not.toBeNull();

    const stored = JSON.parse(storage.getItem(GRANT_KEY)!);
    stored.lastConfirmedAt = new Date(Date.now() - 60_000).toISOString();
    storage.setItem(GRANT_KEY, JSON.stringify(stored));

    rememberLocationGrant(USER);
    const second = readLocationGrant(USER)!;

    // "Since when" never moves; "still true as of" always does. That is what
    // keeps an account in normal use from ever ageing out of its own grant.
    expect(second.grantedAt).toBe(first!.grantedAt);
    expect(Date.parse(second.lastConfirmedAt)).toBeGreaterThan(
      Date.parse(stored.lastConfirmedAt),
    );
  });

  it("expires only after a long idle window, then forgets itself", () => {
    rememberLocationGrant(USER);
    const stored = JSON.parse(storage.getItem(GRANT_KEY)!);

    stored.lastConfirmedAt = new Date(
      Date.now() - (LOCATION_GRANT_TTL_MS - 60_000),
    ).toISOString();
    storage.setItem(GRANT_KEY, JSON.stringify(stored));
    expect(hasRememberedLocationGrant(USER)).toBe(true);

    stored.lastConfirmedAt = new Date(
      Date.now() - (LOCATION_GRANT_TTL_MS + 60_000),
    ).toISOString();
    storage.setItem(GRANT_KEY, JSON.stringify(stored));
    expect(hasRememberedLocationGrant(USER)).toBe(false);
    expect(storage.getItem(GRANT_KEY)).toBeNull();
  });

  it("is per account", () => {
    rememberLocationGrant(USER);
    expect(hasRememberedLocationGrant(OTHER_USER)).toBe(false);
  });
});

describe("revocation", () => {
  it("forgets the coordinate but keeps the grant", async () => {
    rememberLocationGrant(USER);
    await rememberLastKnownFix({ userId: USER, point: point() });

    forgetLastKnownFix(USER);

    expect(storage.getItem(FIX_KEY)).toBeNull();
    expect(hasRememberedLocationGrant(USER)).toBe(true);
  });

  it("forgets everything on request", async () => {
    rememberLocationGrant(USER);
    await rememberLastKnownFix({ userId: USER, point: point() });

    forgetLocationMemory(USER);

    expect(storage.getItem(FIX_KEY)).toBeNull();
    expect(storage.getItem(GRANT_KEY)).toBeNull();
  });
});

describe("when storage is unavailable", () => {
  it("degrades quietly rather than failing the feature", async () => {
    delete (globalThis as { window?: unknown }).window;

    // Server rendering, Safari private mode, and locked-down webviews all land
    // here. None of them are location failures, so none may throw.
    expect(() => rememberLocationGrant(USER)).not.toThrow();
    expect(readLocationGrant(USER)).toBeNull();
    await expect(
      rememberLastKnownFix({ userId: USER, point: point() }),
    ).resolves.toBeUndefined();
    await expect(
      readLastKnownFix({ userId: USER, maxAgeMs: LAST_KNOWN_FIX_RETENTION_MS }),
    ).resolves.toBeNull();
  });

  it("survives a storage quota rejection", async () => {
    storage.failWrites = true;

    expect(() => rememberLocationGrant(USER)).not.toThrow();
    await expect(
      rememberLastKnownFix({ userId: USER, point: point() }),
    ).resolves.toBeUndefined();
  });

  it("does nothing at all without an account", async () => {
    rememberLocationGrant(null);
    await rememberLastKnownFix({ userId: null, point: point() });

    expect(storage.length).toBe(0);
    await expect(
      readLastKnownFix({ userId: null, maxAgeMs: LAST_KNOWN_FIX_RETENTION_MS }),
    ).resolves.toBeNull();
  });
});
