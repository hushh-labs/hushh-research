// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
const state = vi.hoisted(() => ({ token: vi.fn(), load: vi.fn(), fetch: vi.fn() }));
vi.mock("@/lib/services/auth-service", () => ({ AuthService: { getIdTokenWithRetry: state.token } }));
vi.mock("@/lib/services/api-service", () => ({ ApiService: { apiFetch: vi.fn() } }));
vi.mock("@/lib/services/personal-knowledge-model-service", () => ({ PersonalKnowledgeModelService: { loadDomainData: state.load } }));
vi.mock("@/lib/services/pkm-write-coordinator", () => ({ PkmWriteCoordinator: { saveMergedDomain: vi.fn() } }));
import { CareerService } from "@/lib/services/career-service";
import { CareerPkmService } from "@/lib/services/career-pkm-service";
import { advanceVaultSessionEpoch } from "@/lib/vault/session-epoch";
const application = { expectedUserId: "synthetic-owner", role: { family: "vacancy" as const, slug: "synthetic-role" }, firstName: "Synthetic", lastName: "Candidate", location: "Synthetic location", resumeText: "Synthetic resume", links: {}, consentReceiptId: "synthetic-receipt" };
beforeEach(() => { vi.clearAllMocks(); vi.stubGlobal("fetch", state.fetch); state.fetch.mockResolvedValue(new Response(JSON.stringify({ reference: "synthetic-reference" }), { status: 200 })); });
afterEach(() => vi.unstubAllGlobals());
it("pins the application token to the originating owner and preserves the request contract", async () => {
  state.token.mockResolvedValue("synthetic-token");
  await expect(CareerService.applyToRole(application)).resolves.toMatchObject({ reference: "synthetic-reference" });
  expect(state.token).toHaveBeenCalledExactlyOnceWith({ expectedUserId: "synthetic-owner" });
  const request = state.fetch.mock.calls[0]![1];
  expect(JSON.parse(request.body)).toMatchObject({ resume_text: "Synthetic resume", candidate_consent: true, consent_receipt_id: "synthetic-receipt" });
});
it("does not POST when the vault session changes while token acquisition is pending", async () => {
  let release!: (token: string) => void;
  state.token.mockReturnValue(new Promise(resolve => { release = resolve; }));
  const pending = CareerService.applyToRole(application);
  advanceVaultSessionEpoch(); release("synthetic-old-owner-token");
  await expect(pending).rejects.toThrow("Your session changed");
  expect(state.fetch).not.toHaveBeenCalled();
});
it("distinguishes an absent professional domain from a failed encrypted read", async () => {
  const owner = { userId: "synthetic-owner", vaultKey: "synthetic-key", vaultOwnerToken: "synthetic-token" };
  state.load.mockResolvedValueOnce(null).mockRejectedValueOnce(new Error("synthetic read failure"));
  await expect(CareerPkmService.load(owner)).resolves.toEqual({ resume: null, applications: [] });
  await expect(CareerPkmService.load(owner)).rejects.toThrow("synthetic read failure");
});
