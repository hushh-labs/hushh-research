import { beforeEach, describe, expect, it, vi } from "vitest";

const transport = vi.hoisted(() => ({ snapshot: vi.fn(), load: vi.fn(), write: vi.fn(), export: vi.fn(), soul: vi.fn(), peek: vi.fn() }));
vi.mock("@/lib/services/personal-knowledge-model-service", () => ({ PersonalKnowledgeModelService: { getDomainSnapshot: transport.snapshot, loadDomainSnapshot: transport.load } }));
vi.mock("@/lib/services/pkm-write-coordinator", () => ({ PkmWriteCoordinator: { saveMergedDomain: transport.write } }));
vi.mock("@/lib/consent/export-builder", () => ({ createConsentExportReadSession: () => undefined, buildConsentExportForScope: transport.export }));
vi.mock("@/lib/pkm/markdown-memory", () => ({ loadMarkdownMemory: transport.soul, peekMarkdownMemory: transport.peek }));

import { retrieveApprovedMemoryScopes } from "@/lib/pkm/memory-scope-retrieval";
import { answerScopeAvailability } from "@/lib/answers/answer-scope-availability";
import { bumpPkmInvalidationEpoch } from "@/lib/cache/pkm-invalidation-epoch";
import { advanceVaultSessionEpoch } from "@/lib/vault/session-epoch";
import { CacheService } from "@/lib/services/cache-service";

const USER = "synthetic-memory-owner";
const NAME = "attr.identity.identity_profile.full_name";
const AGE = "attr.identity.identity_profile.declared_age";
const DOB = "attr.identity.identity_profile.date_of_birth";
const SEX = "attr.identity.identity_profile.sex";
const SESSION = { userId: USER, vaultKey: "synthetic-vault-key", vaultOwnerToken: "synthetic-owner-token" };
let projection: Record<string, unknown>;
let identity: { revision: number; manifestRevision: number; paths: string[]; value: Record<string, unknown>; blocked?: string[] } | null;
let soul: { revision: number; markdown: string; deletedFactLabels: string[] } | null;

function envelope(domain: string, revision: number, manifestRevision: number, paths: string[], blocked: readonly string[] = []) {
  return { userId: USER, domain, contentRevision: revision, manifestRevision,
    manifest: { domain, manifest_version: manifestRevision, externalizable_paths: paths, paths: paths.map(json_path => ({ json_path, path_type: "leaf", exposure_eligibility: !blocked.includes(json_path) })), scope_registry: [] } };
}
function atPath(value: Record<string, unknown>, path: string): unknown {
  let current: unknown = value;
  for (const segment of path.split(".")) current = current && typeof current === "object" ? (current as Record<string, unknown>)[segment] : undefined;
  return current;
}
function payload(path: string, value: unknown): Record<string, unknown> {
  const result: Record<string, unknown> = {}; let current = result;
  const segments = path.split(".");
  for (const segment of segments.slice(0, -1)) current = (current[segment] = {}) as Record<string, unknown>;
  if (value !== undefined) current[segments.at(-1)!] = value;
  return result;
}
const resultValue = (result: Awaited<ReturnType<typeof retrieveApprovedMemoryScopes>>, scope: string, path: string) => atPath(result.projections.find(item => item.scope === scope)?.payload ?? {}, path);

beforeEach(() => {
  vi.clearAllMocks(); advanceVaultSessionEpoch(); CacheService.getInstance().clear();
  projection = { retained_source: "private original", _private: { inventory: { complete: true }, memory_document: { document: { markdown: "Full owner document", complete: true }, signature: "retained-profile-signature" } } };
  identity = null; soul = null;
  transport.peek.mockReturnValue(undefined);
  transport.snapshot.mockImplementation(async ({ domain }: { domain: string }) => domain === "identity" ? identity && envelope(domain, identity.revision, identity.manifestRevision, identity.paths, identity.blocked) : domain === "one_memory" ? soul && envelope(domain, soul.revision, 1, ["markdown"]) : null);
  transport.load.mockImplementation(async () => ({ snapshot: envelope("one_living_sources", 2, 1, []), data: structuredClone(projection) }));
  transport.soul.mockImplementation(async () => ({ markdown: soul?.markdown ?? "", persisted: Boolean(soul), ...(soul ? { dataVersion: soul.revision } : {}), deletedFactLabels: soul?.deletedFactLabels ?? [], syncStatus: "synced" }));
  transport.export.mockImplementation(async ({ scope }: { scope: string }) => {
    if (!identity) return { payload: {} };
    const path = scope.split(".").slice(2).join(".");
    if (!identity.paths.includes(path)) throw new Error("Approved scope changed; review required");
    return { payload: { identity: payload(path, atPath(identity.value, path)) }, sourceContentRevision: identity.revision, sourceManifestRevision: identity.manifestRevision };
  });
  transport.write.mockImplementation(async params => {
    await params.beforeEffect();
    const plan = await params.build({ currentDomainData: structuredClone(projection) });
    // Simulate the existing writer's durable round trip and its own doorbell.
    projection = JSON.parse(JSON.stringify(plan.domainData)); bumpPkmInvalidationEpoch(USER);
    return { success: true };
  });
});

