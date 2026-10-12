import "fake-indexeddb/auto";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const transport = vi.hoisted(() => ({ apiFetch: vi.fn(), encrypt: vi.fn() }));
vi.mock("@capacitor/core", () => ({ Capacitor: { isNativePlatform: () => false } }));
vi.mock("@/lib/capacitor", () => ({ HushhPersonalKnowledgeModel: {}, HushhVault: { encryptData: transport.encrypt } }));
vi.mock("@/lib/services/api-service", () => ({ ApiService: transport }));
vi.mock("@/lib/firebase/config", () => ({ auth: { currentUser: null } }));

import { ensureMarketplaceRecipientKey, encryptSliceForRecipient, decryptMarketplaceEnvelope } from "@/lib/one-marketplace/encryption";
import { loadMarkdownMemory, clearMarkdownMemory, replaceMarkdownMemoryDocument } from "@/lib/pkm/markdown-memory";
import { buildMemoryDocument } from "@/lib/pkm/memory-document";
import { createConsentExportReadSession } from "@/lib/consent/export-builder";
import { buildAnswerPayload } from "@/lib/answers/answer-delivery-sweep";
import { PersonalKnowledgeModelService } from "@/lib/services/personal-knowledge-model-service";
import { SecureResourceCacheService } from "@/lib/services/secure-resource-cache-service";
import { CacheService } from "@/lib/services/cache-service";
import { encryptData, type EncryptedPayload } from "@/lib/vault/encrypt";
import { advanceVaultSessionEpoch } from "@/lib/vault/session-epoch";
import { bumpPkmInvalidationEpoch } from "@/lib/cache/pkm-invalidation-epoch";
import type { AnswerableWork } from "@/lib/services/answer-request-service";

const OWNER = "answer-read-owner";
const KEY = "ab".repeat(32);
const PARAMS = { userId: OWNER, vaultKey: KEY, vaultOwnerToken: "synthetic-owner-token" };
const NAME_SCOPE = "attr.identity.profile.name";
const AGE_SCOPE = "attr.identity.profile.age";

type StoredDomain = {
  domain: string;
  revision: number;
  manifestRevision: number;
  storageMode?: "domain" | "legacy_full_blob";
  segments: Record<string, EncryptedPayload>;
  paths: { json_path: string; path_type: string; exposure_eligibility: boolean; segment_id: string }[];
  scopes?: Record<string, unknown>[];
};

async function storedDomain(params: {
  domain?: string;
  data: Record<string, Record<string, unknown>>;
  approved: Record<string, string>;
  revision?: number;
  manifestRevision?: number;
  storageMode?: "domain" | "legacy_full_blob";
}): Promise<StoredDomain> {
  return {
    domain: params.domain ?? "identity",
    revision: params.revision ?? 7,
    manifestRevision: params.manifestRevision ?? 4,
    storageMode: params.storageMode,
    segments: Object.fromEntries(await Promise.all(Object.entries(params.data).map(async ([segment, data]) =>
      [segment, await encryptData(JSON.stringify(data), KEY)] as const))),
    paths: Object.entries(params.approved).map(([json_path, segment_id]) => ({
      json_path, segment_id, path_type: "leaf", exposure_eligibility: true,
    })),
  };
}

function snapshotResponse(stored: StoredDomain, url: string): Response {
  const requested = new URL(url, "http://localhost").searchParams.getAll("segment_ids");
  const segments = Object.fromEntries(Object.entries(stored.segments).filter(([segment]) =>
    !requested.length || requested.includes(segment)));
  // Match get_domain_snapshot's actual filtered-selection 404 contract.
  if (!Object.keys(segments).length) return new Response("", { status: 404 });
  const first = Object.values(segments)[0]!;
  return Response.json({
    schema_version: "pkm_domain_snapshot.v1",
    user_id: OWNER,
    domain: stored.domain,
    storage_mode: stored.storageMode ?? "domain",
    content_revision: stored.revision,
    manifest_revision: stored.manifestRevision,
    etag: `revision-${stored.revision}-manifest-${stored.manifestRevision}`,
    updated_at: "2026-10-13T00:00:00.000Z",
    encrypted_blob: { ...first, segments },
    segment_ids: Object.keys(segments),
    manifest: {
      domain: stored.domain,
      manifest_version: stored.manifestRevision,
      externalizable_paths: stored.paths.map(path => path.json_path),
      segment_ids: Object.keys(stored.segments),
    },
    paths: stored.paths,
    scopes: stored.scopes ?? [],
  });
}

