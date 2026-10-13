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
vi.mock("@/lib/pkm/markdown-memory", () => ({
  loadMarkdownMemory: (...a: unknown[]) => loadMarkdownMemory(...a),
}));
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
  buildConsentExportForScope.mockReset();
  getStaleFirst.mockReset();
  answerable.mockReset();
  compose.mockReset();
  deliver.mockReset();
  loadMarkdownMemory.mockReset();
  loadMarkdownMemory.mockResolvedValue(null);
  encrypt.mockReset().mockResolvedValue({ sealed: "ciphertext" });
  compose.mockResolvedValue({ answerMode: "projection", answer: null });
  deliver.mockResolvedValue(undefined);
}
