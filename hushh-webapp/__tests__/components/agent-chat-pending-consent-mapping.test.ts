import { beforeEach, describe, expect, it, vi } from "vitest";

const lookupPendingRequests = vi.fn();

vi.mock("@/lib/services/consent-center-service", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/services/consent-center-service")>();
  return {
    ...actual,
    ConsentCenterService: {
      ...actual.ConsentCenterService,
      lookupPendingRequests: (...args: unknown[]) => lookupPendingRequests(...args),
    },
  };
});

import {
  getPendingConsentRequestPayload,
  pendingConsentCardItemToPendingConsent,
  pendingConsentCardRequestIds,
  pendingConsentLookupItemToCardItem,
  resolvePendingConsentCardTargets,
} from "@/components/agent/agent-chat-workspace";
import type { SpecialistDirectiveEvent } from "@/lib/services/agent-chat-client";
import type { PendingConsentLookupItem } from "@/lib/services/consent-center-service";

/**
 * Approving from chat wraps the vault key to the requester's public key, which
 * only travels in the request's metadata. The key crosses three hops before
 * `handleApprove` reads it: lookup item -> card item -> the untyped directive
 * payload the message stores -> the card item re-parsed on render -> the
 * PendingConsent the hook receives. The first attempt at this fix repaired the
 * mappers on either end and left the parser in the middle rebuilding the item
 * from a whitelist without metadata, so the backend still refused the approval
 * as missing its wrapped key. These tests walk every hop.
 */
const lookupItem: PendingConsentLookupItem = {
  request_id: "req_123",
  requester_label: "Sharu",
  scope: "finance.income",
  scope_description: "Income",
  issued_at: 1_700_000_000_000,
  poll_timeout_at: 1_700_000_600_000,
  bundle_id: "bundle_9",
  bundle_label: "Budget planning",
  bundle_scope_count: 2,
  metadata: {
    connector_public_key: "pk_test_base64",
    expiry_hours: 168,
  },
};

function embed(
  item: NonNullable<ReturnType<typeof pendingConsentLookupItemToCardItem>>,
): SpecialistDirectiveEvent {
  // Mirrors how the workspace stores a pending request on a message.
  return {
    delegateAgentId: "agent_nav",
    directive: {
      kind: "prompt",
      payload: { kind: "pending_consent_request", item },
    },
    message: `${item.requesterLabel} is asking for access.`,
    stateChanged: true,
  };
}

