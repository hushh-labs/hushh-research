// Locks down the wire→envelope mapping in `ConnectionsService.listReceivedExports`.
//
// The requester never re-derives the AAD from scratch — it recomputes the two
// canonical strings the data-owner bound at wrap time and hands them to the
// on-device AES-GCM unwrap. If either string drifts from what the owner used,
// GCM auth fails and every received scope becomes silently un-openable. So the
// contract under test is byte-exact:
//   • keyAdditionalData  === canonicalConsentExportJson(export_envelope)   (full v2 submission)
//   • dataAdditionalData === canonicalConsentExportAad(export_envelope.aad) (AAD object alone)
// plus: canonicalization is key-order independent, integers stay integers,
// and rows missing any unwrap input are dropped rather than surfaced broken.
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  canonicalConsentExportAad,
  canonicalConsentExportJson,
  type ConsentExportAadV2,
} from "@/lib/consent/export-envelope-v2";

const mocks = vi.hoisted(() => ({ apiFetch: vi.fn() }));

vi.mock("@/lib/services/api-service", () => ({
  ApiService: { apiFetch: mocks.apiFetch },
}));

// Imported after the mock is registered so the service binds to the mocked fetch.
import { ConnectionsService } from "@/lib/services/connections-service";

function fakeResponse(body: unknown, ok = true): Response {
  return {
    ok,
    status: ok ? 200 : 500,
    json: async () => body,
  } as unknown as Response;
}

// A well-formed AAD object with keys deliberately NOT in sorted order, so the
// test proves canonicalization sorts rather than passing the wire order through.
const AAD: ConsentExportAadV2 = {
  version: 2,
  scope_handle: "sh_abc",
  app_id: "connection:me-user",
  grant_id: "grant-1",
  export_id: "exp-1",
  revision: 3,
  machine_scope: "attr.financial.portfolio.net_worth",
  recipient_key_fingerprint: "sha256:deadbeef",
  payload_algorithm: "AES-256-GCM",
  expires_at_ms: 1893456000000,
};

// The full v2 submission the backend echoes back in `export_envelope`, again
// with scrambled key order.
const EXPORT_ENVELOPE = {
  ciphertext_bytes: 42,
  version: 2,
  aad: AAD,
  export_id: "exp-1",
  aad_sha256: "sha256:aaa",
  ciphertext_sha256: "sha256:ccc",
};

function validRawRow() {
  return {
    granter_user_id: "granter-1",
    granter_display_name: "Ada Lovelace",
    scope: "attr.financial.portfolio.net_worth",
    scope_handle: "sh_abc",
    grant_id: "grant-1",
    export_revision: 3,
    export_generated_at: "2026-07-30T10:00:00Z",
    expires_at: "2026-12-31T00:00:00Z",
    encrypted_data: "ZW5jcnlwdGVk",
    iv: "aXY=",
    tag: "dGFn",
    wrapped_key_bundle: {
      wrapped_export_key: "d3JhcHBlZA==",
      wrapped_key_iv: "d2tpdg==",
      wrapped_key_tag: "d2t0YWc=",
      sender_public_key: "c3Br",
      wrapping_alg: "X25519-AES-256-GCM",
      connector_key_id: "connect-req-abc123",
    },
    export_envelope: EXPORT_ENVELOPE,
  };
}

