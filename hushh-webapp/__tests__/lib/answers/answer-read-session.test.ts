import "fake-indexeddb/auto";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const transport = vi.hoisted(() => ({ apiFetch: vi.fn(), encrypt: vi.fn(), refreshAccountIdentityShadow: vi.fn() }));
vi.mock("@capacitor/core", () => ({ Capacitor: { isNativePlatform: () => false } }));
vi.mock("@/lib/capacitor", () => ({ HushhPersonalKnowledgeModel: {}, HushhVault: { encryptData: transport.encrypt } }));
vi.mock("@/lib/services/api-service", () => ({ ApiService: transport }));
vi.mock("@/lib/firebase/config", () => ({ auth: { currentUser: null } }));

import { ensureMarketplaceRecipientKey, encryptSliceForRecipient, decryptMarketplaceEnvelope } from "@/lib/one-marketplace/encryption";
import { loadMarkdownMemory, clearMarkdownMemory, replaceMarkdownMemoryDocument } from "@/lib/pkm/markdown-memory";
import { buildMemoryDocument } from "@/lib/pkm/memory-document";
import { createConsentExportReadSession } from "@/lib/consent/export-builder";
import { buildAnswerPayload, runAnswerDeliverySweep } from "@/lib/answers/answer-delivery-sweep";
import { PersonalKnowledgeModelService } from "@/lib/services/personal-knowledge-model-service";
import { SecureResourceCacheService } from "@/lib/services/secure-resource-cache-service";
import { CacheService } from "@/lib/services/cache-service";
import { encryptData, type EncryptedPayload } from "@/lib/vault/encrypt";
import { advanceVaultSessionEpoch } from "@/lib/vault/session-epoch";
import { bumpPkmInvalidationEpoch } from "@/lib/cache/pkm-invalidation-epoch";
import { AnswerRequestService, type AnswerableWork } from "@/lib/services/answer-request-service";

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
  const projectionDomains = new Map<string, StoredDomain>();
  transport.apiFetch.mockImplementation(async (url: string, options?: { body?: string }) => {
    if (url.includes("/metadata/") || url.includes("/manifest/")) return new Response("", { status: 404 });
    if (url.includes("/domain-snapshot/") || url.includes("/domain-data/")) {
      const domain = new URL(url, "http://localhost").pathname.split("/").at(-1)!;
      const stored = domain === state.stored.domain ? state.stored : projectionDomains.get(domain);
      if (!stored) return new Response("", { status: 404 });
      if (url.includes("/domain-snapshot/")) return snapshotResponse(stored, url);
      const first = Object.values(stored.segments)[0]!;
      return Response.json({ encrypted_blob: { ...first, segments: stored.segments }, data_version: stored.revision, storage_mode: "domain", manifest_revision: stored.manifestRevision });
    }
    if (url.endsWith("/store-domain")) {
      const body = JSON.parse(options!.body!);
      const previous = projectionDomains.get(body.domain);
      const saved = { domain: body.domain, revision: (previous?.revision ?? 0) + 1, manifestRevision: (previous?.manifestRevision ?? 0) + 1,
        segments: body.encrypted_blob.segments, paths: body.manifest.paths };
      projectionDomains.set(body.domain, saved);
      return Response.json({ success: true, data_version: saved.revision, updated_at: "2026-10-13T00:00:00Z" });
    }
    if (url.endsWith("/compose")) return Response.json({
      answerMode: "agent", compositionReceipt: "synthetic-composition-receipt", answer: "A readable prepared answer.", covers: [], gaps: [],
    });
    throw new Error("Unexpected transport route");
  });
}

function session(scopes = [NAME_SCOPE, AGE_SCOPE]) {
  return createConsentExportReadSession({ ...PARAMS, scopes });
}

async function rawCache(): Promise<unknown[]> {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open("hushh-secure-resource-cache");
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
  // Stable age calculations and timestamps keep synthetic stale ages from
  // coincidentally matching wall-clock milliseconds in encrypted readback.
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-13T12:00:00.000Z"));
  transport.apiFetch.mockReset();
  transport.refreshAccountIdentityShadow.mockReset();
  transport.encrypt.mockImplementation(({ plaintext, keyHex }) => encryptData(plaintext, keyHex));
  clearMarkdownMemory();
  CacheService.getInstance().clear();
  advanceVaultSessionEpoch();
  await SecureResourceCacheService.invalidateUser(OWNER);
});

afterEach(async () => {
  vi.useRealTimers();
  clearMarkdownMemory();
  vi.restoreAllMocks();
  await SecureResourceCacheService.invalidateUser(OWNER);
});

/** Only transport/provider replies are synthetic; production reads, writes,
 * composition service, scope retrieval and recipient encryption remain real. */
function applicationTransport(params: {
  work: AnswerableWork;
  domains?: StoredDomain[];
  compose?: (projection: Record<string, unknown>) => Response | Promise<Response>;
  conflictProjectionOnce?: boolean;
}) {
  let conflicted = false;
  const domains = new Map((params.domains ?? []).map(domain => [domain.domain, domain]));
  const writes: Record<string, unknown>[] = [];
  const projections: Record<string, unknown>[] = [];
  const staged: { envelope: Parameters<typeof decryptMarketplaceEnvelope>[0]["envelope"]; hasContent: boolean }[] = [];
  transport.refreshAccountIdentityShadow.mockImplementation(async (idToken: string, options: { force?: boolean }) => {
    expect(idToken).toBe("synthetic-firebase-token");
    expect(options).toEqual({ force: true });
    return Response.json({ identity: {
      user_id: OWNER, display_name: params.work.ownerIdentity?.displayName,
      photo_url: params.work.ownerIdentity?.photoUrl,
    } });
  });
  transport.apiFetch.mockImplementation(async (url: string, options?: { body?: string }) => {
    if (url.endsWith("/answerable")) return Response.json({ requests: [params.work] });
    if (url.endsWith("/compose")) {
      const projection = JSON.parse(options!.body!).projection as Record<string, unknown>;
      projections.push(projection);
      return params.compose?.(projection) ?? Response.json({ answerMode: "agent", compositionReceipt: "synthetic-composition-receipt", answer: "Gemini returned this exact readable answer.", covers: params.work.approvedScopes, gaps: [] });
    }
    if (url.endsWith("/deliver")) {
      staged.push(JSON.parse(options!.body!));
      return Response.json({ delivered: true });
    }
    if (url.includes("/metadata/") || url.includes("/manifest/")) return new Response("", { status: 404 });
    if (url.endsWith("/store-domain")) {
      const body = JSON.parse(options!.body!); writes.push(body);
      const previous = domains.get(body.domain);
      if (body.domain === "one_memory") expect(body.expected_data_version).toBe(previous?.revision);
      const saved: StoredDomain = {
        domain: body.domain, revision: (previous?.revision ?? 0) + 1,
        manifestRevision: (previous?.manifestRevision ?? 0) + 1,
        segments: body.encrypted_blob.segments,
        paths: body.manifest.paths,
      };
      domains.set(body.domain, saved);
      if (params.conflictProjectionOnce && !conflicted && body.domain === "one_living_sources") {
        // A competing refresh has committed this exact encrypted projection.
        conflicted = true;
        return Response.json({ detail: { error_code: "version_conflict", current_version: saved.revision } }, { status: 409 });
      }
      return Response.json({ success: true, data_version: saved.revision, updated_at: new Date().toISOString() });
    }
    if (url.includes("/domain-snapshot/") || url.includes("/domain-data/")) {
      const domain = new URL(url, "http://localhost").pathname.split("/").at(-1)!;
      const stored = domains.get(domain);
      if (!stored) return new Response("", { status: 404 });
      if (url.includes("/domain-snapshot/")) return snapshotResponse(stored, url);
      const first = Object.values(stored.segments)[0]!;
      return Response.json({ encrypted_blob: { ...first, segments: stored.segments }, data_version: stored.revision, storage_mode: "domain", manifest_revision: stored.manifestRevision });
    }
    throw new Error(`Unexpected application route ${url}`);
  });
  return { domains, writes, projections, staged };
}

