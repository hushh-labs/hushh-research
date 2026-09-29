import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { apiJsonMock, nativePlatform } = vi.hoisted(() => ({
  apiJsonMock: vi.fn(),
  nativePlatform: { current: false },
}));

vi.mock("@capacitor/core", () => ({
  Capacitor: { isNativePlatform: () => nativePlatform.current },
}));
vi.mock("@/lib/services/api-client", () => ({ apiJson: apiJsonMock }));

import {
  currentLegalDocumentVersions,
  LegalAcceptanceService,
} from "@/lib/services/legal-acceptance-service";
import { LEGAL_DOCUMENTS } from "@/lib/legal/legal-documents";

function user(uid: string) {
  return { uid, getIdToken: vi.fn().mockResolvedValue(`token-${uid}`) };
}

type StoredAcceptance = { document_id: string; document_version: string; effective_date: string };

// The server answers GET with the person's latest acceptance of each document.
function serverWith(stored: StoredAcceptance[] | Error) {
  apiJsonMock.mockImplementation(async (_path: string, init: RequestInit) => {
    if (init.method === "GET") {
      if (stored instanceof Error) throw stored;
      return { acceptances: stored };
    }
    return { acceptances: [] };
  });
}

function posts() {
  return apiJsonMock.mock.calls.filter(([, init]) => init.method === "POST");
}

const current = () =>
  (["terms", "privacy"] as const).map((id) => ({
    document_id: id,
    document_version: LEGAL_DOCUMENTS[id].version,
    effective_date: LEGAL_DOCUMENTS[id].lastUpdated,
  }));

type Bridge = { __HUSHH_NATIVE_TEST__?: Record<string, unknown> };

// The sign-in screen's "By continuing you agree to our Terms and Privacy
// Policy" is the acceptance. It is recorded silently on a successful sign-in;
// nothing re-prompts afterwards.
describe("LegalAcceptanceService.recordSignInAcceptance", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    nativePlatform.current = false;
  });

  it("records the served Terms and Privacy versions for a person with no acceptance", async () => {
    serverWith([]);

    await LegalAcceptanceService.recordSignInAcceptance(user("user-web"));

    expect(posts()).toHaveLength(1);
    const [requestPath, init] = posts()[0];
    expect(requestPath).toBe("/api/account/legal-acceptance");
    expect(init.method).toBe("POST");
    expect(init.headers).toMatchObject({ Authorization: "Bearer token-user-web" });
    expect(JSON.parse(String(init.body))).toEqual({
      documents: currentLegalDocumentVersions(),
      surface: "web",
    });
    expect(currentLegalDocumentVersions()).toEqual([
      {
        document_id: "terms",
        document_version: LEGAL_DOCUMENTS.terms.version,
        effective_date: LEGAL_DOCUMENTS.terms.lastUpdated,
      },
      {
        document_id: "privacy",
        document_version: LEGAL_DOCUMENTS.privacy.version,
        effective_date: LEGAL_DOCUMENTS.privacy.lastUpdated,
      },
    ]);
  });

  it("labels a native sign-in as native", async () => {
    nativePlatform.current = true;
    serverWith([]);

    await LegalAcceptanceService.recordSignInAcceptance(user("user-native"));

    expect(JSON.parse(String(posts()[0][1].body)).surface).toBe("native");
  });

  it("makes no write when the person already accepted the served versions", async () => {
    serverWith(current());

    await LegalAcceptanceService.recordSignInAcceptance(user("user-current"));

    expect(apiJsonMock).toHaveBeenCalledTimes(1);
    expect(apiJsonMock.mock.calls[0][1].method).toBe("GET");
    expect(posts()).toHaveLength(0);
  });

  it("records the served versions when the person accepted an earlier one", async () => {
    serverWith(current().map((doc, index) =>
      index === 0 ? { ...doc, document_version: "1.0", effective_date: "2026-01-01" } : doc));

    await LegalAcceptanceService.recordSignInAcceptance(user("user-older"));

    expect(posts()).toHaveLength(1);
    expect(JSON.parse(String(posts()[0][1].body)).documents).toEqual(currentLegalDocumentVersions());
  });

  it("still records when the acceptance read fails, since the write is idempotent", async () => {
    serverWith(new Error("read unavailable"));

    await LegalAcceptanceService.recordSignInAcceptance(user("user-read-failed"));

    expect(posts()).toHaveLength(1);
  });

  it("never throws, so a failed write cannot block sign-in", async () => {
    apiJsonMock.mockRejectedValue(new Error("offline"));

    await expect(
      LegalAcceptanceService.recordSignInAcceptance(user("user-offline")),
    ).resolves.toBeUndefined();
  });

  // The read-only reviewer harness refuses any state-changing request. The UAT
  // BYOK rehearsal reported POST /api/account/legal-acceptance on every run
  // from 2026-09-28 until this guard existed.
  describe("reviewer automation posture", () => {
    const target = window as unknown as Bridge;
    let original: Bridge["__HUSHH_NATIVE_TEST__"];
    beforeEach(() => { original = target.__HUSHH_NATIVE_TEST__; });
    afterEach(() => { target.__HUSHH_NATIVE_TEST__ = original; });

    it.each(["read_only", "preparation_only", "bounded_mutation"])(
      "a %s reviewer session makes no acceptance request",
      async (policy) => {
        target.__HUSHH_NATIVE_TEST__ = {
          enabled: true, autoReviewerLogin: true, expectedUserId: "reviewer", reviewerMutationPolicy: policy,
        };
        serverWith([]);

        await LegalAcceptanceService.recordSignInAcceptance(user("reviewer"));

        expect(apiJsonMock).not.toHaveBeenCalled();
      },
    );

    // Negative control: the same fixture with explicit mutation authority is
    // not read-only, so its missing acceptance is recorded.
    it("a mutation-authorized reviewer session still records a missing acceptance", async () => {
      target.__HUSHH_NATIVE_TEST__ = {
        enabled: true, autoReviewerLogin: true, expectedUserId: "reviewer", reviewerMutationPolicy: "mutation_authorized",
      };
      serverWith([]);

      await LegalAcceptanceService.recordSignInAcceptance(user("reviewer"));

      expect(posts()).toHaveLength(1);
    });
  });
});