describe("shared encrypted memory.md stable scope retrieval", () => {
  it("persists a profile-only name then reuses its exact source-linked slice without source decryption", async () => {
    const first = await retrieveApprovedMemoryScopes({ ...SESSION, approvedScopes: [NAME], ownerIdentity: { displayName: "Account Ava" } });
    expect(first.complete).toBe(true); expect(resultValue(first, NAME, "identity_profile.full_name")).toBe("Account Ava");
    expect(transport.write).toHaveBeenCalledTimes(1);
    expect(projection.retained_source).toBe("private original");
    expect((projection._private as Record<string, unknown>).inventory).toEqual({ complete: true });
    const stored = (projection._private as { memory_document: { document: unknown; scopeSlices: Record<string, unknown> } }).memory_document;
    expect(stored.document).toEqual({ markdown: "Full owner document", complete: true });
    expect(Object.keys(stored.scopeSlices)).toEqual([NAME]);
    transport.export.mockClear(); transport.soul.mockClear(); CacheService.getInstance().clear();
    const cold = await retrieveApprovedMemoryScopes({ ...SESSION, approvedScopes: [NAME], ownerIdentity: { displayName: "Account Ava" } });
    expect(cold.projections).toEqual(first.projections);
    expect(transport.export).not.toHaveBeenCalled(); expect(transport.soul).not.toHaveBeenCalled();
    expect(transport.snapshot).toHaveBeenCalledWith(expect.objectContaining({ domain: "one_memory", force: true }));
    const edited = await retrieveApprovedMemoryScopes({ ...SESSION, approvedScopes: [NAME], ownerIdentity: { displayName: "Updated account" } });
    expect(resultValue(edited, NAME, "identity_profile.full_name")).toBe("Updated account");
  });

  it("refreshes cold persisted age on the birthday without publishing DOB", async () => {
    soul = { revision: 9, markdown: "- Date of birth: 1998-10-13\n", deletedFactLabels: [] };
    const before = await retrieveApprovedMemoryScopes({ ...SESSION, approvedScopes: [AGE], now: new Date("2026-10-12T23:59:59Z") });
    expect(resultValue(before, AGE, "identity_profile.declared_age")).toBe("27");
    CacheService.getInstance().clear(); transport.export.mockClear(); transport.soul.mockClear();
    const after = await retrieveApprovedMemoryScopes({ ...SESSION, approvedScopes: [AGE], now: new Date("2026-10-13T00:00:00Z") });
    expect(resultValue(after, AGE, "identity_profile.declared_age")).toBe("28");
    expect(JSON.stringify(after.projections)).not.toContain("1998-10-13");
    expect(transport.soul).toHaveBeenCalledWith(expect.objectContaining({ forceRefresh: true }));
    expect(transport.write).toHaveBeenCalledTimes(2);
  });

  it("derives an approved age internally from canonical saved PKM DOB and suppresses deleted DOB", async () => {
    identity = { revision: 7, manifestRevision: 3, paths: ["identity_profile.declared_age", "identity_profile.date_of_birth"], value: { identity_profile: { declared_age: 999, date_of_birth: "1998-10-13" } } };
    const approved = await retrieveApprovedMemoryScopes({ ...SESSION, approvedScopes: [AGE], now: new Date("2026-10-13T00:00:00Z") });
    expect(resultValue(approved, AGE, "identity_profile.declared_age")).toBe("28");
    expect(transport.export).toHaveBeenCalledWith(expect.objectContaining({ scope: DOB }));
    expect(JSON.stringify(approved.projections)).not.toContain("1998-10-13");
    soul = { revision: 10, markdown: "", deletedFactLabels: ["date of birth"] };
    CacheService.getInstance().clear();
    const deleted = await retrieveApprovedMemoryScopes({ ...SESSION, approvedScopes: [AGE], now: new Date("2026-10-13T00:00:00Z") });
    expect(deleted.complete).toBe(true); expect(resultValue(deleted, AGE, "identity_profile.declared_age")).toBeUndefined();
  });

  it("invalid or missing DOB cannot make stored raw age chargeable", async () => {
    identity = { revision: 7, manifestRevision: 1, paths: ["identity_profile.declared_age"], value: { identity_profile: { declared_age: 46 } } };
    const absent = await retrieveApprovedMemoryScopes({ ...SESSION, approvedScopes: [AGE] });
    expect(absent.complete).toBe(true); expect(resultValue(absent, AGE, "identity_profile.declared_age")).toBeUndefined();
    soul = { revision: 10, markdown: "- Date of birth: 2026-02-31\n", deletedFactLabels: [] };
    const invalid = await retrieveApprovedMemoryScopes({ ...SESSION, approvedScopes: [AGE] });
    expect(invalid.complete).toBe(true); expect(resultValue(invalid, AGE, "identity_profile.declared_age")).toBeUndefined();
  });

  it("refreshes corrected/deleted explicit facts and does not infer sex from an account", async () => {
    soul = { revision: 9, markdown: "- Legal name: Legal Ava\n- Sex: entered value\n", deletedFactLabels: [] };
    const first = await retrieveApprovedMemoryScopes({ ...SESSION, approvedScopes: [NAME, SEX], ownerIdentity: { displayName: "Account Ava" } });
    expect(resultValue(first, NAME, "identity_profile.full_name")).toBe("Legal Ava"); expect(resultValue(first, SEX, "identity_profile.sex")).toBe("entered value");
    soul = { revision: 10, markdown: "- Legal name: Corrected Ava\n", deletedFactLabels: ["sex"] };
    const corrected = await retrieveApprovedMemoryScopes({ ...SESSION, approvedScopes: [NAME, SEX], ownerIdentity: { displayName: "Account Ava" } });
    expect(resultValue(corrected, NAME, "identity_profile.full_name")).toBe("Corrected Ava"); expect(resultValue(corrected, SEX, "identity_profile.sex")).toBeUndefined();
    expect(corrected.projections.find(item => item.scope === NAME)?.contentRevision).toBe(10);
  });

  it("never turns a failed revision check or failed DOB read into cached absence", async () => {
    await retrieveApprovedMemoryScopes({ ...SESSION, approvedScopes: [SEX] });
    transport.snapshot.mockRejectedValueOnce(new Error("network read failed"));
    const failed = await retrieveApprovedMemoryScopes({ ...SESSION, approvedScopes: [SEX] });
    expect(failed).toMatchObject({ complete: false, unavailableScopes: [SEX], projections: [] });
    identity = { revision: 7, manifestRevision: 1, paths: ["identity_profile.declared_age", "identity_profile.date_of_birth"], value: { identity_profile: { declared_age: 46, date_of_birth: "1980-01-01" } } };
    const ordinary = transport.export.getMockImplementation()!;
    transport.export.mockImplementation(async params => { if (params.scope === DOB) throw new Error("DOB decrypt failed"); return ordinary(params); });
    const unreadable = await retrieveApprovedMemoryScopes({ ...SESSION, approvedScopes: [AGE] });
    expect(unreadable).toMatchObject({ complete: false, unavailableScopes: [AGE] });
  });

  it("keeps pending local edits and vault changes unavailable", async () => {
    await retrieveApprovedMemoryScopes({ ...SESSION, approvedScopes: [NAME], ownerIdentity: { displayName: "Ava" } });
    transport.peek.mockReturnValue({ syncStatus: "saving" });
    const pending = await retrieveApprovedMemoryScopes({ ...SESSION, approvedScopes: [NAME], ownerIdentity: { displayName: "Ava" } });
    expect(pending.complete).toBe(false); expect(pending.projections).toEqual([]);
    transport.peek.mockReturnValue(undefined);
    transport.load.mockImplementationOnce(async () => { advanceVaultSessionEpoch(); return { snapshot: null, data: null }; });
    const locked = await retrieveApprovedMemoryScopes({ ...SESSION, approvedScopes: [NAME] });
    expect(locked.projections).toEqual([]); expect(locked.complete).toBe(false);
  });

  it("rechecks current exposure posture and never lets a Soul fallback bypass an exact blocked scope", async () => {
    identity = { revision: 7, manifestRevision: 1, paths: ["identity_profile.sex"], value: { identity_profile: { sex: "entered value" } } };
    soul = { revision: 9, markdown: "- Sex: entered value\n", deletedFactLabels: [] };
    expect((await retrieveApprovedMemoryScopes({ ...SESSION, approvedScopes: [SEX] })).complete).toBe(true);
    identity.blocked = ["identity_profile.sex"]; identity.manifestRevision += 1;
    transport.export.mockClear();
    const changed = await retrieveApprovedMemoryScopes({ ...SESSION, approvedScopes: [SEX] });
    expect(changed).toMatchObject({ complete: false, unavailableScopes: [SEX], projections: [] });
    expect(transport.export).not.toHaveBeenCalled();
  });

  it("does not mistake a concurrent authoritative mutation for its own derived projection write", async () => {
    soul = { revision: 9, markdown: "- Sex: entered value\n", deletedFactLabels: [] };
    const ordinary = transport.write.getMockImplementation()!;
    transport.write.mockImplementationOnce(async params => {
      const saved = await ordinary(params);
      soul!.revision += 1; soul!.markdown = "- Sex: changed during write\n";
      return saved;
    });
    const changed = await retrieveApprovedMemoryScopes({ ...SESSION, approvedScopes: [SEX] });
    expect(changed).toMatchObject({ complete: false, unavailableScopes: [SEX], projections: [] });
    const retried = await retrieveApprovedMemoryScopes({ ...SESSION, approvedScopes: [SEX] });
    expect(retried.complete).toBe(true); expect(resultValue(retried, SEX, "identity_profile.sex")).toBe("changed during write");
  });

  it("fences local saves and remote corrections or manifest changes after composition begins", async () => {
    soul = { revision: 9, markdown: "- Sex: entered value\n", deletedFactLabels: [] };
    const prepared = await retrieveApprovedMemoryScopes({ ...SESSION, approvedScopes: [SEX] });
    // A successful shared projection write must not reject its own guard.
    await expect(prepared.assertCurrent()).resolves.toBeUndefined();
    soul.revision += 1; soul.markdown = ""; soul.deletedFactLabels = ["sex"];
    await expect(prepared.assertCurrent()).rejects.toThrow("Authoritative memory changed");
    const deleted = await retrieveApprovedMemoryScopes({ ...SESSION, approvedScopes: [SEX] });
    await expect(deleted.assertCurrent()).resolves.toBeUndefined();
    transport.peek.mockReturnValue({ syncStatus: "saving" });
    await expect(deleted.assertCurrent()).rejects.toThrow("readback pending");
    transport.peek.mockReturnValue(undefined);
    bumpPkmInvalidationEpoch(USER);
    await expect(deleted.assertCurrent()).rejects.toThrow("Memory sources changed");
    identity = { revision: 7, manifestRevision: 1, paths: ["identity_profile.sex"], value: { identity_profile: { sex: "old stored value" } } };
    const current = await retrieveApprovedMemoryScopes({ ...SESSION, approvedScopes: [SEX] });
    identity.manifestRevision += 1; identity.blocked = ["identity_profile.sex"];
    await expect(current.assertCurrent()).rejects.toThrow("Authoritative memory changed");
  });

  it("refuses to stage when final source reads fail or the vault locks", async () => {
    soul = { revision: 9, markdown: "- Sex: entered value\n", deletedFactLabels: [] };
    const prepared = await retrieveApprovedMemoryScopes({ ...SESSION, approvedScopes: [SEX] });
    transport.snapshot.mockRejectedValueOnce(new Error("final metadata unavailable"));
    await expect(prepared.assertCurrent()).rejects.toThrow("final metadata unavailable");
    advanceVaultSessionEpoch();
    await expect(prepared.assertCurrent()).rejects.toThrow("Memory sources changed");
  });

  it("revalidates canonical account fallback and rejects an edited name or deleted photo", async () => {
    const photoScope = "attr.identity.identity_profile.profile_photo_url";
    let account: { displayName: string; photoUrl: string | null } | null = { displayName: "Account Ava", photoUrl: "https://example.test/current-avatar.png" };
    const readOwnerIdentity = vi.fn(async () => account);
    const prepared = await retrieveApprovedMemoryScopes({ ...SESSION, approvedScopes: [NAME, photoScope], ownerIdentity: account, readOwnerIdentity });
    await expect(prepared.assertCurrent()).resolves.toBeUndefined();
    expect(readOwnerIdentity).toHaveBeenCalledTimes(1);
    account = { displayName: "Updated account", photoUrl: "https://example.test/current-avatar.png" };
    await expect(prepared.assertCurrent()).rejects.toThrow("Account identity changed");
    account = { displayName: "Account Ava", photoUrl: null };
    await expect(prepared.assertCurrent()).rejects.toThrow("Account identity changed");
    account = null;
    await expect(prepared.assertCurrent()).rejects.toThrow("Canonical account freshness unavailable");
  });

  it("will not stage yesterday's derived age across a UTC birthday during model work", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-10-12T23:59:59Z"));
      soul = { revision: 9, markdown: "- Date of birth: 1998-10-13\n", deletedFactLabels: [] };
      const prepared = await retrieveApprovedMemoryScopes({ ...SESSION, approvedScopes: [AGE] });
      expect(resultValue(prepared, AGE, "identity_profile.declared_age")).toBe("27");
      vi.setSystemTime(new Date("2026-10-13T00:00:00Z"));
      await expect(prepared.assertCurrent()).rejects.toThrow("Age changed before staging");
    } finally { vi.useRealTimers(); }
  });

  it("Live Memory inventory cannot make a paid scope chargeable", async () => {
    // The owner-only inventory, its observed history and the derived preview
    // share the encrypted projection that stores paid slices. Only identity
    // and Soul may supply a paid value or its completeness.
    const at = "2026-10-15T08:00:00.000Z";
    const owned = projection._private as Record<string, Record<string, unknown>>;
    owned.inventory = { complete: false, unavailable: ["consent"], observedAt: at, verifiedAt: { profile: at },
      records: [{ kind: "profile", id: USER, value: { display_name: "Inventory Ava" }, revision: 3, createdAt: null, updatedAt: at, capturedAt: at, deletedAt: null }] };
    owned.observed_history = { nextSequence: 2, firstRetainedSequence: 1, truncatedAt: null,
      changes: [{ sequence: 1, kind: "profile", id: USER, revision: 3, operation: "upsert", capturedAt: at, sourceUpdatedAt: at, value: { display_name: "Inventory Ava" } }] };
    owned.memory_document.document = { markdown: "- Name: Inventory Ava\n- Sex: inventory value\n", complete: false };
    identity = { revision: 7, manifestRevision: 1, paths: ["identity_profile.full_name", "identity_profile.sex"], value: { identity_profile: { full_name: "Identity Ava", sex: "identity value" } } };
    const ordinaryExport = transport.export.getMockImplementation()!;
    const ordinarySoul = transport.soul.getMockImplementation()!;
    transport.export.mockRejectedValue(new Error("identity read failed"));
    transport.soul.mockRejectedValue(new Error("Soul read failed"));
    const failed = await retrieveApprovedMemoryScopes({ ...SESSION, approvedScopes: [NAME, SEX] });
    // The inventory was in the same read, so this cannot pass vacuously.
    expect(transport.load).toHaveBeenCalledWith(expect.objectContaining({ domain: "one_living_sources" }));
    expect(failed).toMatchObject({ complete: false, unavailableScopes: [NAME, SEX], projections: [] });
    expect(JSON.stringify(failed)).not.toContain("Inventory Ava");
    expect(answerScopeAvailability({ scopes: [NAME, SEX], retrieval: failed }).available).toEqual([]);

    // Positive control: the same incomplete inventory neither blocks nor feeds a healthy identity read.
    transport.export.mockImplementation(ordinaryExport);
    transport.soul.mockImplementation(ordinarySoul);
    const served = await retrieveApprovedMemoryScopes({ ...SESSION, approvedScopes: [NAME, SEX] });
    expect(served.complete).toBe(true);
    expect(resultValue(served, NAME, "identity_profile.full_name")).toBe("Identity Ava");
    expect(resultValue(served, SEX, "identity_profile.sex")).toBe("identity value");
    expect(JSON.stringify(served)).not.toContain("Inventory Ava");
    expect(Object.values(served.sourceFreshness).flatMap(entry => entry.sources.map(source => source.domain))).not.toContain("one_living_sources");
    expect(answerScopeAvailability({ scopes: [NAME, SEX], retrieval: served }).available).toEqual([NAME, SEX]);
  });
});

it("unrelated projection writes do not invalidate a narrow current fact", async () => {
  const answer = await retrieveApprovedMemoryScopes({ ...SESSION, approvedScopes: [NAME], ownerIdentity: { displayName: "Synthetic Ava" }, readOwnerIdentity: async () => ({ displayName: "Synthetic Ava" }) });
  expect(answer.complete).toBe(true);
  bumpPkmInvalidationEpoch(USER, "one_living_sources");
  bumpPkmInvalidationEpoch(USER, "financial");
  await expect(answer.assertCurrent()).resolves.toBeUndefined();
  bumpPkmInvalidationEpoch(USER, "identity");
  await expect(answer.assertCurrent()).rejects.toThrow();
});
