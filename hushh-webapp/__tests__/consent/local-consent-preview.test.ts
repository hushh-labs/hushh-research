import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  applyLocalConsentPreviewMutation,
  getLocalConsentPreviewList,
  getLocalConsentPreviewSummary,
  resetLocalConsentPreviewState,
  revokeLocalConsentPreviewScope,
} from "@/lib/consent/local-consent-preview";
import {
  isLocalConsentPreviewRequest,
  isLocalConsentPreviewRuntime,
  syncLocalConsentPreviewSession,
} from "@/lib/consent/local-consent-preview-gate";

const USER_ID = "local-preview-user";
const FIXED_NOW = Date.parse("2026-07-23T12:00:00.000Z");
const SURFACES = ["pending", "active", "previous"] as const;

function list(
  surface: (typeof SURFACES)[number],
  options: { q?: string; page?: number; limit?: number } = {},
) {
  return getLocalConsentPreviewList({
    userId: USER_ID,
    surface,
    limit: options.limit ?? 50,
    page: options.page,
    q: options.q,
  });
}

function collectObjectKeys(value: unknown, keys = new Set<string>()) {
  if (Array.isArray(value)) {
    value.forEach((item) => collectObjectKeys(item, keys));
    return keys;
  }
  if (!value || typeof value !== "object") return keys;
  for (const [key, child] of Object.entries(value)) {
    keys.add(key.toLowerCase());
    collectObjectKeys(child, keys);
  }
  return keys;
}