async function applicationWork(scopes: string[], ownerIdentity: AnswerableWork["ownerIdentity"] = {
  displayName: "Synthetic Public Name", email: "unapproved@example.test", photoUrl: "https://example.test/canonical-profile.png",
}): Promise<AnswerableWork> {
  const recipientKey = await ensureMarketplaceRecipientKey("synthetic-application-requester");
  return {
    requestId: "11111111-2222-3333-4444-555555555555", question: "What exact approved facts did I request?",
    periodStart: null, periodEnd: null, approvedScopes: scopes, scopeLabels: {}, answerDeadlineAt: null,
    requesterUserId: "synthetic-application-requester", recipientKey, ownerIdentity,
  };
}

function expectApprovedSourceMetadata(projection: Record<string, unknown>, scopes: string[]) {
  const freshness = projection.sourceFreshness as Record<string, {
    sources: Record<string, unknown>[]; derivedOn: string | null; builtAt: string;
  }>;
  expect(Object.keys(freshness).sort()).toEqual([...scopes].sort());
  for (const [scope, entry] of Object.entries(freshness)) {
    expect(Object.keys(entry).sort()).toEqual(["builtAt", "derivedOn", "sources"]);
    for (const source of entry.sources) {
      expect(Object.keys(source).sort()).toEqual(["absent", "contentRevision", "domain", "manifestRevision"]);
      const allowedDomains = scope.endsWith("profile_photo_url") ? ["identity"]
        : scope === "attr.professional.profile.age" || scope === "attr.professional.profile.*" && entry.derivedOn !== null ? ["professional", "identity", "one_memory"]
          : [scope.split(".")[1], "one_memory"];
      expect(allowedDomains).toContain(source.domain);
    }
  }
  const serialized = JSON.stringify(freshness);
  for (const excluded of ["accountFingerprint", "manifestFingerprint", "readablePaths", "blockedPaths", "hasCanonicalDob"]) expect(serialized).not.toContain(excluded);
}

