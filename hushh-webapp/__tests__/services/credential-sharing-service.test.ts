// @vitest-environment node
import { beforeEach, expect, it, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { canonicalConsentExportAad, canonicalConsentExportJson } from "@/lib/consent/export-envelope-v2";
import { decryptExport, unwrapExportKeyForConnector } from "@/lib/vault/export-encrypt";
import { connectorKeyFingerprint } from "@/lib/consent/export-envelope-v2";

const { load, approve, active } = vi.hoisted(() => ({ load: vi.fn(), approve: vi.fn(), active: { current: true, userId: "" } }));
vi.mock("@/lib/services/api-service", () => ({ ApiService: { approvePendingConsent: approve } }));
vi.mock("@/lib/services/personal-knowledge-model-service", () => ({ PersonalKnowledgeModelService: { loadDomainSnapshot: load } }));
vi.mock("@/lib/auth/session-owner", () => ({ snapshotValidatedAuthSessionOwner: () => ({ userId: active.userId }), isValidatedAuthSessionOwnerCurrent: () => active.current }));
vi.mock("@/lib/vault/session-epoch", () => ({ snapshotVaultSessionEpoch: () => 1, isVaultSessionEpochCurrent: () => active.current }));
import { approveCredentialShare, type CredentialShareReview } from "@/lib/services/credential-sharing-service";

const vector = JSON.parse(fs.readFileSync(path.resolve(process.cwd(), "..", "consent-protocol", "tests", "fixtures", "website_credential_vector_v1.json"), "utf8"));
const context = { userId: vector.record.aad.ownerId, vaultKey: vector.ownerVaultKeyHex, vaultOwnerToken: "synthetic-owner" };
const id = vector.record.aad.credentialId;
const summary = { id, label: "Synthetic website", boundOrigins: ["https://example.com"] };
let privateKey: string;
let review: CredentialShareReview;

beforeEach(async () => {
  active.current = true; active.userId = context.userId;
  load.mockReset().mockResolvedValue({ snapshot: { contentRevision: 3, manifestRevision: 2 }, data: {
    summary: { [id]: summary }, secrets: { [id]: vector.record, sibling: { password: "UNSELECTED_SECRET" } },
  } });
  approve.mockReset().mockResolvedValue({ ok: true });
  const pair = await crypto.subtle.generateKey("X25519", true, ["deriveBits"]) as CryptoKeyPair;
  const publicKey = Buffer.from(await crypto.subtle.exportKey("raw", pair.publicKey)).toString("base64");
  privateKey = Buffer.from(await crypto.subtle.exportKey("pkcs8", pair.privateKey)).toString("base64");
  const fingerprint = await connectorKeyFingerprint(publicKey);
  review = { request_id: "owneritem_synthetic", scope: `attr.credentials.secrets.${id}`, scope_handle: "s_selected_item",
    recipient_key_fingerprint: fingerprint, duration_hours: 24,
    recipient: { app_id: "registered-app", agent_id: "developer:registered-app", key_id: "key", public_key: publicKey, fingerprint, label: "Synthetic recipient" },
    credentialId: id, branch: "secrets", contentRevision: 3, manifestRevision: 2 };
});

it.each(["summary", "secrets"] as const)("seals only the reviewed %s item for the registered recipient", async branch => {
  review.branch = branch; review.scope = `attr.credentials.${branch}.${id}`;
  expect(await approveCredentialShare(context, review)).toBe(review.request_id);
  const sent = approve.mock.calls[0]![0];
  expect(sent.modelProcessingAllowed).toBe(false);
  expect(sent.exportEnvelope.aad).toMatchObject({ machine_scope: review.scope, app_id: review.recipient.app_id, grant_id: review.request_id });
  expect(JSON.stringify(sent)).not.toContain(vector.expectedPayload.password);
  expect(JSON.stringify(sent)).not.toContain("UNSELECTED_SECRET");
  const key = await unwrapExportKeyForConnector({ bundle: sent, connectorPrivateKey: privateKey, connectorKeyId: "key",
    additionalData: canonicalConsentExportJson(sent.exportEnvelope) });
  const data = JSON.parse(await decryptExport(sent.encryptedData, sent.encryptedIv, sent.encryptedTag, Buffer.from(key).toString("hex"),
    { additionalData: canonicalConsentExportAad(sent.exportEnvelope.aad) }));
  key.fill(0);
  expect(data.credentials).toEqual({ [branch]: { [id]: branch === "summary" ? summary : vector.expectedPayload } });
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
