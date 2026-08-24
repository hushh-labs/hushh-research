import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { selectAutoApprovableRequests } from "@/lib/one-location/auto-approve-requests";
import type { AutoApproveScope } from "@/lib/one-location/location-control-state";
import type { OneLocationAccessRequest } from "@/lib/one-location/types";

/**
 * Auto-approve hands out live location without a tap, so what this function
 * refuses matters more than what it allows. Every test below is a way of
 * asking "could this approve somebody the owner never agreed to?".
 */

const ENABLED_AT = "2026-08-14T12:00:00.000Z";
const ENABLED_AT_MS = Date.parse(ENABLED_AT);
const PAGE_SOURCE = readFileSync(
  join(process.cwd(), "app/one/location/page.tsx"),
  "utf8",
);

function request(
  overrides: Partial<OneLocationAccessRequest> = {},
): OneLocationAccessRequest {
  return {
    id: "req_after",
    ownerUserId: "user_me",
    requesterUserId: "user_abdul",
    status: "pending",
    requestedAt: new Date(ENABLED_AT_MS + 60_000).toISOString(),
    ...overrides,
  } as OneLocationAccessRequest;
}

function select(input: {
  pendingRequests?: OneLocationAccessRequest[];
  enabled?: boolean;
  enabledAt?: string | null;
  scope?: AutoApproveScope | null;
  paused?: boolean;
  alreadyAttemptedIds?: Set<string>;
}) {
  return selectAutoApprovableRequests({
    pendingRequests: input.pendingRequests ?? [request()],
    enabled: input.enabled ?? true,
    enabledAt: input.enabledAt === undefined ? ENABLED_AT : input.enabledAt,
    scope: input.scope === undefined ? { kind: "all_contacts" } : input.scope,
    paused: input.paused ?? false,
    alreadyAttemptedIds: input.alreadyAttemptedIds ?? new Set<string>(),
  });
}

describe("a request that arrives after the setting is switched on", () => {
  it("is the one case that approves without asking", () => {
    expect(select({}).map((entry) => entry.id)).toEqual(["req_after"]);
  });
});

describe("the automatic approval mutation", () => {
  it("sends only the current server-owned rule version", () => {
    expect(PAGE_SOURCE).toContain("autoApproveRuleVersion: automatic");
    expect(PAGE_SOURCE).toContain("autoApprovePreference.ruleVersion");
    expect(PAGE_SOURCE).not.toContain("autoApproveScope: automatic");
    expect(PAGE_SOURCE).not.toContain("autoApproveEnabledAt: automatic");
  });

  it("starts one request at a time and leaves scope enforcement to the server", () => {
    expect(PAGE_SOURCE).toContain("const [request] = approvable");
    expect(PAGE_SOURCE).not.toContain("isRequesterInScope");
    expect(PAGE_SOURCE).toContain("Number.isInteger(autoApprovePreference.ruleVersion)");
    expect(PAGE_SOURCE).toContain("autoApproveRequestInFlightRef.current");
    expect(PAGE_SOURCE).not.toContain("for (const request of approvable)");
  });
});

describe("requests already waiting when it was switched on", () => {
  it("stay the owner's own decision", () => {
    // The scope the owner asked for. Flipping a setting is not an answer to
    // the specific people who are already asking -- some of whom may have been
    // left unanswered deliberately.
    const waiting = request({
      id: "req_before",
      requestedAt: new Date(ENABLED_AT_MS - 60_000).toISOString(),
    });
    expect(select({ pendingRequests: [waiting] })).toEqual([]);
  });

  it("does not block a newer request that arrives alongside them", () => {
    const waiting = request({
      id: "req_before",
      requestedAt: new Date(ENABLED_AT_MS - 60_000).toISOString(),
    });
    const selected = select({ pendingRequests: [waiting, request()] });
    expect(selected.map((entry) => entry.id)).toEqual(["req_after"]);
  });

  it("treats one that landed on the same millisecond as already waiting", () => {
    // Strictly after, never "at or after". A tie cannot be shown to have
    // arrived because of the setting, so it waits for a tap.
    const simultaneous = request({ id: "req_tie", requestedAt: ENABLED_AT });
    expect(select({ pendingRequests: [simultaneous] })).toEqual([]);
  });
});

describe("when the setting is not actually on", () => {
  it("approves nothing while it is off", () => {
    expect(select({ enabled: false })).toEqual([]);
  });

  it("approves nothing without a scope", () => {
    expect(select({ scope: null })).toEqual([]);
  });

  it("approves nothing without a readable watermark", () => {
    // A missing or corrupt timestamp must not read as "approve everything".
    expect(select({ enabledAt: null })).toEqual([]);
    expect(select({ enabledAt: "not-a-date" })).toEqual([]);
  });
});

describe("scope boundaries", () => {
  it("schedules an all-contacts candidate for server validation", () => {
    expect(
      select({ scope: { kind: "all_contacts" } }).map((entry) => entry.id),
    ).toEqual(["req_after"]);
  });

  it("schedules a Circle candidate for server validation", () => {
    expect(
      select({
        scope: { kind: "circle", circleId: "circle_family" },
      }).map((entry) => entry.id),
    ).toEqual(["req_after"]);
  });
});

describe("when the owner has paused their location", () => {
  it("approves nothing, because pause outranks convenience", () => {
    // "Stop sending my location" cannot coexist with starting a new share.
    expect(select({ paused: true })).toEqual([]);
  });
});

describe("requests this device has already handled", () => {
  it("never attempts the same one twice", () => {
    // Attempted, not succeeded: one that failed will keep failing, and
    // retrying on every state change would spam the owner with one error.
    expect(select({ alreadyAttemptedIds: new Set(["req_after"]) })).toEqual([]);
  });
});

describe("requests that are no longer open", () => {
  it("ignores anything not still pending", () => {
    const denied = request({ id: "req_denied", status: "denied" });
    const cancelled = request({ id: "req_cancelled", status: "cancelled" });
    expect(select({ pendingRequests: [denied, cancelled] })).toEqual([]);
  });

  it("ignores a request with no readable arrival time", () => {
    expect(
      select({ pendingRequests: [request({ requestedAt: null })] }),
    ).toEqual([]);
    expect(
      select({ pendingRequests: [request({ requestedAt: "whenever" })] }),
    ).toEqual([]);
  });
});

describe("open-ended requests", () => {
  it("keeps ongoing access for an explicit owner decision", () => {
    expect(
      select({
        pendingRequests: [
          request({ requestedDurationMode: "until_stopped" }),
        ],
      }),
    ).toEqual([]);
  });
});
