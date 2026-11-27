// @vitest-environment node
import { beforeEach, expect, it, vi } from "vitest";
import { canonicalConsentExportAad, canonicalConsentExportJson } from "@/lib/consent/export-envelope-v2";
import { decryptExport, unwrapExportKeyForConnector } from "@/lib/vault/export-encrypt";
import { connectorKeyFingerprint } from "@/lib/consent/export-envelope-v2";
import type { WebsiteCredentialItemV1 } from "@/lib/pkm/website-credential";

const { load, approve, active } = vi.hoisted(() => ({ load: vi.fn(), approve: vi.fn(), active: { current: true, userId: "" } }));
vi.mock("@/lib/services/api-service", () => ({ ApiService: { approvePendingConsent: approve } }));
vi.mock("@/lib/services/personal-knowledge-model-service", () => ({ PersonalKnowledgeModelService: { loadDomainSnapshot: load } }));
vi.mock("@/lib/auth/session-owner", () => ({ snapshotValidatedAuthSessionOwner: () => ({ userId: active.userId }), isValidatedAuthSessionOwnerCurrent: () => active.current }));
vi.mock("@/lib/vault/session-epoch", () => ({ snapshotVaultSessionEpoch: () => 1, isVaultSessionEpochCurrent: () => active.current }));
import { approveCredentialShare, type CredentialShareReview } from "@/lib/services/credential-sharing-service";

const context = { userId: "synthetic-owner", vaultKey: "11".repeat(32), vaultOwnerToken: "synthetic-owner-token" };
const id = "sec_" + "a".repeat(16);
const item: WebsiteCredentialItemV1 = {
  schema_version: 1, label: "Synthetic website", kind: "credential", pattern_id: "website_credential",
  file_to: "none", offer_noun: null, value: "SYNTHETIC_SELECTED_PASSWORD", created_at: "2026-11-26T00:00:00.000Z",
  updated_at: "2026-11-26T00:00:00.000Z", revision: 1, bound_origins: ["https://example.com"], stay_signed_in_enabled: false,
  credential: { title: "Synthetic website", origin: "https://example.com", domain: "example.com", url: "https://example.com/login", username: "synthetic-user" },
};
const source = { snapshot: { contentRevision: 3, manifestRevision: 2 }, data: {
  items: { [id]: item, ["sec_" + "b".repeat(16)]: { value: "UNSELECTED_SECRET" } },
} };
let privateKey: string;
let review: CredentialShareReview;

beforeEach(async () => {
  active.current = true; active.userId = context.userId;
  load.mockReset().mockResolvedValue(source);
  approve.mockReset().mockResolvedValue({ ok: true });
  const pair = await crypto.subtle.generateKey("X25519", true, ["deriveBits"]) as CryptoKeyPair;
  const publicKey = Buffer.from(await crypto.subtle.exportKey("raw", pair.publicKey)).toString("base64");
  privateKey = Buffer.from(await crypto.subtle.exportKey("pkcs8", pair.privateKey)).toString("base64");
  const fingerprint = await connectorKeyFingerprint(publicKey);
  review = { request_id: "owneritem_synthetic", scope: `attr.secrets.items.${id}`, scope_handle: "s_selected_item",
    recipient_key_fingerprint: fingerprint, duration_hours: 24,
    recipient: { app_id: "registered-app", agent_id: "developer:registered-app", key_id: "key", public_key: publicKey, fingerprint, label: "Synthetic recipient" },
    credentialId: id, branch: "items", contentRevision: 3, manifestRevision: 2 };
});

it("seals only the reviewed canonical Secrets item for the registered recipient", async () => {
  expect(await approveCredentialShare(context, review)).toBe(review.request_id);
  expect(load).toHaveBeenCalledWith(expect.objectContaining({ userId: context.userId, domain: "secrets", force: true }));
  const sent = approve.mock.calls[0]![0];
  expect(sent.modelProcessingAllowed).toBe(false);
  expect(sent.exportEnvelope.aad).toMatchObject({ machine_scope: review.scope, app_id: review.recipient.app_id, grant_id: review.request_id });
  expect(JSON.stringify(sent)).not.toContain(item.value);
  expect(JSON.stringify(sent)).not.toContain("UNSELECTED_SECRET");
  const key = await unwrapExportKeyForConnector({ bundle: sent, connectorPrivateKey: privateKey, connectorKeyId: "key",
    additionalData: canonicalConsentExportJson(sent.exportEnvelope) });
  const data = JSON.parse(await decryptExport(sent.encryptedData, sent.encryptedIv, sent.encryptedTag, Buffer.from(key).toString("hex"),
    { additionalData: canonicalConsentExportAad(sent.exportEnvelope.aad) }));
  key.fill(0);
  expect(data.secrets).toEqual({ items: { [id]: item } });
  expect(data).not.toHaveProperty("credentials");
  expect(data.__export_metadata).toMatchObject({ scope: review.scope, source_domain: "secrets", approved_paths: [`items.${id}`], manifest_version: 2 });
});

it.each(["summary", "secrets"])("refuses the retired credentials %s scope before reading or approving", async branch => {
  review.scope = `attr.credentials.${branch}.${id}`;
  await expect(approveCredentialShare(context, review)).rejects.toMatchObject({ code: "CREDENTIAL_GRANT_INVALID" });
  expect(load).not.toHaveBeenCalled();
  expect(approve).not.toHaveBeenCalled();
});

it("rejects stale source, recipient changes and retired owner sessions before approval", async () => {
  review.contentRevision = 2;
  await expect(approveCredentialShare(context, review)).rejects.toMatchObject({ code: "CREDENTIAL_REVISION_STALE" });
  review.contentRevision = 3; review.recipient_key_fingerprint = "sha256:" + "0".repeat(64);
  await expect(approveCredentialShare(context, review)).rejects.toMatchObject({ code: "CREDENTIAL_RECIPIENT_CHANGED" });
  active.current = false;
  await expect(approveCredentialShare(context, review)).rejects.toMatchObject({ code: "CREDENTIAL_OWNER_RETIRED" });
  expect(approve).not.toHaveBeenCalled();
});

it("refuses a deleted selected item and does not report a revoked approval as successful", async () => {
  load.mockResolvedValueOnce({ ...source, data: { items: {} } });
  await expect(approveCredentialShare(context, review)).rejects.toMatchObject({ code: "CREDENTIAL_UNAVAILABLE" });
  expect(approve).not.toHaveBeenCalled();
  approve.mockResolvedValueOnce({ ok: false });
  await expect(approveCredentialShare(context, review)).rejects.toMatchObject({ code: "CREDENTIAL_GRANT_UNAVAILABLE" });
  expect(approve).toHaveBeenCalledOnce();
});
