import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockApiFetch } = vi.hoisted(() => ({
  mockApiFetch: vi.fn(),
}));

vi.mock("@/lib/services/api-service", () => ({
  ApiService: { apiFetch: mockApiFetch },
}));

// Cache mocks — keeps each test hermetic; listEntries hits the cache path.
vi.mock("@/lib/services/cache-service", () => ({
  CacheService: {
    getInstance: vi.fn(() => ({ get: vi.fn(() => undefined), set: vi.fn() })),
  },
  CACHE_KEYS: {
    CONSENT_CENTER_LIST:    (...a: unknown[]) => `list:${a.join(":")}`,
    CONSENT_CENTER_PREVIEW: (...a: unknown[]) => `preview:${a.join(":")}`,
    CONSENT_CENTER:         (...a: unknown[]) => `center:${a.join(":")}`,
    CONSENT_CENTER_SUMMARY: (...a: unknown[]) => `summary:${a.join(":")}`,
  },
  CACHE_TTL: { SHORT: 60_000 },
}));

vi.mock("@/lib/cache/cache-sync-service", () => ({
  CacheSyncService: { onConsentMutated: vi.fn() },
}));

import { ConsentCenterService } from "@/lib/services/consent-center-service";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("ConsentCenterService.lookupPendingRequests", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("resolves canonical pending consent requests by request id", async () => {
    mockApiFetch.mockResolvedValueOnce(
      jsonResponse({
        items: [
          {
            request_id: "req_email_scope",
            requester_label: "One",
            scope: "attr.travel.preferences.seat.*",
            metadata: {
              request_source: "one_email_kyc_v1",
              connector_public_key: "public-key",
            },
          },
        ],
        missing_request_ids: ["missing_scope"],
      }),
    );

    const result = await ConsentCenterService.lookupPendingRequests({
      vaultOwnerToken: "vault-token",
      userId: "user-1",
      requestIds: ["req_email_scope", " ", "req_email_scope", "missing_scope"],
    });

    expect(result.items).toHaveLength(1);
    expect(result.items[0]?.scope).toBe("attr.travel.preferences.seat.*");
    expect(result.missing_request_ids).toEqual(["missing_scope"]);
    expect(mockApiFetch).toHaveBeenCalledWith(
      "/api/consent/pending/lookup?userId=user-1&request_id=req_email_scope&request_id=missing_scope",
      expect.objectContaining({
        method: "GET",
        headers: {
          Authorization: "Bearer vault-token",
        },
      }),
    );
  });

  it("does not call the API when no request ids are present", async () => {
    const result = await ConsentCenterService.lookupPendingRequests({
      vaultOwnerToken: "vault-token",
      userId: "user-1",
      requestIds: ["", "  "],
    });

    expect(result).toEqual({ items: [], missing_request_ids: [] });
    expect(mockApiFetch).not.toHaveBeenCalled();
  });
});

// ── Override-precedence proof ─────────────────────────────────────────────────
// Uses listEntries because it pipes every item through normalizeConsentEntry.

function listResponse(items: unknown[]): Response {
  return jsonResponse({
    user_id: "u-1", actor: "investor", mode: "consents",
    surface: "active", query: "", page: 1, limit: 20,
    total: items.length, has_more: false, items,
  });
}

describe("normalizeConsentEntry — local-override precedence matrix", () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it("active: false overrides granted: true — system path never promotes status", async () => {
    // Without the override matrix normalizeConsentResponse({ active: false,
    // granted: true }) returns { isGranted: true }, which promotes status to
    // "approved".  The override matrix must short-circuit that path.
    mockApiFetch.mockResolvedValueOnce(
      listResponse([{
        id: "e1", kind: "incoming_request", status: "pending",
        active: false, granted: true,   // explicit revocation vs system grant
        action: "deny", counterpart_type: "ria",
      }]),
    );

    const { items } = await ConsentCenterService.listEntries({
      idToken: "tok", userId: "u-1", surface: "active",
    });

    expect(items[0]!.active).toBe(false);
    expect(items[0]!.status).toBe("pending");   // NOT promoted to "approved"
  });

  it("active: true on active_grant promotes status to 'active' immediately", async () => {
    mockApiFetch.mockResolvedValueOnce(
      listResponse([{
        id: "e2", kind: "active_grant", status: "pending",
        active: true,
        action: "approve", counterpart_type: "ria",
      }]),
    );

    const { items } = await ConsentCenterService.listEntries({
      idToken: "tok", userId: "u-1", surface: "active",
    });

    expect(items[0]!.active).toBe(true);
    expect(items[0]!.status).toBe("active");    // promoted via override, not normalization
  });

  it("active: true on non-grant entry promotes status to 'approved'", async () => {
    mockApiFetch.mockResolvedValueOnce(
      listResponse([{
        id: "e3", kind: "incoming_request", status: "pending",
        active: true,
        action: "approve", counterpart_type: "ria",
      }]),
    );

    const { items } = await ConsentCenterService.listEntries({
      idToken: "tok", userId: "u-1", surface: "active",
    });

    expect(items[0]!.status).toBe("approved");
  });

  it("active: true preserves already-canonical status unchanged", async () => {
    mockApiFetch.mockResolvedValueOnce(
      listResponse([{
        id: "e4", kind: "active_grant", status: "granted",
        active: true,
        action: "approve", counterpart_type: "ria",
      }]),
    );

    const { items } = await ConsentCenterService.listEntries({
      idToken: "tok", userId: "u-1", surface: "active",
    });

    expect(items[0]!.status).toBe("granted");   // already canonical — unchanged
  });

  it("active: undefined falls through to existing normalizeConsentResponse path without promotion", async () => {
    // When active is absent the override matrix is skipped entirely and
    // normalizeConsentEntry calls normalizeConsentResponse with
    // { active: undefined, ... } as an own-property object.  The integrity
    // guard inside normalizeConsentResponse fires because
    //   own("active") && typeof undefined !== "boolean"
    // evaluates to true, returning DENY_STATE (isGranted: false).
    // The entry is returned unchanged — status stays "pending".
    mockApiFetch.mockResolvedValueOnce(
      listResponse([{
        id: "e5", kind: "active_grant", status: "pending",
        granted: true,                // no active field — falls through
        action: "approve", counterpart_type: "ria",
      }]),
    );

    const { items } = await ConsentCenterService.listEntries({
      idToken: "tok", userId: "u-1", surface: "active",
    });

    // The integrity guard in normalizeConsentResponse rejects the
    // { active: undefined } own-property shape, so isGranted stays false
    // and the status is NOT promoted.  This is the current contract.
    expect(items[0]!.status).toBe("pending");
  });
});
// ── End override-precedence proof ─────────────────────────────────────────────
