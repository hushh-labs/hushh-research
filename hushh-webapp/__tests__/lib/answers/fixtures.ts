import { vi } from "vitest";
import type { AnswerableWork } from "@/lib/services/answer-request-service";

export const buildConsentExportForScope = vi.fn();
vi.mock("@/lib/consent/export-builder", () => ({
  createConsentExportReadSession: () => undefined,
  buildConsentExportForScope: (...args: unknown[]) =>
    buildConsentExportForScope(...args),
}));
// Reading a whole PKM domain is the bug this file exists to prevent. If the
// sweep ever reaches for the domain resource again, this mock records it.
export const getStaleFirst = vi.fn();
vi.mock("@/lib/pkm/pkm-domain-resource", () => ({
  PkmDomainResourceService: {
    getStaleFirst: (...a: unknown[]) => getStaleFirst(...a),
  },
}));

export const answerable = vi.fn();
export const compose = vi.fn();
export const deliver = vi.fn();
vi.mock("@/lib/services/answer-request-service", () => ({
  AnswerRequestService: {
    answerable: (...a: unknown[]) => answerable(...a),
    compose: (...a: unknown[]) => compose(...a),
    deliver: (...a: unknown[]) => deliver(...a),
  },
}));
export const loadMarkdownMemory = vi.fn();
export const refreshIdentityForSession = vi.fn();
vi.mock("@/lib/services/account-identity-service", () => ({
  AccountIdentityService: { refreshIdentityForSession: (...args: unknown[]) => refreshIdentityForSession(...args) },
}));
vi.mock("@/lib/pkm/markdown-memory", () => ({
  loadMarkdownMemory: (...a: unknown[]) => loadMarkdownMemory(...a),
  peekMarkdownMemory: () => undefined,
}));
let exportedRevision: number | null = 7;
let exportedManifestRevision: number | null = null;
let soulRevision: number | null = null;
vi.mock("@/lib/pkm/memory-document-store", () => ({
  readMemoryDocumentProjection: async () => null,
  readMemoryScopeSourceRevisions: async ({ domains }: { domains: string[] }) => Object.fromEntries(domains.map(domain => [domain, {
    domain, contentRevision: domain === "one_memory" ? soulRevision : exportedRevision,
    manifestRevision: domain === "one_memory" ? null : exportedManifestRevision,
    manifestFingerprint: null, absent: domain === "one_memory" ? soulRevision === null : exportedRevision === null,
    readablePaths: [], hasCanonicalDob: false,
  }])),
  persistMemoryScopeSlices: async ({ beforeEffect }: { beforeEffect: () => Promise<void> }) => beforeEffect(),
}));

export function setSoulMemory(memory: { markdown: string; dataVersion?: number; [key: string]: unknown } | null) {
  soulRevision = memory?.dataVersion ?? null;
  loadMarkdownMemory.mockResolvedValue(memory);
}

export function setScopeProjection(projection: { payload: Record<string, unknown>; sourceContentRevision?: number; sourceManifestRevision?: number }) {
  exportedRevision = projection.sourceContentRevision ?? 7;
  exportedManifestRevision = projection.sourceManifestRevision ?? null;
  buildConsentExportForScope.mockResolvedValue(projection);
}
export const encrypt = vi.fn();
vi.mock("@/lib/one-marketplace/encryption", () => ({
  encryptSliceForRecipient: (...a: unknown[]) => encrypt(...a),
}));
export const work = (overrides: Partial<AnswerableWork> = {}): AnswerableWork => ({
  requestId: "11111111-2222-3333-4444-555555555555",
  question: "How much did you spend on travel last year?",
  periodStart: null,
  periodEnd: null,
  approvedScopes: ["attr.travel.trips"],
  scopeLabels: {},
  answerDeadlineAt: null,
  requesterUserId: "requester-B",
  recipientKey: { keyId: "key-1", publicKeyJwk: {} as JsonWebKey },
  ...overrides,
});

export const params = { userId: "owner-A", vaultKey: "key", vaultOwnerToken: "token" };

export function resetAnswerFixture() {
  exportedRevision = 7;
  exportedManifestRevision = null;
  soulRevision = null;
  buildConsentExportForScope.mockReset();
  getStaleFirst.mockReset();
  answerable.mockReset();
  compose.mockReset();
  deliver.mockReset();
  loadMarkdownMemory.mockReset();
  refreshIdentityForSession.mockReset().mockResolvedValue({
    user_id: "owner-A", display_name: "Synthetic Ava", photo_url: "https://example.test/avatar.jpg",
  });
  setSoulMemory(null);
  encrypt.mockReset().mockResolvedValue({ sealed: "ciphertext" });
  compose.mockResolvedValue({ answerMode: "projection", answer: null });
  deliver.mockResolvedValue(undefined);
}
