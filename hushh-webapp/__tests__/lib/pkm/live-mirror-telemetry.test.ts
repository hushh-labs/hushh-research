import { readFileSync } from "node:fs";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({ track: vi.fn() }));
// Only the sink is replaced; the bucket helpers stay real.
vi.mock("@/lib/observability/client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/observability/client")>()),
  trackEvent: m.track,
}));

import { resetWebGtmHitBudgetForTests } from "@/lib/observability/adapters/web-gtm";
import {
  toCountBucket,
  toDurationBucket,
  toMinuteDurationBucket,
} from "@/lib/observability/client";
import {
  emitLiveMemorySourceTelemetry,
  planLiveMemorySourceTelemetry,
  type LiveMemorySourceCheck,
} from "@/lib/pkm/live-mirror-telemetry";

const EVENT_MATRIX = path.resolve(
  __dirname, "../../../../docs/reference/operations/observability-event-matrix.md",
);
const STORED = { stored: true };
const DECLARED_KEYS = ["kind", "lag_bucket", "outcome", "pending_bucket", "retry_bucket"];

const check = (overrides: Partial<LiveMemorySourceCheck> = {}): LiveMemorySourceCheck => ({
  kind: "consent",
  outcome: "verified",
  lagMs: 42_000,
  pendingCount: 2,
  retryCount: 0,
  ...overrides,
});
/** A check that carries more than it should, as a careless caller might. */
const leakyCheck = () => ({
  ...check(),
  recordId: "grant-7f3a",
  value: "attr.travel.visits",
  ownerId: "UWHGeUyfUAbmEl5xwIPoWJ7Cyft2",
  verifiedAt: "2026-10-15T10:00:00.000Z",
}) as LiveMemorySourceCheck;
const LEAKED = /grant-7f3a|attr\.|UWHGe|2026-|42000|recordId|ownerId|lagMs/;

function expectContextControlsBeforeEvents(calls: unknown[][], events: unknown[][]) {
  const context = { page_location: window.location.href, page_referrer: document.referrer };
  expect(calls).toHaveLength(events.length * 3);
  for (let index = 0; index < events.length; index += 1) {
    expect(calls.slice(index * 3, index * 3 + 2)).toEqual([
      ["set", context],
      ["config", "G-LIVEMEMORY1", { update: true, send_page_view: false, ...context }],
    ]);
    expect(calls[index * 3 + 2]).toEqual(events[index]);
  }
}

describe("minute-scale and count buckets", () => {
  it.each([
    [null, "unknown"],
    [undefined, "unknown"],
    [Number.NaN, "unknown"],
    [-1, "unknown"],
    [0, "lt_1m"],
    [59_999, "lt_1m"],
    [60_000, "1m_5m"],
    [299_999, "1m_5m"],
    [300_000, "5m_15m"],
    [899_999, "5m_15m"],
    [900_000, "15m_1h"],
    [3_599_999, "15m_1h"],
    [3_600_000, "gte_1h"],
  ] as const)("buckets a lag of %s ms as %s", (lagMs, bucket) => {
    expect(toMinuteDurationBucket(lagMs)).toBe(bucket);
  });

  it("leaves the millisecond buckets with their existing meaning", () => {
    expect(toDurationBucket(99)).toBe("lt_100ms");
    expect(toDurationBucket(100)).toBe("100ms_300ms");
    expect(toDurationBucket(9_999)).toBe("3s_10s");
    expect(toDurationBucket(10_000)).toBe("gte_10s");
  });

  it.each([
    [null, "unknown"],
    [-1, "unknown"],
    [Number.NaN, "unknown"],
    [0, "0"],
    [1, "1"],
    [2, "2_5"],
    [5, "2_5"],
    [6, "6_20"],
    [20, "6_20"],
    [21, "gt_20"],
  ] as const)("buckets a count of %s as %s", (count, bucket) => {
    expect(toCountBucket(count)).toBe(bucket);
  });
});