describe("pending consent card mapping", () => {
  it("carries metadata and the expiry from the lookup item onto the card", () => {
    const card = pendingConsentLookupItemToCardItem(lookupItem);
    expect(card).not.toBeNull();
    expect(card?.metadata).toEqual(lookupItem.metadata);
    expect(card?.expiryHours).toBe(168);
    expect(card?.bundleId).toBe("bundle_9");
  });

  it("hands handleApprove the public key and the bundle it needs", () => {
    const card = pendingConsentLookupItemToCardItem(lookupItem);
    expect(card).not.toBeNull();
    const consent = pendingConsentCardItemToPendingConsent(card!);
    expect(consent.id).toBe("req_123");
    expect(consent.metadata?.connector_public_key).toBe("pk_test_base64");
    expect(consent.expiryHours).toBe(168);
    expect(consent.bundleId).toBe("bundle_9");
  });

  it("survives the round trip through the stored directive payload", () => {
    const card = pendingConsentLookupItemToCardItem(lookupItem)!;
    const reparsed = getPendingConsentRequestPayload(embed(card));
    expect(reparsed).not.toBeNull();
    const item = reparsed!.item;

    // The key and the expiry the approve handler depends on.
    expect(item.metadata).toEqual(lookupItem.metadata);
    expect(item.expiryHours).toBe(168);

    // The whole chain, ending where the hook reads the key.
    const consent = pendingConsentCardItemToPendingConsent(item);
    expect(consent.metadata?.connector_public_key).toBe("pk_test_base64");
    expect(consent.expiryHours).toBe(168);
  });

  it("preserves sanitized bundle descriptors through the stored payload", () => {
    // Restored cards need their safe bundle descriptors so one consent ask
    // remains one coherent card after history hydration. Approval still
    // revalidates every request against live authority; these descriptors do
    // not grant access on their own.
    const first = pendingConsentLookupItemToCardItem(lookupItem)!;
    const second = pendingConsentLookupItemToCardItem({
      ...lookupItem,
      request_id: "req_456",
      scope: "finance.assets",
      scope_description: "Assets",
    })!;
    expect(first.bundleId).toBe("bundle_9");
    expect(second.bundleId).toBe("bundle_9");

    const stored = getPendingConsentRequestPayload(embed(first))!.item;
    expect(stored.bundleId).toBe("bundle_9");
    expect(stored.bundleLabel).toBe("Budget planning");
    expect(stored.bundleScopeCount).toBe(2);
    expect(stored.bundledRequestIds).toEqual(["req_123"]);
    expect(stored.bundledScopes).toHaveLength(1);
    expect(stored.bundleId === second.bundleId).toBe(true);

    // A single-request card still decides only for its own request.
    expect(pendingConsentCardRequestIds(stored)).toEqual(["req_123"]);
    const storedSecond = getPendingConsentRequestPayload(embed(second))!.item;
    expect(pendingConsentCardRequestIds(storedSecond)).toEqual(["req_456"]);
  });

  it("does not invent metadata when the wire carried none", () => {
    const card = pendingConsentLookupItemToCardItem({
      ...lookupItem,
      metadata: undefined,
      bundle_id: null,
    });
    expect(card?.metadata).toBeNull();
    expect(card?.expiryHours).toBeNull();
    const reparsed = getPendingConsentRequestPayload(embed(card!));
    expect(reparsed?.item.metadata).toBeNull();
    expect(reparsed?.item.bundleId).toBeNull();
    const consent = pendingConsentCardItemToPendingConsent(reparsed!.item);
    expect(consent.metadata).toBeNull();
    expect(consent.bundleId).toBeUndefined();
    expect(consent.expiryHours).toBeUndefined();
  });

  it("ignores a malformed metadata value rather than passing it on", () => {
    for (const malformed of ["oops", ["pk_in_an_array"], 42]) {
      const card = pendingConsentLookupItemToCardItem(lookupItem)!;
      const event = embed(card);
      (event.directive.payload.item as Record<string, unknown>).metadata = malformed;
      const reparsed = getPendingConsentRequestPayload(event);
      expect(reparsed?.item.metadata, JSON.stringify(malformed)).toBeNull();
    }
  });
});

/**
 * The resolver the card handlers go through. Today every stored card is a
 * single request (the parser keeps the fold inert, see above), so the live
 * path is the no-lookup branch. The folded-card cases pin the contract a
 * folded card must honour once handleApproveBundle is wired: Approve and Deny
 * answer every request in it, each with its own key, and only those still
 * pending.
 */