describe("ConnectionsService.listReceivedExports", () => {
  beforeEach(() => {
    mocks.apiFetch.mockReset();
  });

  it("maps a wire row to a decryption-ready envelope with byte-exact AAD", async () => {
    mocks.apiFetch.mockResolvedValue(fakeResponse({ items: [validRawRow()] }));

    const [item] = await ConnectionsService.listReceivedExports({ idToken: "tok" });

    // camelCase display mapping.
    expect(item.granterUserId).toBe("granter-1");
    expect(item.granterDisplayName).toBe("Ada Lovelace");
    expect(item.scope).toBe("attr.financial.portfolio.net_worth");
    expect(item.grantId).toBe("grant-1");
    expect(item.exportRevision).toBe(3);

    // Envelope carries the raw crypto material straight through.
    expect(item.envelope.wrappedExportKey).toBe("d3JhcHBlZA==");
    expect(item.envelope.senderPublicKey).toBe("c3Br");
    expect(item.envelope.wrappingAlg).toBe("X25519-AES-256-GCM");
    expect(item.envelope.connectorKeyId).toBe("connect-req-abc123");
    expect(item.envelope.ciphertext).toBe("ZW5jcnlwdGVk");

    // THE contract: both AAD strings match the canonicalizers exactly.
    expect(item.envelope.keyAdditionalData).toBe(
      canonicalConsentExportJson(EXPORT_ENVELOPE),
    );
    expect(item.envelope.dataAdditionalData).toBe(
      canonicalConsentExportAad(AAD),
    );
  });

  it("canonicalizes (sorts keys) rather than echoing wire byte order", async () => {
    mocks.apiFetch.mockResolvedValue(fakeResponse({ items: [validRawRow()] }));

    const [item] = await ConnectionsService.listReceivedExports({ idToken: "tok" });

    // The wire objects have scrambled key order; a naive JSON.stringify of them
    // would NOT equal the bound AAD. Canonicalization must have reordered.
    expect(item.envelope.keyAdditionalData).not.toBe(
      JSON.stringify(EXPORT_ENVELOPE),
    );
    expect(item.envelope.dataAdditionalData).not.toBe(JSON.stringify(AAD));
    // And the canonical form is stably sorted (app_id precedes version).
    expect(item.envelope.dataAdditionalData.indexOf('"app_id"')).toBeLessThan(
      item.envelope.dataAdditionalData.indexOf('"version"'),
    );
  });

  it("keeps integer fields as JSON numbers (GCM auth is type-sensitive)", async () => {
    mocks.apiFetch.mockResolvedValue(fakeResponse({ items: [validRawRow()] }));

    const [item] = await ConnectionsService.listReceivedExports({ idToken: "tok" });

    // Numbers, not quoted strings — a stringified int would break the owner's tag.
    expect(item.envelope.dataAdditionalData).toContain('"version":2');
    expect(item.envelope.dataAdditionalData).toContain('"expires_at_ms":1893456000000');
    expect(item.envelope.dataAdditionalData).toContain('"revision":3');
    expect(item.envelope.keyAdditionalData).toContain('"ciphertext_bytes":42');
  });

  it.each([
    ["wrapped_export_key", (r: ReturnType<typeof validRawRow>) => { r.wrapped_key_bundle.wrapped_export_key = ""; }],
    ["wrapped_key_iv", (r: ReturnType<typeof validRawRow>) => { r.wrapped_key_bundle.wrapped_key_iv = ""; }],
    ["wrapped_key_tag", (r: ReturnType<typeof validRawRow>) => { r.wrapped_key_bundle.wrapped_key_tag = ""; }],
    ["sender_public_key", (r: ReturnType<typeof validRawRow>) => { r.wrapped_key_bundle.sender_public_key = ""; }],
    ["encrypted_data", (r: ReturnType<typeof validRawRow>) => { r.encrypted_data = ""; }],
    ["iv", (r: ReturnType<typeof validRawRow>) => { r.iv = ""; }],
    ["tag", (r: ReturnType<typeof validRawRow>) => { r.tag = ""; }],
  ])("drops a row missing %s (undecryptable)", async (_label, mutate) => {
    const row = validRawRow();
    mutate(row);
    mocks.apiFetch.mockResolvedValue(fakeResponse({ items: [row] }));

    const result = await ConnectionsService.listReceivedExports({ idToken: "tok" });
    expect(result).toHaveLength(0);
  });

  it("drops a row whose envelope has no aad", async () => {
    const row = validRawRow() as Record<string, unknown>;
    row.export_envelope = { ...EXPORT_ENVELOPE, aad: null };
    mocks.apiFetch.mockResolvedValue(fakeResponse({ items: [row] }));

    const result = await ConnectionsService.listReceivedExports({ idToken: "tok" });
    expect(result).toHaveLength(0);
  });

  it("keeps decryptable rows and drops undecryptable ones in a mixed batch", async () => {
    const good = validRawRow();
    const bad = validRawRow();
    bad.wrapped_key_bundle.wrapped_export_key = "";
    mocks.apiFetch.mockResolvedValue(fakeResponse({ items: [good, bad] }));

    const result = await ConnectionsService.listReceivedExports({ idToken: "tok" });
    expect(result).toHaveLength(1);
    expect(result[0].grantId).toBe("grant-1");
  });

  it("returns an empty list when the API omits items", async () => {
    mocks.apiFetch.mockResolvedValue(fakeResponse({}));
    const result = await ConnectionsService.listReceivedExports({ idToken: "tok" });
    expect(result).toEqual([]);
  });

  it("sends the bearer token to the received-exports endpoint", async () => {
    mocks.apiFetch.mockResolvedValue(fakeResponse({ items: [] }));
    await ConnectionsService.listReceivedExports({ idToken: "tok-xyz" });

    expect(mocks.apiFetch).toHaveBeenCalledWith(
      "/api/one/connections/received-exports",
      expect.objectContaining({
        method: "GET",
        headers: expect.objectContaining({ Authorization: "Bearer tok-xyz" }),
      }),
    );
  });

  it("throws the server error message on a non-ok response", async () => {
    mocks.apiFetch.mockResolvedValue(fakeResponse({ error: "nope" }, false));
    await expect(
      ConnectionsService.listReceivedExports({ idToken: "tok" }),
    ).rejects.toThrow("nope");
  });
});

describe("ConnectionsService.listRequestableScopes", () => {
  beforeEach(() => {
    mocks.apiFetch.mockReset();
  });

  it("passes through bundles and scopes from the catalog", async () => {
    mocks.apiFetch.mockResolvedValue(
      fakeResponse({
        bundles: [
          { id: "finance", label: "Finance", description: "", icon_name: null, color_hex: null, scopes: ["a", "b"] },
        ],
        scopes: [
          { scope: "a", label: "Net worth", description: null, icon_name: null, color_hex: null, sensitivity: "high" },
        ],
      }),
    );

    const catalog = await ConnectionsService.listRequestableScopes({ idToken: "tok" });
    expect(catalog.bundles).toHaveLength(1);
    expect(catalog.bundles[0].scopes).toEqual(["a", "b"]);
    expect(catalog.scopes[0].scope).toBe("a");
    expect(catalog.scopes[0].sensitivity).toBe("high");
  });

  it("defaults missing arrays to empty (presence-safe fallback)", async () => {
    mocks.apiFetch.mockResolvedValue(fakeResponse({}));
    const catalog = await ConnectionsService.listRequestableScopes({ idToken: "tok" });
    expect(catalog).toEqual({ bundles: [], scopes: [] });
  });
});