describe("actual application Gemini preparation and encrypted staging", () => {
  const NAME = "attr.identity.identity_profile.full_name";
  const AGE = "attr.identity.identity_profile.declared_age";
  const SEX = "attr.identity.identity_profile.sex";
  const PHOTO = "attr.identity.identity_profile.profile_photo_url";
  const sweep = () => runAnswerDeliverySweep({ ...PARAMS, firebaseIdToken: "synthetic-firebase-token" });

  it.each([{ scopes: [NAME] }, { scopes: [NAME, PHOTO] }])("prepares a profile-only owner through Gemini and stages a requester-only answer ($scopes)", async ({ scopes }) => {
    const work = await applicationWork(scopes);
    const state = applicationTransport({ work });
    expect(await sweep()).toMatchObject({ delivered: 1, empty: 0, retry: 0 });
    expect(state.projections).toHaveLength(1);
    expectApprovedSourceMetadata(state.projections[0]!, scopes);
    expect(JSON.stringify(state.projections[0])).toContain("Synthetic Public Name");
    expect(JSON.stringify(state.projections[0])).not.toContain("unapproved@example.test");
    expect(JSON.stringify(state.projections[0])).not.toContain("https://example.test/canonical-profile.png");
    expect(state.staged).toHaveLength(1);
    expect(state.staged[0]!.hasContent).toBe(true);
    expect(JSON.stringify(state.staged)).not.toContain("Synthetic Public Name");
    expect(JSON.stringify(state.staged)).not.toContain("Gemini returned this exact readable answer");
    const readable = await decryptMarketplaceEnvelope({ userId: work.requesterUserId, envelope: state.staged[0]!.envelope });
    expect(readable).toMatchObject({ answerMode: "agent", answer: "Gemini returned this exact readable answer." });
    expect(readable).toMatchObject(scopes.includes(PHOTO) ? { ownerIdentity: { photoUrl: work.ownerIdentity!.photoUrl } } : { approvedScopes: [NAME] });
    if (!scopes.includes(PHOTO)) expect(readable).not.toHaveProperty("ownerIdentity.photoUrl");
    await expect(decryptMarketplaceEnvelope({ userId: "another-account", envelope: state.staged[0]!.envelope })).rejects.toThrow("Recipient key unavailable");
    expect(transport.apiFetch.mock.calls.some(([url]) => /kyc|onboarding/.test(String(url)))).toBe(false);
  });

  it.each([AGE, SEX, NAME])("cold-reads encrypted saved facts and gives Gemini only %s", async scope => {
    const soul = await storedDomain({ domain: "one_memory", data: { root: { markdown: "- Legal name: Saved Legal Name\n- Date of birth: 1998-03-14\n- Sex: female\n\nUNAPPROVED_SOUL_PROSE", private_sibling: "UNAPPROVED_SIBLING" } }, approved: {}, revision: 12 });
    const work = await applicationWork([scope]);
    const state = applicationTransport({ work, domains: [soul] });
    clearMarkdownMemory(); CacheService.getInstance().clear();
    expect(await sweep()).toMatchObject({ delivered: 1, empty: 0, retry: 0 });
    expect(state.projections).toHaveLength(1);
    expectApprovedSourceMetadata(state.projections[0]!, [scope]);
    const input = JSON.stringify(state.projections[0]);
    for (const unapproved of ["Synthetic Public Name", "unapproved@example.test", "canonical-profile.png", "1998-03-14", "UNAPPROVED_SOUL_PROSE", "UNAPPROVED_SIBLING"]) expect(input).not.toContain(unapproved);
    expect(input).toContain(scope === NAME ? "Saved Legal Name" : scope === SEX ? "female" : "declared_age");
    if (scope !== NAME) expect(input).not.toContain("Saved Legal Name");
    if (scope !== SEX) expect(input).not.toContain("female");
    const readable = await decryptMarketplaceEnvelope({ userId: work.requesterUserId, envelope: state.staged[0]!.envelope });
    expect(readable).toMatchObject({ answerMode: "agent", sourceRevisions: { [scope]: 12 } });
    expect(JSON.stringify(state.writes)).not.toContain("Saved Legal Name");
    expect(JSON.stringify(await rawCache())).not.toContain("Saved Legal Name");
  });

  it.each([AGE, SEX, "attr.preferences.favorite_food", "attr.identity.employer.name"])("records confirmed missing %s as unchargeable despite account identity", async scope => {
    const work = await applicationWork([scope]);
    const state = applicationTransport({ work });
    expect(await sweep()).toMatchObject({ delivered: 0, empty: 1, retry: 0 });
    expect(state.projections).toHaveLength(0);
    expect(state.staged).toHaveLength(1);
    expect(state.staged[0]!.hasContent).toBe(false);
    expect(transport.apiFetch.mock.calls.some(([url]) => String(url).endsWith("/payment/checkout"))).toBe(false);
  });

  it.each(["identity", "professional"])("refuses a stored %s profile age without validated DOB", async domain => {
    const scope = `attr.${domain}.profile.age`;
    const saved = await storedDomain({ domain, data: { profile: { age: 999 } }, approved: { "profile.age": "profile" } });
    const work = await applicationWork([scope]);
    const state = applicationTransport({ work, domains: [saved] });
    expect(await sweep()).toMatchObject({ delivered: 0, empty: 1, retry: 0 });
    expect(state.projections).toHaveLength(0);
    expect(state.staged[0]!.hasContent).toBe(false);
    expect(JSON.stringify(await decryptMarketplaceEnvelope({ userId: work.requesterUserId, envelope: state.staged[0]!.envelope }))).not.toContain("999");
  });

  it.each(["identity", "professional"])("derives the exact %s profile age alias internally from saved canonical DOB", async domain => {
    const scope = `attr.${domain}.profile.age`;
    const saved = await storedDomain({ domain, data: { profile: { age: 999 }, ...(domain === "identity" ? { identity_profile: { date_of_birth: "1998-03-14" } } : {}) },
      approved: { "profile.age": "profile", ...(domain === "identity" ? { "identity_profile.date_of_birth": "identity_profile" } : {}) } });
    const canonical = domain === "professional" ? [await storedDomain({ data: { identity_profile: { date_of_birth: "1998-03-14" } }, approved: { "identity_profile.date_of_birth": "identity_profile" } })] : [];
    const work = await applicationWork([scope]);
    const state = applicationTransport({ work, domains: [saved, ...canonical] });
    expect(await sweep()).toMatchObject({ delivered: 1, empty: 0, retry: 0 });
    expectApprovedSourceMetadata(state.projections[0]!, [scope]);
    expect(state.projections[0]!.values).toEqual({ [scope]: { profile: { age: "28" } } });
    expect(JSON.stringify(state.projections[0])).not.toContain("1998-03-14");
    expect(JSON.stringify(state.projections[0])).not.toContain("999");
    const readable = await decryptMarketplaceEnvelope({ userId: work.requesterUserId, envelope: state.staged[0]!.envelope });
    expect(JSON.stringify(readable)).not.toContain("1998-03-14");
    expect(JSON.stringify(readable)).not.toContain("999");
  });

  it.each(["identity", "professional"])("suppresses a deleted explicit sex on the exact %s profile alias after cold readback", async domain => {
    const scope = `attr.${domain}.profile.sex`;
    const saved = await storedDomain({ domain, data: { profile: { sex: "stale legacy sex" } }, approved: { "profile.sex": "profile" } });
    const soul = await storedDomain({ domain: "one_memory", data: { root: { markdown: "- Sex: explicitly supplied\n" } }, approved: {}, revision: 12 });
    const work = await applicationWork([scope]);
    const state = applicationTransport({ work, domains: [saved, soul] });
    expect(await sweep()).toMatchObject({ delivered: 1, empty: 0, retry: 0 });
    expect(state.projections[0]!.values).toEqual({ [scope]: { profile: { sex: "explicitly supplied" } } });
    expect(JSON.stringify(state.projections[0])).not.toContain("stale legacy sex");
    expect(await replaceMarkdownMemoryDocument({ ...PARAMS, expectedMarkdown: "- Sex: explicitly supplied\n", expectedPersisted: true, markdown: "", beforeEffect: async () => {} })).toMatchObject({ success: true });
    clearMarkdownMemory(); CacheService.getInstance().clear();
    expect(await sweep()).toMatchObject({ delivered: 0, empty: 1, retry: 0 });
    expect(state.projections).toHaveLength(1);
    expect(state.staged[1]!.hasContent).toBe(false);
    const readable = await decryptMarketplaceEnvelope({ userId: work.requesterUserId, envelope: state.staged[1]!.envelope });
    expect(JSON.stringify(readable)).not.toContain("stale legacy sex");
    expect(JSON.stringify(readable)).not.toContain("explicitly supplied");
  });

  it("validates existing legacy age and sex inside an approved professional profile parent", async () => {
    const scope = "attr.professional.profile.*";
    const saved = await storedDomain({ domain: "professional", data: { profile: { employment_status: "employed", age: 999, sex: "stale legacy sex" } },
      approved: { "profile.employment_status": "profile", "profile.age": "profile", "profile.sex": "profile" } });
    const soul = await storedDomain({ domain: "one_memory", data: { root: { markdown: "- Sex: explicitly supplied\n" } }, approved: {}, revision: 12 });
    const canonical = await storedDomain({ data: { identity_profile: { date_of_birth: "1998-03-14" } }, approved: { "identity_profile.date_of_birth": "identity_profile" } });
    const work = await applicationWork([scope]);
    const state = applicationTransport({ work, domains: [saved, soul, canonical] });
    expect(await sweep()).toMatchObject({ delivered: 1, empty: 0, retry: 0 });
    expectApprovedSourceMetadata(state.projections[0]!, [scope]);
    expect(state.projections[0]!.values).toEqual({ [scope]: { profile: { employment_status: "employed", age: "28", sex: "explicitly supplied" } } });
    expect(state.projections[0]!.sourceFreshness).toMatchObject({ [scope]: { derivedOn: new Date().toISOString().slice(0, 10), sources: expect.arrayContaining([expect.objectContaining({ domain: "identity" })]) } });
    const readable = await decryptMarketplaceEnvelope({ userId: work.requesterUserId, envelope: state.staged[0]!.envelope });
    for (const forbidden of ["1998-03-14", "999", "stale legacy sex", "Synthetic Public Name", "canonical-profile.png"]) {
      expect(JSON.stringify(state.projections[0])).not.toContain(forbidden);
      expect(JSON.stringify(readable)).not.toContain(forbidden);
    }
  });

  it("removes unvalidated age and deleted sex from an approved professional parent without losing employment", async () => {
    const scope = "attr.professional.profile.*";
    const saved = await storedDomain({ domain: "professional", data: { profile: { employment_status: "employed", age: 999, sex: "stale legacy sex" } },
      approved: { "profile.employment_status": "profile", "profile.age": "profile", "profile.sex": "profile" } });
    const soul = await storedDomain({ domain: "one_memory", data: { root: { markdown: "", _deleted_fact_labels: ["date of birth", "sex"] } }, approved: {}, revision: 12 });
    const work = await applicationWork([scope]);
    const state = applicationTransport({ work, domains: [saved, soul] });
    expect(await sweep()).toMatchObject({ delivered: 1, empty: 0, retry: 0 });
    expectApprovedSourceMetadata(state.projections[0]!, [scope]);
    expect(state.projections[0]!.values).toEqual({ [scope]: { profile: { employment_status: "employed" } } });
    const freshness = state.projections[0]!.sourceFreshness as Record<string, { derivedOn: string | null; sources: { domain: string }[] }>;
    expect(freshness[scope]!.derivedOn).toBeNull();
    expect(freshness[scope]!.sources.map(source => source.domain)).not.toContain("identity");
    const readable = await decryptMarketplaceEnvelope({ userId: work.requesterUserId, envelope: state.staged[0]!.envelope });
    expect(JSON.stringify(readable)).not.toContain("999");
    expect(JSON.stringify(readable)).not.toContain("stale legacy sex");
  });

  it("does not add personal age or sex to an ordinary approved employment parent", async () => {
    const scope = "attr.professional.profile.*";
    const saved = await storedDomain({ domain: "professional", data: { profile: { employment_status: "employed" } }, approved: { "profile.employment_status": "profile" } });
    const soul = await storedDomain({ domain: "one_memory", data: { root: { markdown: "- Date of birth: 1998-03-14\n- Sex: unapproved personal sex\n" } }, approved: {}, revision: 12 });
    const work = await applicationWork([scope]);
    const state = applicationTransport({ work, domains: [saved, soul] });
    expect(await sweep()).toMatchObject({ delivered: 1, empty: 0, retry: 0 });
    expect(state.projections[0]!.values).toEqual({ [scope]: { profile: { employment_status: "employed" } } });
    const freshness = state.projections[0]!.sourceFreshness as Record<string, { derivedOn: string | null; sources: { domain: string }[] }>;
    expect(freshness[scope]!.derivedOn).toBeNull();
    expect(freshness[scope]!.sources.map(source => source.domain)).toEqual(["professional", "one_memory"]);
    for (const forbidden of ["1998-03-14", "unapproved personal sex", '"age"', '"sex"']) expect(JSON.stringify(state.projections[0])).not.toContain(forbidden);
  });

  it.each([SEX, AGE, "attr.identity.identity_profile.date_of_birth", "attr.identity.identity_profile.citizenship", "attr.professional.profile.employment_status"])("honours a durable tombstone over retained %s labels and legacy fields on cold readback", async scope => {
    const identity = await storedDomain({ data: { identity_profile: {
      sex: "STALE_SEX", date_of_birth: "1998-03-14", declared_age: 999, citizenship: "STALE_CITIZENSHIP",
    } }, approved: { "identity_profile.sex": "identity_profile", "identity_profile.date_of_birth": "identity_profile", "identity_profile.declared_age": "identity_profile", "identity_profile.citizenship": "identity_profile" } });
    const professional = await storedDomain({ domain: "professional", data: { profile: { employment_status: "STALE_EMPLOYMENT" } }, approved: { "profile.employment_status": "profile" } });
    const soul = await storedDomain({ domain: "one_memory", data: { root: {
      markdown: "- Sex: STALE_SEX\n- Date of birth: 1998-03-14\n- Citizenship: STALE_CITIZENSHIP\n- Employment status: STALE_EMPLOYMENT\n",
      _deleted_fact_labels: ["Sex", "Date of Birth", "Citizenship", "Employment Status"],
    } }, approved: {}, revision: 12 });
    const work = await applicationWork([scope]);
    const state = applicationTransport({ work, domains: [identity, professional, soul] });
    clearMarkdownMemory(); CacheService.getInstance().clear();
    await SecureResourceCacheService.invalidateUser(OWNER);
    expect(await sweep()).toMatchObject({ delivered: 0, empty: 1, retry: 0 });
    expect(state.projections).toHaveLength(0);
    expect(state.staged).toHaveLength(1);
    expect(state.staged[0]!.hasContent).toBe(false);
    const readable = await decryptMarketplaceEnvelope({ userId: work.requesterUserId, envelope: state.staged[0]!.envelope });
    expect(readable).toMatchObject({ answerMode: "projection", answer: null, unavailableScopes: [] });
    for (const forbidden of ["STALE_SEX", "1998-03-14", "999", "STALE_CITIZENSHIP", "STALE_EMPLOYMENT"]) expect(JSON.stringify(readable)).not.toContain(forbidden);
    expect(transport.apiFetch.mock.calls.some(([url]) => String(url).endsWith("/payment/checkout"))).toBe(false);
  });

  it("uses the existing account name after a legal-name tombstone despite a retained old label", async () => {
    const identity = await storedDomain({ data: { identity_profile: { full_name: "STALE_LEGAL_NAME" } }, approved: { "identity_profile.full_name": "identity_profile" } });
    const soul = await storedDomain({ domain: "one_memory", data: { root: { markdown: "- Legal name: STALE_LEGAL_NAME\n", _deleted_fact_labels: ["Legal Name"] } }, approved: {}, revision: 12 });
    const work = await applicationWork([NAME]);
    const state = applicationTransport({ work, domains: [identity, soul] });
    clearMarkdownMemory(); CacheService.getInstance().clear();
    await SecureResourceCacheService.invalidateUser(OWNER);
    expect(await sweep()).toMatchObject({ delivered: 1, empty: 0, retry: 0 });
    expect(state.projections[0]!.values).toEqual({ [NAME]: { identity_profile: { full_name: "Synthetic Public Name" } } });
    expect(JSON.stringify(state.projections[0])).not.toContain("STALE_LEGAL_NAME");
    expect(JSON.stringify(await decryptMarketplaceEnvelope({ userId: work.requesterUserId, envelope: state.staged[0]!.envelope }))).not.toContain("STALE_LEGAL_NAME");
  });

  it.each([PHOTO, "attr.preferences.favorite_food"])("does not sell an approved name when the other approved %s is missing", async missing => {
    const work = await applicationWork([NAME, missing], {
      displayName: "Synthetic Public Name", email: "unapproved@example.test",
      photoUrl: missing === PHOTO ? null : "https://example.test/unapproved-photo.png",
    });
    const state = applicationTransport({ work });
    expect(await sweep()).toMatchObject({ delivered: 0, empty: 1, retry: 0 });
    expect(state.projections).toHaveLength(0);
    expect(state.staged).toHaveLength(1);
    expect(state.staged[0]!.hasContent).toBe(false);
    const checked = await decryptMarketplaceEnvelope({ userId: work.requesterUserId, envelope: state.staged[0]!.envelope });
    expect(checked).toMatchObject({ answerMode: "projection", answer: null, unavailableScopes: [] });
    expect(transport.apiFetch.mock.calls.some(([url]) => String(url).endsWith("/payment/checkout"))).toBe(false);
  });

  it("keeps Gemini failure retryable and stages only after a later successful composition", async () => {
    const work = await applicationWork([NAME]);
    let succeed = false;
    const state = applicationTransport({ work, compose: () => succeed
      ? Response.json({ answerMode: "agent", compositionReceipt: "synthetic-composition-receipt", answer: "A later Gemini answer.", covers: [NAME], gaps: [] })
      : new Response("", { status: 503 }) });
    expect(await sweep()).toMatchObject({ delivered: 0, empty: 0, retry: 1 });
    expect(state.staged).toHaveLength(0);
    succeed = true;
    expect(await sweep()).toMatchObject({ delivered: 1, empty: 0, retry: 0 });
    expect(state.projections).toHaveLength(2);
    expect(await decryptMarketplaceEnvelope({ userId: work.requesterUserId, envelope: state.staged[0]!.envelope })).toMatchObject({ answer: "A later Gemini answer.", answerMode: "agent" });
  });

  it("refuses a readable-looking reply without authenticated Gemini composition evidence", async () => {
    const work = await applicationWork([NAME]);
    const state = applicationTransport({ work, compose: () => Response.json({ answerMode: "agent", answer: "An unproven direct answer.", covers: [NAME], gaps: [] }) });
    expect(await sweep()).toMatchObject({ delivered: 0, empty: 0, retry: 1 });
    expect(state.staged).toHaveLength(0);
    expect(transport.apiFetch.mock.calls.some(([url]) => String(url).endsWith("/payment/checkout"))).toBe(false);
  });

  it("keeps a Gemini-reported gap pending without staging or checkout", async () => {
    const work = await applicationWork([NAME]);
    const state = applicationTransport({ work, compose: () => Response.json({
      answerMode: "agent", compositionReceipt: "synthetic-composition-receipt",
      answer: "I can only answer part of this question.", covers: [NAME], gaps: ["The question is not fully answered."],
    }) });
    expect(await sweep()).toMatchObject({ delivered: 0, empty: 0, retry: 1 });
    expect(state.projections).toHaveLength(1);
    expect(state.staged).toHaveLength(0);
    expect(transport.apiFetch.mock.calls.some(([url]) => String(url).endsWith("/payment/checkout"))).toBe(false);
  });

  it.each(["edit", "delete"])("withdraws Gemini's in-flight answer after an owner %s and retries against the saved source", async action => {
    const initialMarkdown = "- Sex: female\n";
    const soul = await storedDomain({ domain: "one_memory", data: { root: {
      markdown: initialMarkdown, private_sibling: "PRESERVED_PRIVATE_SOURCE",
    } }, approved: {}, revision: 12 });
    const work = await applicationWork([SEX]);
    let release!: (response: Response) => void;
    let retry = false;
    const state = applicationTransport({ work, domains: [soul], compose: () => retry
      ? Response.json({ answerMode: "agent", compositionReceipt: "synthetic-composition-receipt", answer: "Gemini composed the edited sex: male.", covers: [SEX], gaps: [] })
      : new Promise<Response>(resolve => { release = resolve; }) });
    const pending = sweep();
    await vi.waitFor(() => expect(state.projections).toHaveLength(1));
    expect(JSON.stringify(state.projections[0])).toContain("female");
    expect(await replaceMarkdownMemoryDocument({
      ...PARAMS, expectedMarkdown: initialMarkdown, expectedPersisted: true,
      markdown: action === "edit" ? "- Sex: male\n" : "",
      beforeEffect: async () => {},
    })).toMatchObject({ success: true });
    release(Response.json({ answerMode: "agent", compositionReceipt: "synthetic-composition-receipt", answer: "STALE_FEMALE_GEMINI_ANSWER", covers: [SEX], gaps: [] }));
    expect(await pending).toMatchObject({ delivered: 0, empty: 0, retry: 0, skipped: 1 });
    expect(state.staged).toHaveLength(0);
    expect(JSON.stringify(await rawCache())).not.toContain("STALE_FEMALE_GEMINI_ANSWER");
    retry = true;
    clearMarkdownMemory(); CacheService.getInstance().clear();
    expect(await sweep()).toMatchObject(action === "edit"
      ? { delivered: 1, empty: 0, retry: 0 }
      : { delivered: 0, empty: 1, retry: 0 });
    expect(state.projections).toHaveLength(action === "edit" ? 2 : 1);
    expect(state.staged).toHaveLength(1);
    expect(state.staged[0]!.hasContent).toBe(action === "edit");
    const readable = await decryptMarketplaceEnvelope({ userId: work.requesterUserId, envelope: state.staged[0]!.envelope });
    expect(JSON.stringify(readable)).not.toContain("female");
    expect(JSON.stringify(readable)).not.toContain("PRESERVED_PRIVATE_SOURCE");
    if (action === "edit") {
      expect(JSON.stringify(state.projections[1])).toContain("male");
      expect(readable).toMatchObject({ answerMode: "agent", answer: "Gemini composed the edited sex: male.", sourceRevisions: { [SEX]: 13 } });
    } else expect(readable).toMatchObject({ answerMode: "projection", answer: null });
    const current = await PersonalKnowledgeModelService.loadDomainSnapshot({ ...PARAMS, domain: "one_memory", force: true });
    expect(current.data).toMatchObject({ private_sibling: "PRESERVED_PRIVATE_SOURCE" });
    expect(JSON.stringify(state.writes)).not.toContain("PRESERVED_PRIVATE_SOURCE");
  });

  it.each([NAME, PHOTO])("withdraws an account-fallback %s answer changed while Gemini composes", async scope => {
    const work = await applicationWork([scope]);
    let release!: (response: Response) => void;
    let retry = false;
    const state = applicationTransport({ work, compose: () => retry
      ? Response.json({ answerMode: "agent", compositionReceipt: "synthetic-composition-receipt", answer: "Gemini composed the current profile.", covers: [scope], gaps: [] })
      : new Promise<Response>(resolve => { release = resolve; }) });
    const pending = sweep();
    await vi.waitFor(() => expect(state.projections).toHaveLength(1));
    work.ownerIdentity = { displayName: "Edited Public Name", photoUrl: "https://example.test/edited-profile.png" };
    release(Response.json({ answerMode: "agent", compositionReceipt: "synthetic-composition-receipt", answer: "STALE_PROFILE_GEMINI_ANSWER", covers: [scope], gaps: [] }));
    expect(await pending).toMatchObject({ delivered: 0, empty: 0, retry: 0, skipped: 1 });
    expect(state.staged).toHaveLength(0);
    expect(transport.refreshAccountIdentityShadow).toHaveBeenCalledWith("synthetic-firebase-token", { force: true });
    retry = true;
    expect(await sweep()).toMatchObject({ delivered: 1, empty: 0, retry: 0 });
    expect(state.projections).toHaveLength(2);
    expect(state.staged).toHaveLength(1);
    const readable = await decryptMarketplaceEnvelope({ userId: work.requesterUserId, envelope: state.staged[0]!.envelope });
    expect(readable).toMatchObject({ answerMode: "agent", answer: "Gemini composed the current profile." });
    expect(JSON.stringify(readable)).not.toContain("STALE_PROFILE_GEMINI_ANSWER");
    if (scope === NAME) expect(JSON.stringify(readable)).toContain("Edited Public Name");
    else expect(readable).toMatchObject({ ownerIdentity: { photoUrl: "https://example.test/edited-profile.png", displayName: null } });
    expect(JSON.stringify(await rawCache())).not.toContain("Edited Public Name");
  });

  it.each(["composition", "sealing"])("rechecks remote source revisions after asynchronous %s before staging", async phase => {
    const soul = await storedDomain({ domain: "one_memory", data: { root: { markdown: "- Sex: female\n" } }, approved: {}, revision: 12 });
    const work = await applicationWork([SEX]);
    let releaseComposition!: (response: Response) => void;
    let releaseSealing!: () => void;
    let sealingStarted = false;
    let retry = false;
    const state = applicationTransport({ work, domains: [soul], compose: () => {
      if (phase === "composition" && !retry) return new Promise<Response>(resolve => { releaseComposition = resolve; });
      return Response.json({ answerMode: "agent", compositionReceipt: "synthetic-composition-receipt", answer: retry ? "Gemini composed the current remote sex: male." : "STALE_REMOTE_GEMINI_ANSWER", covers: [SEX], gaps: [] });
    } });
    const realEncrypt = crypto.subtle.encrypt.bind(crypto.subtle);
    const sealing = vi.spyOn(crypto.subtle, "encrypt").mockImplementation(async (algorithm, key, data) => {
      const plaintext = new TextDecoder().decode(data);
      if (phase === "sealing" && plaintext.includes('"answer":"STALE_REMOTE_GEMINI_ANSWER"')) {
        sealingStarted = true;
        await new Promise<void>(resolve => { releaseSealing = resolve; });
      }
      return realEncrypt(algorithm, key, data);
    });
    const pending = sweep();
    await vi.waitFor(() => phase === "composition"
      ? expect(state.projections).toHaveLength(1) : expect(sealingStarted).toBe(true));
    // Another device changes the encrypted source without bumping this
    // browser's local epoch. Only the authoritative revision read sees it.
    state.domains.set("one_memory", await storedDomain({ domain: "one_memory", data: { root: { markdown: "- Sex: male\n" } }, approved: {}, revision: 13, manifestRevision: 5 }));
    if (phase === "composition") releaseComposition(Response.json({ answerMode: "agent", compositionReceipt: "synthetic-composition-receipt", answer: "STALE_REMOTE_GEMINI_ANSWER", covers: [SEX], gaps: [] }));
    else releaseSealing();
    expect(await pending).toMatchObject({ delivered: 0, empty: 0, skipped: 1 });
    expect(state.staged).toHaveLength(0);
    sealing.mockRestore();
    retry = true;
    expect(await sweep()).toMatchObject({ delivered: 1, empty: 0, skipped: 0, retry: 0 });
    expect(JSON.stringify(state.projections[1])).toContain("male");
    expect(JSON.stringify(state.projections[1])).not.toContain("female");
    expect(await decryptMarketplaceEnvelope({ userId: work.requesterUserId, envelope: state.staged[0]!.envelope })).toMatchObject({ answer: "Gemini composed the current remote sex: male.", sourceRevisions: { [SEX]: 13 } });
    expect(JSON.stringify(await rawCache())).not.toContain("STALE_REMOTE_GEMINI_ANSWER");
  });

  it.each(["vault lock", "account switch"])("cannot stage an in-flight Gemini answer after %s", async () => {
    const work = await applicationWork([NAME]);
    let release!: (response: Response) => void;
    const state = applicationTransport({ work, compose: () => new Promise<Response>(resolve => { release = resolve; }) });
    const pending = sweep();
    await vi.waitFor(() => expect(state.projections).toHaveLength(1));
    advanceVaultSessionEpoch();
    release(Response.json({ answerMode: "agent", compositionReceipt: "synthetic-composition-receipt", answer: "PRIVATE_PENDING_ANSWER", covers: [NAME], gaps: [] }));
    await pending;
    expect(state.staged).toHaveLength(0);
    expect(JSON.stringify(await rawCache())).not.toContain("PRIVATE_PENDING_ANSWER");
  });
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
    const keys = await SecureResourceCacheService.listResourceKeys(OWNER, "answer_scope_projection:v2:");
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
    expect(await SecureResourceCacheService.listResourceKeys(OWNER, "answer_scope_projection:v2:")).toEqual([]);
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
    expect(await SecureResourceCacheService.listResourceKeys(OWNER, "answer_scope_projection:v2:")).toEqual([]);
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
    expect(await SecureResourceCacheService.listResourceKeys(OWNER, "answer_scope_projection:v2:")).toEqual([]);
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
    expect(await SecureResourceCacheService.listResourceKeys(OWNER, "answer_scope_projection:v2:")).toEqual([]);
  });

  it("prepares a name-only answer after confirmed source absence without inventing profile facts", async () => {
    const work: AnswerableWork = {
      requestId: "11111111-2222-3333-4444-555555555555", question: "What is your name?",
      periodStart: null, periodEnd: null, approvedScopes: [NAME_SCOPE], scopeLabels: {}, answerDeadlineAt: null,
      requesterUserId: "synthetic-requester", recipientKey: { keyId: "fixture-key-id", publicKeyJwk: {} },
      ownerIdentity: { displayName: "Synthetic Public Name" },
    };
    applicationTransport({ work, compose: () => Response.json({ answerMode: "agent", compositionReceipt: "synthetic-composition-receipt", answer: "My name is Synthetic Public Name.", covers: [], gaps: [] }) });
    const result = await buildAnswerPayload(work, { ...PARAMS, ownerIdentity: { displayName: "Wrong caller name" } }, "synthetic-firebase-token");
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
    const stored = await storedDomain({
      data: { profile: { name: "Synthetic Ava", age: 35, sex: "female", photo: "https://example.test/avatar.png", private_note: "unapproved note" }, identity_profile: { date_of_birth: "1991-01-01" } },
      approved: { "profile.name": "profile", "profile.age": "profile", "profile.sex": "profile", "profile.photo": "profile", "profile.private_note": "profile", "identity_profile.date_of_birth": "identity_profile" },
    });
    const decrypt = vi.spyOn(PersonalKnowledgeModelService, "decryptDomainSnapshot");
    const approvedScopes = [NAME_SCOPE, AGE_SCOPE, "attr.identity.profile.sex", "attr.identity.profile.photo"];
    const work = await applicationWork(approvedScopes, null);
    const state = applicationTransport({ work, domains: [stored] });
    const blankPhases = () => ({ retrievalMs: 0, compositionServiceMs: 0, freshnessChecksMs: 0, recipientEncryptionMs: 0, stagingServiceMs: 0, endToEndMs: 0 });
    let phases = blankPhases();
    const memoryRetrieval = await import("@/lib/pkm/memory-scope-retrieval");
    const realRetrieve = memoryRetrieval.retrieveApprovedMemoryScopes;
    vi.spyOn(memoryRetrieval, "retrieveApprovedMemoryScopes").mockImplementation(async params => {
      const started = performance.now();
      const retrieved = await realRetrieve(params);
      phases.retrievalMs += performance.now() - started;
      const realAssertCurrent = retrieved.assertCurrent;
      return { ...retrieved, assertCurrent: async () => {
        const checked = performance.now();
        try { await realAssertCurrent(); }
        finally { phases.freshnessChecksMs += performance.now() - checked; }
      } };
    });
    const realCompose = AnswerRequestService.compose;
    vi.spyOn(AnswerRequestService, "compose").mockImplementation(async (...args) => {
      const started = performance.now();
      try { return await realCompose(...args); }
      finally { phases.compositionServiceMs += performance.now() - started; }
    });
    const encryption = await import("@/lib/one-marketplace/encryption");
    const realEncrypt = encryption.encryptSliceForRecipient;
    vi.spyOn(encryption, "encryptSliceForRecipient").mockImplementation(async params => {
      const started = performance.now();
      try { return await realEncrypt(params); }
      finally { phases.recipientEncryptionMs += performance.now() - started; }
    });
    const realDeliver = AnswerRequestService.deliver;
    vi.spyOn(AnswerRequestService, "deliver").mockImplementation(async (...args) => {
      const started = performance.now();
      try { await realDeliver(...args); }
      finally { phases.stagingServiceMs += performance.now() - started; }
    });
    const sweep = () => runAnswerDeliverySweep({ ...PARAMS, firebaseIdToken: "synthetic-firebase-token" });
    const counts = () => ({
      sourceDecryptions: decrypt.mock.calls.filter(([params]) => params.snapshot.domain === "identity").length,
      sourceSnapshotReads: transport.apiFetch.mock.calls.filter(([url]) => String(url).includes("/domain-snapshot/") && String(url).includes("/identity")).length,
      projectionSnapshotReads: transport.apiFetch.mock.calls.filter(([url]) => String(url).includes("/domain-snapshot/") && String(url).includes("/one_living_sources")).length,
      compositions: state.projections.length, stages: state.staged.length, encryptedProjectionWrites: state.writes.length,
    });
    const coldStart = performance.now();
    expect(await sweep()).toMatchObject({ delivered: 1, empty: 0, retry: 0 });
    phases.endToEndMs = performance.now() - coldStart;
    const coldTimings = { ...phases, counts: counts() };
    const cold = await decryptMarketplaceEnvelope({ userId: work.requesterUserId, envelope: state.staged[0]!.envelope }) as { answer: string; memory: string; approvedInformation: Record<string, unknown> };
    // Remove all browser caches while retaining the encrypted provider-side
    // memory.md projection. The second sweep must read that persisted layer.
    clearMarkdownMemory(); CacheService.getInstance().clear();
    await SecureResourceCacheService.invalidateUser(OWNER);
    work.requestId = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
    const beforeWarm = counts();
    phases = blankPhases();
    const warmStart = performance.now();
    expect(await sweep()).toMatchObject({ delivered: 1, empty: 0, retry: 0 });
    phases.endToEndMs = performance.now() - warmStart;
    const afterWarm = counts();
    const warmTimings = { ...phases, counts: Object.fromEntries(Object.entries(afterWarm).map(([key, value]) => [key, value - beforeWarm[key as keyof typeof beforeWarm]])) };
    const warm = await decryptMarketplaceEnvelope({ userId: work.requesterUserId, envelope: state.staged[1]!.envelope }) as typeof cold;
    expect(warm.answer).toBe("Gemini returned this exact readable answer.");
    expect(warm.memory).toContain("Synthetic Ava");
    expect(warm.memory).toContain("female");
    expect(warm.memory).toContain("35");
    expect(warm.memory).toContain("https://example.test/avatar.png");
    expect(warm.memory).not.toContain("unapproved note");
    expect(warm.approvedInformation).toEqual(cold.approvedInformation);
    expect(coldTimings.counts.sourceDecryptions).toBe(1);
    expect(warmTimings.counts.sourceDecryptions).toBe(0);
    expect(warmTimings.counts.projectionSnapshotReads).toBeGreaterThan(0);
    expect(warmTimings.counts.encryptedProjectionWrites).toBe(0);
    expect(state.projections).toHaveLength(2);
    expect(state.staged).toHaveLength(2);
    expect(JSON.stringify(state.projections)).not.toContain("unapproved note");
    expect(JSON.stringify(state.projections)).not.toContain("1991-01-01");
    // Provider replies are immediate synthetic transport responses. These
    // observations measure local application work, not Vertex/Stripe latency.
    if (process.env.HUSHH_MEASURE_ANSWER_PREPARATION === "1") process.stdout.write(
      `answer preparation ciphertext fixture ${JSON.stringify({ transport: "synthetic immediate PKM/composer/staging HTTP replies; actual application methods and WebCrypto", runs: { cold: 1, warm: 1 }, cold: coldTimings, warm: warmTimings })}\n`,
    );
  });
});