describe("local consent manager preview", () => {
  beforeEach(() => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("NEXT_PUBLIC_APP_ENV", "development");
    resetLocalConsentPreviewState(FIXED_NOW);
    window.sessionStorage.clear();
    window.history.replaceState({}, "", "/one/consent");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("fails closed outside the exact local development consent surfaces", () => {
    const enabled = {
      searchParams: new URLSearchParams(
        "tab=requests&preview=consent",
      ),
      hostname: "127.0.0.1",
      pathname: "/one/consent",
      protocol: "http:",
      appEnvironment: "development" as const,
      nodeEnvironment: "development",
    };

    expect(isLocalConsentPreviewRequest(enabled)).toBe(true);
    expect(
      isLocalConsentPreviewRequest({
        ...enabled,
        nodeEnvironment: "production",
      }),
    ).toBe(false);
    expect(
      isLocalConsentPreviewRequest({
        ...enabled,
        appEnvironment: "uat",
      }),
    ).toBe(false);
    expect(
      isLocalConsentPreviewRequest({
        ...enabled,
        hostname: "uat.kai.hushh.ai",
      }),
    ).toBe(false);
    expect(
      isLocalConsentPreviewRequest({
        ...enabled,
        pathname: "/one/marketplace",
      }),
    ).toBe(false);
    expect(
      isLocalConsentPreviewRequest({
        ...enabled,
        protocol: "capacitor:",
      }),
    ).toBe(false);
    expect(
      isLocalConsentPreviewRequest({
        ...enabled,
        searchParams: new URLSearchParams(
          "tab=connections&preview=consent",
        ),
      }),
    ).toBe(false);
    expect(
      isLocalConsentPreviewRequest({
        ...enabled,
        searchParams: new URLSearchParams(
          "mode=connections&preview=consent",
        ),
      }),
    ).toBe(false);
  });

  it("stays sticky across the three fixture tabs but never enters Connections", () => {
    window.history.replaceState(
      {},
      "",
      "/one/consent?tab=requests&preview=consent",
    );
    expect(syncLocalConsentPreviewSession()).toBe(true);
    expect(isLocalConsentPreviewRuntime()).toBe(true);

    window.history.replaceState({}, "", "/one/consent?tab=active");
    expect(isLocalConsentPreviewRuntime()).toBe(true);

    window.history.replaceState({}, "", "/one/consent?tab=connections");
    expect(isLocalConsentPreviewRuntime()).toBe(false);
    expect(syncLocalConsentPreviewSession()).toBe(false);

    window.history.replaceState({}, "", "/one/consent?tab=history");
    expect(isLocalConsentPreviewRuntime()).toBe(true);

    window.history.replaceState({}, "", "/one/marketplace?preview=consent");
    expect(isLocalConsentPreviewRuntime()).toBe(false);

    window.history.replaceState({}, "", "/one/consent?preview=live");
    expect(syncLocalConsentPreviewSession()).toBe(false);
    expect(isLocalConsentPreviewRuntime()).toBe(false);
  });

  it("provides 21 realistic rows on Requests, Active, and History", () => {
    expect(getLocalConsentPreviewSummary(USER_ID).counts).toEqual({
      pending: 21,
      active: 21,
      previous: 21,
    });

    for (const surface of SURFACES) {
      const entries = list(surface).items;
      expect(entries).toHaveLength(21);
      expect(
        entries.every(
          (entry) =>
            entry.kind !== "connection_request" &&
            entry.metadata?.fixture_id === "local-consent-layout-v2",
        ),
      ).toBe(true);
    }
  });

  it("covers the production-shaped consent category matrix", () => {
    const allEntries = SURFACES.flatMap((surface) => list(surface).items);
    const categories = new Set(
      allEntries.map((entry) => entry.metadata?.fixture_category),
    );
    const sources = new Set(
      allEntries.map((entry) => entry.metadata?.fixture_source),
    );

    expect(categories.size).toBeGreaterThanOrEqual(19);
    expect([...categories]).toEqual(
      expect.arrayContaining([
        "one_invocation",
        "kyc_identity",
        "kyc_passport",
        "kyc_bank",
        "professional",
        "portfolio",
        "financial_profile",
        "financial_documents",
        "financial_analysis",
        "financial_decisions",
        "location",
        "travel",
        "health_metrics",
        "health_wellness",
        "fitness",
        "food",
        "entertainment",
        "shopping",
        "dynamic_other",
      ]),
    );
    expect([...sources]).toEqual(
      expect.arrayContaining([
        "developer_api",
        "one_a2a_invocation",
        "one_email_kyc_v1",
        "ria_iam",
        "one_location_access_request",
        "one_location_share_grant",
        "marketplace_access_request",
        "consent_ledger",
      ]),
    );
  });

  it("uses canonical location and entertainment scopes without coordinates", () => {
    const allEntries = SURFACES.flatMap((surface) => list(surface).items);
    const locationEntries = allEntries.filter(
      (entry) =>
        entry.metadata?.fixture_category === "location" ||
        String(entry.metadata?.request_source || "").startsWith("one_location"),
    );
    const forbiddenKeys = new Set([
      "address",
      "lat",
      "latitude",
      "lng",
      "longitude",
      "map",
    ]);

    expect(locationEntries.length).toBeGreaterThan(0);
    for (const entry of locationEntries) {
      expect(entry.scope).toBe("cap.location.live.view");
      const keys = collectObjectKeys(entry);
      expect([...keys].filter((key) => forbiddenKeys.has(key))).toEqual([]);
    }
    expect(
      allEntries.some(
        (entry) => entry.scope === "attr.entertainment.preferences.*",
      ),
    ).toBe(true);
    expect(
      allEntries.some((entry) => entry.scope?.startsWith("attr.media.")),
    ).toBe(false);
  });

  it("exercises the real 20-row page boundary on every surface", () => {
    for (const surface of SURFACES) {
      const firstPage = list(surface, { page: 1, limit: 20 });
      const secondPage = list(surface, { page: 2, limit: 20 });

      expect(firstPage.total).toBe(21);
      expect(firstPage.items).toHaveLength(20);
      expect(firstPage.has_more).toBe(true);
      expect(secondPage.items).toHaveLength(1);
      expect(secondPage.has_more).toBe(false);
    }
  });

  it("searches visible, metadata, and nested lifecycle fields", () => {
    expect(list("pending", { q: "portfolio" }).total).toBeGreaterThan(1);
    expect(list("active", { q: "location" }).total).toBeGreaterThanOrEqual(4);
    expect(
      list("previous", { q: "nested-history-read-request" }).items,
    ).toHaveLength(1);
    expect(
      list("pending", {
        q: "Comprehensive Multi-Institution Financial Decision",
      }).items,
    ).toHaveLength(1);
    expect(list("active", { q: "does-not-exist" }).items).toHaveLength(0);
  });

  it("moves preview rows through allow, deny, and revoke states", () => {
    const request = list("pending").items[0];
    const deniedRequest = list("pending").items[1];
    const active = list("active").items[0];

    applyLocalConsentPreviewMutation({
      action: "approve",
      entry: request,
      durationHours: 168,
    });
    applyLocalConsentPreviewMutation({
      action: "deny",
      entry: deniedRequest,
    });
    applyLocalConsentPreviewMutation({
      action: "revoke",
      entry: active,
    });

    expect(getLocalConsentPreviewSummary(USER_ID).counts).toEqual({
      pending: 19,
      active: 21,
      previous: 23,
    });
    expect(
      list("active").items.some(
        (entry) =>
          entry.request_id === request.request_id &&
          entry.status === "active" &&
          Date.parse(String(entry.expires_at)) -
            Date.parse(String(entry.issued_at)) ===
            168 * 60 * 60 * 1000,
      ),
    ).toBe(true);
    expect(
      list("previous").items.some(
        (entry) =>
          entry.request_id === deniedRequest.request_id &&
          entry.status === "denied",
      ),
    ).toBe(true);
    expect(
      list("previous").items.some(
        (entry) => entry.id === active.id && entry.status === "revoked",
      ),
    ).toBe(true);
  });

  it("supports the revoke CTA on an active trail inside grouped History", () => {
    const scope = "attr.financial.profile.risk_tolerance";
    revokeLocalConsentPreviewScope(scope);

    const grouped = list("previous").items.find(
      (entry) => entry.metadata?.fixture_type === "grouped_ria_history",
    );
    const trail = grouped?.consent_trails?.find(
      (item) => item.scope === scope,
    );

    expect(trail?.status).toBe("revoked");
    expect(trail?.events?.at(-1)?.action).toBe("REVOKED");
  });
});