function installProvider(state: { stored: StoredDomain }) {
  transport.apiFetch.mockImplementation(async (url: string) => {
    if (url.includes("/domain-snapshot/")) return snapshotResponse(state.stored, url);
    if (url.endsWith("/compose")) return Response.json({
      answerMode: "agent", answer: "A readable prepared answer.", covers: [], gaps: [],
    });
    throw new Error("Unexpected transport route");
  });
}

function session(scopes = [NAME_SCOPE, AGE_SCOPE]) {
  return createConsentExportReadSession({ ...PARAMS, scopes });
}

async function rawCache(): Promise<unknown[]> {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open("hushh-secure-resource-cache", 1);
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const database = open.result;
      const request = database.transaction("resource_cache", "readonly").objectStore("resource_cache").getAll();
      request.onerror = () => reject(request.error);
      request.onsuccess = () => { resolve(request.result); database.close(); };
    };
  });
}

beforeEach(async () => {
  transport.apiFetch.mockReset();
  transport.encrypt.mockImplementation(({ plaintext, keyHex }) => encryptData(plaintext, keyHex));
  clearMarkdownMemory();
  CacheService.getInstance().clear();
  advanceVaultSessionEpoch();
  await SecureResourceCacheService.invalidateUser(OWNER);
});

afterEach(async () => {
  clearMarkdownMemory();
  vi.restoreAllMocks();
  await SecureResourceCacheService.invalidateUser(OWNER);
});