it("round-trips existing-owner edits through encrypted storage, cold readback and both projections", async () => {
  const initial = { markdown: "- Legal name: Synthetic Ava\n- Date of birth: 1980-01-01\n- Sex: old value\n", private_sibling: "preserve this private source" };
  let soul = await storedDomain({ domain: "one_memory", data: { root: initial }, approved: {}, revision: 1 });
  const legacy = await storedDomain({ data: { identity_profile: { full_name: "Old name", sex: "legacy sex", declared_age: 46 } }, approved: { "identity_profile.full_name": "identity_profile", "identity_profile.sex": "identity_profile", "identity_profile.declared_age": "identity_profile" }, revision: 2 });
  const writes: unknown[] = [];
  let scopeProjection: StoredDomain | null = null;
  transport.apiFetch.mockImplementation(async (url: string, options?: { body?: string }) => {
    if (url.includes("/metadata/") || url.includes("/manifest/")) return new Response("", { status: 404 });
    if (url.endsWith("/store-domain")) {
      const body = JSON.parse(options!.body!); writes.push(body);
      if (body.domain === "one_memory") {
        expect(body.expected_data_version).toBe(soul.revision);
        soul = { domain: "one_memory", revision: soul.revision + 1, manifestRevision: soul.manifestRevision + 1, segments: body.encrypted_blob.segments, paths: body.manifest.paths };
        return Response.json({ success: true, data_version: soul.revision, updated_at: "2026-10-13T00:00:00Z" });
      }
      expect(body.domain).toBe("one_living_sources");
      scopeProjection = { domain: body.domain, revision: (scopeProjection?.revision ?? 0) + 1, manifestRevision: (scopeProjection?.manifestRevision ?? 0) + 1, segments: body.encrypted_blob.segments, paths: body.manifest.paths };
      return Response.json({ success: true, data_version: scopeProjection.revision, updated_at: "2026-10-13T00:00:00Z" });
    }
    if (url.includes("/domain-snapshot/")) {
      const domain = new URL(url, "http://localhost").pathname.split("/").at(-1)!;
      const stored = domain === "one_memory" ? soul : domain === "identity" ? legacy : scopeProjection;
      return stored ? snapshotResponse(stored, url) : new Response("", { status: 404 });
    }
    if (url.includes("/domain-data/")) {
      const domain = new URL(url, "http://localhost").pathname.split("/").at(-1)!;
      const stored = domain === "one_memory" ? soul : domain === "identity" ? legacy : scopeProjection;
      if (!stored) return new Response("", { status: 404 });
      const first = Object.values(stored.segments)[0]!;
      return Response.json({ encrypted_blob: { ...first, segments: stored.segments }, data_version: stored.revision, storage_mode: "domain", manifest_revision: stored.manifestRevision });
    }
    if (url.endsWith("/compose")) return Response.json({ answerMode: "agent", compositionReceipt: "synthetic-composition-receipt", answer: "Synthetic Ava's approved identity facts.", covers: [], gaps: [] });
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

it("recovers an encrypted projection conflict and stages the current approved fact exactly once", async () => {
  const name = "attr.identity.identity_profile.full_name";
  const work = await applicationWork([name]);
  const state = applicationTransport({ work, conflictProjectionOnce: true });
  const selected = { ...PARAMS, firebaseIdToken: "synthetic-firebase-token", requestId: work.requestId };
  const results = await Promise.all([runAnswerDeliverySweep(selected), runAnswerDeliverySweep(selected)]);
  expect(results.every(result => result.delivered === 1)).toBe(true);
  expect(state.domains.get("one_living_sources")?.revision).toBe(1);
  expect(state.projections).toHaveLength(1);
  expect(JSON.stringify(state.projections[0])).toContain("Synthetic Public Name");
  expect(state.staged).toHaveLength(1);
  expect(JSON.stringify(state.staged)).not.toContain("Synthetic Public Name");
  const opened = await decryptMarketplaceEnvelope({ userId: work.requesterUserId, envelope: state.staged[0]!.envelope });
  expect(JSON.stringify(opened)).toContain("Gemini returned this exact readable answer.");
});