describe("pending consent card targets", () => {
  const second: PendingConsentLookupItem = {
    ...lookupItem,
    request_id: "req_456",
    scope: "finance.assets",
    scope_description: "Assets",
    metadata: { connector_public_key: "pk_second", expiry_hours: 168 },
  };

  beforeEach(() => {
    lookupPendingRequests.mockReset();
  });

  it("lists the head request first and every folded request once", () => {
    const card = pendingConsentLookupItemToCardItem(lookupItem)!;
    expect(pendingConsentCardRequestIds(card)).toEqual(["req_123"]);
    expect(
      pendingConsentCardRequestIds({
        ...card,
        bundledRequestIds: ["req_123", "req_456", " ", "req_456"],
      }),
    ).toEqual(["req_123", "req_456"]);
  });

  it("revalidates a single-request card and uses fresh metadata", async () => {
    lookupPendingRequests.mockResolvedValue({ items: [{ ...lookupItem,
      metadata: { connector_public_key: "pk_fresh" } }], missing_request_ids: [] });
    const card = { ...pendingConsentLookupItemToCardItem(lookupItem)!, bundleId: null };
    const targets = await resolvePendingConsentCardTargets({
      userId: "user_1",
      vaultOwnerToken: "owner-token",
      item: card,
    });
    expect(lookupPendingRequests).toHaveBeenCalledWith({ userId: "user_1",
      vaultOwnerToken: "owner-token", requestIds: ["req_123"] });
    expect(targets.map((target) => target.id)).toEqual(["req_123"]);
    expect(targets[0]?.metadata?.connector_public_key).toBe("pk_fresh");
  });

  it("rejects a single-request lookup without owner authority", async () => {
    await expect(resolvePendingConsentCardTargets({ userId: "user_1", vaultOwnerToken: null,
      item: pendingConsentLookupItemToCardItem(lookupItem)! })).rejects.toThrow("Unlock");
    expect(lookupPendingRequests).not.toHaveBeenCalled();
  });

  it("returns no targets for a missing single request", async () => {
    lookupPendingRequests.mockResolvedValue({items: [], missing_request_ids: ["req_123"]});
    await expect(resolvePendingConsentCardTargets({ userId: "user_1", vaultOwnerToken: "owner-token",
      item: { ...pendingConsentLookupItemToCardItem(lookupItem)!, bundleId: null } })).resolves.toEqual([]);
  });

  it("propagates lookup failure without stale fallback", async () => {
    lookupPendingRequests.mockRejectedValue(new Error("Unavailable"));
    await expect(resolvePendingConsentCardTargets({ userId: "user_1", vaultOwnerToken: "owner-token",
      item: { ...pendingConsentLookupItemToCardItem(lookupItem)!, bundleId: null } })).rejects.toThrow("Unavailable");
  });

  it.each(["approved", "denied", "cancelled", "expired", "revoked", "unavailable"] as const)(
    "preserves %s status through payload parsing", status => {
      const card = {...pendingConsentLookupItemToCardItem(lookupItem)!, status};
      expect(getPendingConsentRequestPayload(embed(card))?.item.status).toBe(status);
    });

  it("resolves every folded request with its own key, in card order", async () => {
    lookupPendingRequests.mockResolvedValue({
      items: [second, lookupItem],
      missing_request_ids: [],
    });
    const folded = {
      ...pendingConsentLookupItemToCardItem(lookupItem)!,
      bundledRequestIds: ["req_123", "req_456"],
    };
    const targets = await resolvePendingConsentCardTargets({
      userId: "user_1",
      vaultOwnerToken: "vault-owner-token",
      item: folded,
    });
    expect(lookupPendingRequests).toHaveBeenCalledWith({
      userId: "user_1",
      vaultOwnerToken: "vault-owner-token",
      requestIds: ["req_123", "req_456"],
    });
    expect(targets.map((target) => target.id)).toEqual(["req_123", "req_456"]);
    expect(targets.map((target) => target.metadata?.connector_public_key)).toEqual([
      "pk_test_base64",
      "pk_second",
    ]);
  });

  it("does not decide a bundle from only the first arriving notification", async () => {
    const first = pendingConsentLookupItemToCardItem(lookupItem)!;
    await expect(resolvePendingConsentCardTargets({
      userId: "user_1", vaultOwnerToken: "owner-token", item: first,
    })).rejects.toThrow("still loading");
    expect(lookupPendingRequests).not.toHaveBeenCalled();
  });

  it("acts only on the requests still pending, so a retry is safe", async () => {
    // The head was already answered (say, on a retry after a partial failure);
    // only the second member is still waiting.
    lookupPendingRequests.mockResolvedValue({
      items: [second],
      missing_request_ids: ["req_123"],
    });
    const folded = {
      ...pendingConsentLookupItemToCardItem(lookupItem)!,
      bundledRequestIds: ["req_123", "req_456"],
    };
    const targets = await resolvePendingConsentCardTargets({
      userId: "user_1",
      vaultOwnerToken: "vault-owner-token",
      item: folded,
    });
    expect(targets.map((target) => target.id)).toEqual(["req_456"]);
  });

  it("refuses to look a folded card up without a vault owner token", async () => {
    const folded = {
      ...pendingConsentLookupItemToCardItem(lookupItem)!,
      bundledRequestIds: ["req_123", "req_456"],
    };
    await expect(
      resolvePendingConsentCardTargets({
        userId: "user_1",
        vaultOwnerToken: null,
        item: folded,
      }),
    ).rejects.toThrow();
    expect(lookupPendingRequests).not.toHaveBeenCalled();
  });
});