describe("actual paid-answer coherent reads and encrypted projection reuse", () => {
  it("coalesces one domain read/decryption and projects each exact approved field", async () => {
    const state = { stored: await storedDomain({
      data: { profile: { name: "Synthetic Ava", age: 35, sibling: "unapproved sibling" } },
      approved: { "profile.name": "profile", "profile.age": "profile", "profile.sibling": "profile" },
    }) };
    // The owner can fetch ciphertext, but a scope read must not decrypt unrelated segments.
    state.stored.segments.private_notes = { ciphertext: "poison", iv: "poison", tag: "poison", encoding: "base64", algorithm: "aes-256-gcm" };
    installProvider(state);
    const decrypt = vi.spyOn(PersonalKnowledgeModelService, "decryptDomainSnapshot");
    const read = session();
    const [name, age] = await Promise.all([read.build(NAME_SCOPE), read.build(AGE_SCOPE)]);
    expect(transport.apiFetch).toHaveBeenCalledTimes(1);
    expect(transport.apiFetch.mock.calls[0]![0]).not.toContain("segment_ids");
    expect(decrypt).toHaveBeenCalledTimes(1);
    expect(decrypt.mock.calls[0]![0].segmentIds).toEqual(["profile"]);
    expect(name.payload.identity).toEqual({ profile: { name: "Synthetic Ava" } });
    expect(age.payload.identity).toEqual({ profile: { age: 35 } });
    expect(JSON.stringify([name, age])).not.toContain("unapproved sibling");
    expect(name).toMatchObject({ sourceContentRevision: 7, sourceManifestRevision: 4 });
    await expect(read.build("attr.identity.profile.sibling")).rejects.toThrow("Scope not approved");
    expect(transport.apiFetch).toHaveBeenCalledTimes(1);
  });

  it("revalidates a warm encrypted cache against current revisions without re-decrypting the source", async () => {
    const state = { stored: await storedDomain({
      data: { profile: { name: "Synthetic Ava", age: 35 } },
      approved: { "profile.name": "profile", "profile.age": "profile" },
    }) };
    installProvider(state);
    const decrypt = vi.spyOn(PersonalKnowledgeModelService, "decryptDomainSnapshot");
    const first = await session().build(NAME_SCOPE);
    const cached = await session().build(NAME_SCOPE);
    expect(cached).toEqual(first);
    expect(transport.apiFetch).toHaveBeenCalledTimes(2);
    expect(decrypt).toHaveBeenCalledTimes(1);
    const keys = await SecureResourceCacheService.listResourceKeys(OWNER, "answer_scope_projection:v1:");
    expect(keys).toHaveLength(1);
    expect(JSON.stringify(await rawCache())).not.toContain("Synthetic Ava");
    expect(JSON.stringify(await rawCache())).not.toContain(PARAMS.vaultOwnerToken);
    const persisted = await SecureResourceCacheService.read<{ exports: Record<string, unknown> }>({
      ...PARAMS, resourceKey: keys[0]!,
    });
    expect(persisted?.exports[NAME_SCOPE]).toEqual(first);
  });

  it("does not reuse deleted values or a projection whose current manifest posture became private", async () => {
    const state = { stored: await storedDomain({
      data: { profile: { name: "Synthetic Ava", age: 35 } },
      approved: { "profile.name": "profile", "profile.age": "profile" },
    }) };
    installProvider(state);
    const decrypt = vi.spyOn(PersonalKnowledgeModelService, "decryptDomainSnapshot");
    await session().build(NAME_SCOPE);
    state.stored = await storedDomain({
      data: { profile: {} }, revision: 8,
      approved: { "profile.name": "profile", "profile.age": "profile" },
    });
    const deleted = await session().build(NAME_SCOPE);
    expect(deleted.payload.identity).toEqual({});
    expect(deleted.sourceContentRevision).toBe(8);
    expect(JSON.stringify(deleted)).not.toContain("Synthetic Ava");
    expect(decrypt).toHaveBeenCalledTimes(2);
    state.stored.manifestRevision = 5;
    state.stored.scopes = [{
      scope_handle: "profile-handle", scope_label: "Profile", visibility_posture: "private",
      summary_projection: { top_level_scope_path: "profile" },
    }];
    await expect(session().build(NAME_SCOPE)).rejects.toThrow("review required");
    expect(transport.apiFetch).toHaveBeenCalledTimes(3);
    expect(decrypt).toHaveBeenCalledTimes(2);
  });

  it.each([401, 403, 503])("keeps HTTP %s reads distinct from confirmed full-domain absence", async (status) => {
    transport.apiFetch.mockResolvedValueOnce(new Response("", { status }));
    await expect(session().build(NAME_SCOPE)).rejects.toThrow("coherent PKM domain snapshot");
    transport.apiFetch.mockResolvedValueOnce(new Response("", { status: 404 }));
    await expect(session().build(NAME_SCOPE)).resolves.toEqual({ payload: {} });
    expect(await SecureResourceCacheService.listResourceKeys(OWNER, "answer_scope_projection:v1:")).toEqual([]);
  });

  it("uses current root storage routing for a custom top-level source key without exposing siblings", async () => {
    const state = { stored: await storedDomain({
      domain: "professional",
      data: { root: { "Custom Profile": { name: "Synthetic Writer", private_note: "never approved" } } },
      approved: { "custom_profile.name": "root", "custom_profile.private_note": "root" },
    }) };
    installProvider(state);
    const decrypt = vi.spyOn(PersonalKnowledgeModelService, "decryptDomainSnapshot");
    const scope = "attr.professional.custom_profile.name";
    const output = await session([scope]).build(scope);
    expect(output.payload.professional).toEqual({ custom_profile: { name: "Synthetic Writer" } });
    expect(decrypt.mock.calls[0]![0].segmentIds).toEqual(["root"]);
    expect(transport.apiFetch).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(output)).not.toContain("never approved");
  });

  it("projects only the approved domain and field from an actual encrypted legacy root blob", async () => {
    const state = { stored: await storedDomain({
      storageMode: "legacy_full_blob",
      data: { root: { identity: { profile: { name: "Synthetic Legacy", age: 35 } }, health: { diagnosis: "unapproved other domain" } } },
      approved: { "profile.name": "root", "profile.age": "root" },
    }) };
    installProvider(state);
    const output = await session([NAME_SCOPE]).build(NAME_SCOPE);
    expect(output.payload.identity).toEqual({ profile: { name: "Synthetic Legacy" } });
    expect(JSON.stringify(output)).not.toContain("unapproved other domain");
    expect(JSON.stringify(output)).not.toContain('"age":35');
    expect(transport.apiFetch).toHaveBeenCalledTimes(1);
  });

  it("finds a current top-level segment when historical path routing still declares root", async () => {
    const state = { stored: await storedDomain({
      data: {
        root: { unrelated_scalar: "unapproved historical root value" },
        profile: { name: "Synthetic Partitioned", sibling: "unapproved current sibling" },
      },
      approved: { "profile.name": "root", "profile.sibling": "root" },
    }) };
    installProvider(state);
    const decrypt = vi.spyOn(PersonalKnowledgeModelService, "decryptDomainSnapshot");
    const output = await session([NAME_SCOPE]).build(NAME_SCOPE);
    expect(output.payload.identity).toEqual({ profile: { name: "Synthetic Partitioned" } });
    expect(decrypt).toHaveBeenCalledTimes(1);
    expect(decrypt.mock.calls[0]![0].segmentIds).toEqual(["root", "profile"]);
    expect(transport.apiFetch).toHaveBeenCalledTimes(1);
    expect(transport.apiFetch.mock.calls[0]![0]).not.toContain("segment_ids");
    expect(JSON.stringify(output)).not.toContain("unapproved");
  });

  it("withdraws a read completed after lock before decrypting or persisting its projection", async () => {
    const stored = await storedDomain({ data: { profile: { name: "Synthetic Ava" } }, approved: { "profile.name": "profile" } });
    let release!: (response: Response) => void;
    transport.apiFetch.mockReturnValueOnce(new Promise<Response>(resolve => { release = resolve; }));
    const decrypt = vi.spyOn(PersonalKnowledgeModelService, "decryptDomainSnapshot");
    const preparing = session([NAME_SCOPE]).build(NAME_SCOPE);
    await vi.waitFor(() => expect(transport.apiFetch).toHaveBeenCalledTimes(1));
    advanceVaultSessionEpoch();
    release(snapshotResponse(stored, "/domain-snapshot/owner/identity"));
    await expect(preparing).rejects.toThrow("Vault session changed");
    expect(decrypt).not.toHaveBeenCalled();
    expect(await SecureResourceCacheService.listResourceKeys(OWNER, "answer_scope_projection:v1:")).toEqual([]);
  });

  it("withdraws a source snapshot overtaken by a PKM deletion before publishing or caching it", async () => {
    const stored = await storedDomain({ data: { profile: { name: "Synthetic Deleted" } }, approved: { "profile.name": "profile" } });
    let release!: (response: Response) => void;
    transport.apiFetch.mockReturnValueOnce(new Promise<Response>(resolve => { release = resolve; }));
    const decrypt = vi.spyOn(PersonalKnowledgeModelService, "decryptDomainSnapshot");
    const preparing = session([NAME_SCOPE]).build(NAME_SCOPE);
    await vi.waitFor(() => expect(transport.apiFetch).toHaveBeenCalledTimes(1));
    bumpPkmInvalidationEpoch(OWNER);
    release(snapshotResponse(stored, "/domain-snapshot/owner/identity"));
    await expect(preparing).rejects.toThrow(/changed/i);
    expect(decrypt).not.toHaveBeenCalled();
    expect(await SecureResourceCacheService.listResourceKeys(OWNER, "answer_scope_projection:v1:")).toEqual([]);
  });

  it("does not compose public identity as a replacement for an unreadable approved source", async () => {
    const stored = await storedDomain({ data: { profile: { name: "Synthetic Ava" } }, approved: { "profile.name": "profile" } });
    stored.segments.profile!.tag = "AAAA";
    installProvider({ stored });
    const result = await buildAnswerPayload({
      requestId: "11111111-2222-3333-4444-555555555555", question: "What did you approve?",
      periodStart: null, periodEnd: null, approvedScopes: [NAME_SCOPE], scopeLabels: {}, answerDeadlineAt: null,
      requesterUserId: "synthetic-requester", recipientKey: { keyId: "fixture-key-id", publicKeyJwk: {} },
      ownerIdentity: { displayName: "Synthetic Public Name" },
    }, PARAMS, "synthetic-firebase-token");
    expect(result.payload.unavailableScopes).toEqual([NAME_SCOPE]);
    expect(result.payload.answer).toBeNull();
    expect(transport.apiFetch.mock.calls.filter(([url]) => String(url).endsWith("/compose"))).toHaveLength(0);
    expect(await SecureResourceCacheService.listResourceKeys(OWNER, "answer_scope_projection:v1:")).toEqual([]);
  });

  it("prepares a name-only answer after confirmed source absence without inventing profile facts", async () => {
    transport.apiFetch.mockImplementation(async (url: string) => {
      if (url.includes("/domain-snapshot/")) return new Response("", { status: 404 });
      if (url.endsWith("/compose")) return Response.json({ answerMode: "agent", answer: "My name is Synthetic Public Name.", covers: [], gaps: [] });
      throw new Error("Unexpected transport route");
    });
    const result = await buildAnswerPayload({
      requestId: "11111111-2222-3333-4444-555555555555", question: "What is your name?",
      periodStart: null, periodEnd: null, approvedScopes: [NAME_SCOPE], scopeLabels: {}, answerDeadlineAt: null,
      requesterUserId: "synthetic-requester", recipientKey: { keyId: "fixture-key-id", publicKeyJwk: {} },
      ownerIdentity: { displayName: "Synthetic Public Name" },
    }, { ...PARAMS, ownerIdentity: { displayName: "Wrong caller name" } }, "synthetic-firebase-token");
    expect(result.hasContent).toBe(true);
    expect(result.payload.answer).toBe("My name is Synthetic Public Name.");
    expect(result.payload.unavailableScopes).toEqual([]);
    expect(result.payload.memory).toContain("Synthetic Public Name");
    expect(result.payload.memory).not.toContain("Wrong caller name");
    // The account name answers the name scope, so it is the scope's value
    // rather than an empty projection the owner is nonetheless paid for.
    // Treating identity as content on its own made EVERY question with a
    // profile name chargeable, including one whose fact nobody recorded.
    expect(result.payload.approvedInformation).toEqual({
      [NAME_SCOPE]: { profile: { name: "Synthetic Public Name" } },
    });
    expect(transport.apiFetch.mock.calls.filter(([url]) => String(url).endsWith("/compose"))).toHaveLength(1);
  });

  it("measures cold/warm actual answer preparation and still composes each question separately", async () => {
    const state = { stored: await storedDomain({
      data: { profile: { name: "Synthetic Ava", age: 35, sex: "female", photo: "https://example.test/avatar.png", private_note: "unapproved note" } },
      approved: { "profile.name": "profile", "profile.age": "profile", "profile.sex": "profile", "profile.photo": "profile", "profile.private_note": "profile" },
    }) };
    installProvider(state);
    const decrypt = vi.spyOn(PersonalKnowledgeModelService, "decryptDomainSnapshot");
    const approvedScopes = [NAME_SCOPE, AGE_SCOPE, "attr.identity.profile.sex", "attr.identity.profile.photo"];
    const work: AnswerableWork = {
      requestId: "11111111-2222-3333-4444-555555555555", question: "What profile details did you approve?",
      periodStart: null, periodEnd: null, approvedScopes, scopeLabels: {}, answerDeadlineAt: null,
      requesterUserId: "synthetic-requester", recipientKey: { keyId: "fixture-key-id", publicKeyJwk: {} },
    };
    const coldStart = performance.now();
    const cold = await buildAnswerPayload(work, PARAMS, "synthetic-firebase-token");
    const coldMs = performance.now() - coldStart;
    const coldDecryptions = decrypt.mock.calls.length;
    const warmStart = performance.now();
    const warm = await buildAnswerPayload({ ...work, requestId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee" }, PARAMS, "synthetic-firebase-token");
    const warmMs = performance.now() - warmStart;
    expect(cold.hasContent).toBe(true);
    expect(warm.payload.answer).toBe("A readable prepared answer.");
    expect(warm.payload.memory).toContain("Synthetic Ava");
    expect(warm.payload.memory).toContain("female");
    expect(warm.payload.memory).toContain("35");
    expect(warm.payload.memory).toContain("https://example.test/avatar.png");
    expect(warm.payload.memory).not.toContain("unapproved note");
    expect(warm.payload.approvedInformation).toEqual(cold.payload.approvedInformation);
    expect(coldDecryptions).toBe(1);
    expect(decrypt).toHaveBeenCalledTimes(1);
    expect(transport.apiFetch.mock.calls.filter(([url]) => String(url).includes("/domain-snapshot/"))).toHaveLength(2);
    const compositionBodies = transport.apiFetch.mock.calls.filter(([url]) => String(url).endsWith("/compose"))
      .map(([, options]) => JSON.parse(options.body));
    expect(compositionBodies).toHaveLength(2);
    expect(JSON.stringify(compositionBodies)).not.toContain("unapproved note");
    // Timings are observations, not fragile machine-speed assertions. The
    // counted source decryptions prove the actual warm optimization.
    if (process.env.HUSHH_MEASURE_ANSWER_PREPARATION === "1") process.stdout.write(
      `answer preparation ciphertext fixture ${JSON.stringify({ coldMs, warmMs, coldDecryptions, warmSourceDecryptions: decrypt.mock.calls.length - coldDecryptions })}\n`,
    );
  });
});

it("round-trips existing-owner edits through encrypted storage, cold readback and both projections", async () => {
  const initial = { markdown: "- Legal name: Synthetic Ava\n- Date of birth: 1980-01-01\n- Sex: old value\n", private_sibling: "preserve this private source" };
  let soul = await storedDomain({ domain: "one_memory", data: { root: initial }, approved: {}, revision: 1 });
  const legacy = await storedDomain({ data: { identity_profile: { full_name: "Old name", sex: "legacy sex", declared_age: 46 } }, approved: { "identity_profile.full_name": "identity_profile", "identity_profile.sex": "identity_profile", "identity_profile.declared_age": "identity_profile" }, revision: 2 });
  const writes: unknown[] = [];
  transport.apiFetch.mockImplementation(async (url: string, options?: { body?: string }) => {
    if (url.includes("/metadata/") || url.includes("/manifest/")) return new Response("", { status: 404 });
    if (url.endsWith("/store-domain")) {
      const body = JSON.parse(options!.body!); writes.push(body);
      expect(body.domain).toBe("one_memory");
      expect(body.expected_data_version).toBe(soul.revision);
      soul = { domain: "one_memory", revision: soul.revision + 1, manifestRevision: soul.manifestRevision + 1, segments: body.encrypted_blob.segments, paths: body.manifest.paths };
      return Response.json({ success: true, data_version: soul.revision, updated_at: "2026-10-13T00:00:00Z" });
    }
    if (url.includes("/domain-snapshot/")) return snapshotResponse(url.endsWith("/one_memory") ? soul : legacy, url);
    if (url.includes("/domain-data/")) {
      const first = Object.values(soul.segments)[0]!;
      return Response.json({ encrypted_blob: { ...first, segments: soul.segments }, data_version: soul.revision, storage_mode: "domain", manifest_revision: soul.manifestRevision });
    }
    if (url.endsWith("/compose")) return Response.json({ answerMode: "agent", answer: "Synthetic Ava's approved identity facts.", covers: [], gaps: [] });
    throw new Error(`Unexpected transport route ${url}`);
  });
  const memory = await loadMarkdownMemory({ ...PARAMS, forceRefresh: true });
  expect(memory?.markdown).toContain("old value");
  const edited = "- Legal name: Synthetic Ava\n- Date of birth: 1998-03-14\n- Sex: female\n";
  expect(await replaceMarkdownMemoryDocument({ ...PARAMS, expectedMarkdown: memory!.markdown, expectedPersisted: true, markdown: edited, beforeEffect: async () => {} })).toMatchObject({ success: true });
  clearMarkdownMemory(); CacheService.getInstance().clear();
  const cold = await loadMarkdownMemory({ ...PARAMS, forceRefresh: true });
  expect(cold?.markdown).toBe(edited);
  const snapshot = await PersonalKnowledgeModelService.loadDomainSnapshot({ ...PARAMS, domain: "one_memory", force: true });
  expect(snapshot.data).toMatchObject({ private_sibling: initial.private_sibling });
  expect(JSON.stringify(writes)).not.toContain("female");
  expect(JSON.stringify(writes)).not.toContain("1998-03-14");
  const scopes = ["attr.identity.identity_profile.full_name", "attr.identity.identity_profile.declared_age", "attr.identity.identity_profile.sex"];
  const work: AnswerableWork = { requestId: "11111111-2222-3333-4444-555555555555", question: "What identity facts did you approve?", periodStart: null, periodEnd: null, approvedScopes: scopes, scopeLabels: {}, answerDeadlineAt: null, requesterUserId: "synthetic-requester", recipientKey: { keyId: "fixture", publicKeyJwk: {} } };
  const answer = await buildAnswerPayload(work, PARAMS, "synthetic-firebase-token");
  expect(answer.hasContent).toBe(true);
  expect(answer.payload.answerMode).toBe("agent");
  const recipient = await ensureMarketplaceRecipientKey("synthetic-requester");
  const envelope = await encryptSliceForRecipient({ payload: answer.payload, recipientPublicKeyJwk: recipient.publicKeyJwk, recipientKeyId: recipient.keyId });
  expect(envelope.ciphertext).not.toContain("Synthetic Ava");
  expect(await decryptMarketplaceEnvelope({ userId: "synthetic-requester", envelope })).toEqual(answer.payload);
  await expect(decryptMarketplaceEnvelope({ userId: "unrelated-requester", envelope })).rejects.toThrow("Recipient key unavailable");
  expect(JSON.stringify(answer.payload.approvedInformation)).toContain("female");
  expect(JSON.stringify(answer.payload.approvedInformation)).not.toContain("1998-03-14");
  const shared = buildMemoryDocument({ snapshot: { cards: [], domainInsights: [], totalCards: 0 }, sources: [{ domain: "one_memory", contentRevision: soul.revision }], domainData: { one_memory: snapshot.data }, audience: "self", builtAt: "2026-10-13T00:00:00Z" });
  expect(shared.markdown).toContain("| declared age | 28 |");
  expect(shared.markdown).not.toContain(initial.private_sibling);
  expect(await replaceMarkdownMemoryDocument({ ...PARAMS, expectedMarkdown: cold!.markdown, expectedPersisted: true, markdown: edited.replace("- Sex: female\n", ""), beforeEffect: async () => {} })).toMatchObject({ success: true });
  clearMarkdownMemory(); CacheService.getInstance().clear();
  const deleted = await loadMarkdownMemory({ ...PARAMS, forceRefresh: true });
  expect(deleted?.deletedFactLabels).toContain("sex");
  const absent = await buildAnswerPayload(work, PARAMS, "synthetic-firebase-token");
  expect(absent.hasContent).toBe(false);
  expect(JSON.stringify(absent.payload.approvedInformation)).not.toContain("legacy sex");
  expect(JSON.stringify(await rawCache())).not.toContain("Synthetic Ava");
});