describe("live memory source telemetry", () => {
  // A block body: a hook that returns the mock would have it run as teardown.
  beforeEach(() => {
    m.track.mockReset();
  });

  it("plans one event per kind, first check wins, every number as a band", () => {
    expect(planLiveMemorySourceTelemetry([
      check(),
      check({ kind: "consent", outcome: "unavailable", lagMs: null }),
      check({ kind: "document_earning", outcome: "capped", lagMs: null, pendingCount: null, retryCount: 7 }),
      check({ kind: "profile", lagMs: null, pendingCount: 0, retryCount: null }),
    ], STORED)).toEqual([
      { kind: "consent", outcome: "verified", lag_bucket: "lt_1m", pending_bucket: "2_5", retry_bucket: "0" },
      { kind: "document_earning", outcome: "capped", lag_bucket: "unknown", pending_bucket: "unknown", retry_bucket: "6_20" },
      { kind: "profile", outcome: "verified", lag_bucket: "unknown", pending_bucket: "0", retry_bucket: "unknown" },
    ]);
    expect(planLiveMemorySourceTelemetry([], STORED)).toEqual([]);
  });

  it("reports the always-read profile only when the build wrote a change", () => {
    const profile = check({ kind: "profile", lagMs: null, pendingCount: 0, retryCount: null });
    // A quiet wake re-reads the profile and reuses everything else: nothing to say.
    expect(planLiveMemorySourceTelemetry([profile], { stored: false })).toEqual([]);
    // A source that was read is reported either way; the profile still is not.
    expect(planLiveMemorySourceTelemetry(
      [profile, check({ kind: "document_earning", outcome: "unavailable", lagMs: null, retryCount: 1 })],
      { stored: false },
    ).map((event) => event.kind)).toEqual(["document_earning"]);
    expect(planLiveMemorySourceTelemetry([profile], STORED).map((event) => event.kind))
      .toEqual(["profile"]);
  });

  it("sends bands only: a record id, a value, an owner and a time never reach the sink", () => {
    emitLiveMemorySourceTelemetry([leakyCheck()], STORED);
    expect(m.track).toHaveBeenCalledTimes(1);
    expect(m.track).toHaveBeenCalledWith("live_memory_source_verified", {
      kind: "consent",
      outcome: "verified",
      lag_bucket: "lt_1m",
      pending_bucket: "2_5",
      retry_bucket: "0",
    });
    expect(JSON.stringify(m.track.mock.calls)).not.toMatch(LEAKED);
  });

  it("never lets the sink fail the sync", () => {
    m.track.mockImplementation(() => {
      throw new Error("sink down");
    });
    expect(() => emitLiveMemorySourceTelemetry([check()], STORED)).not.toThrow();
    expect(m.track).toHaveBeenCalledTimes(1);
  });

  it("emits only params the event matrix documents", () => {
    const row = readFileSync(EVENT_MATRIX, "utf8").split("\n")
      .find((line) => line.startsWith("| `live_memory_source_verified` |"));
    expect(row).toBeDefined();
    const paramsCell = row!.split("|").map((cell) => cell.trim())[3];
    for (const key of Object.keys(planLiveMemorySourceTelemetry([check()], STORED)[0]!))
      expect(paramsCell).toContain(`\`${key}\``);
  });
});

/**
 * The real path to the web stream: client, schema, then the GTM adapter, which
 * forwards whatever the schema kept. Only the declared keys may arrive.
 */
describe("live memory source telemetry on the web stream", () => {
  let gtag: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    const actual = await vi.importActual<typeof import("@/lib/observability/client")>(
      "@/lib/observability/client",
    );
    m.track.mockReset();
    m.track.mockImplementation(actual.trackEvent);
    vi.stubEnv("NEXT_PUBLIC_FIREBASE_MEASUREMENT_ID", "G-LIVEMEMORY1");
    window.dataLayer = [];
    gtag = vi.fn();
    window.gtag = gtag;
    resetWebGtmHitBudgetForTests();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    delete window.gtag;
    delete window.dataLayer;
  });

  it("forwards only the declared keys to dataLayer and gtag, even from a leaky check", () => {
    emitLiveMemorySourceTelemetry([
      leakyCheck(),
      check({ kind: "document_request_payment", outcome: "capped", lagMs: null, pendingCount: null, retryCount: 3 }),
    ], STORED);

    const pushed = (window.dataLayer ?? [])
      .filter((entry) => entry.event === "live_memory_source_verified");
    expect(pushed).toHaveLength(2);
    for (const entry of pushed)
      expect(Object.keys(entry).sort()).toEqual([
        ...DECLARED_KEYS, "app_version", "env", "event", "event_category", "event_source", "platform",
      ].sort());
    expect(pushed[0]).toMatchObject({
      kind: "consent", outcome: "verified", lag_bucket: "lt_1m",
      pending_bucket: "2_5", retry_bucket: "0", event_category: "system", platform: "web",
    });
    // The longest kind is a declared value, not an opaque id, and arrives intact.
    expect(pushed[1]).toMatchObject({
      kind: "document_request_payment", outcome: "capped", lag_bucket: "unknown",
      pending_bucket: "unknown", retry_bucket: "2_5",
    });

    const events = gtag.mock.calls.filter(([command]) => command === "event");
    expect(events).toHaveLength(2);
    for (const [command, eventName, payload] of events) {
      expect([command, eventName]).toEqual(["event", "live_memory_source_verified"]);
      expect(Object.keys(payload).sort()).toEqual([
        ...DECLARED_KEYS, "app_version", "env", "event_category", "event_source", "platform", "send_to",
      ].sort());
    }
    expectContextControlsBeforeEvents(gtag.mock.calls, events);

    // Negative control: nothing the check carried beyond its bands left the browser.
    expect(JSON.stringify([window.dataLayer, gtag.mock.calls])).not.toMatch(LEAKED);
  });
});
