import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  load: vi.fn(), stage: vi.fn(), prepare: vi.fn(), legacy: vi.fn(), structuredWrite: vi.fn(),
}));
vi.mock("@/lib/pkm/markdown-memory", () => ({
  loadMarkdownMemory: mocks.load, stageMarkdownMemoryFacts: mocks.stage, MARKDOWN_MEMORY_DOMAIN: "one_memory",
  peekMarkdownMemory: () => null, recoverMarkdownMemorySync: async () => {},
  markdownFactsFromCards: (cards: Array<{ source_text: string; write_mode?: string; preview_degraded?: boolean }>) =>
    cards.filter(card => card.write_mode !== "do_not_save" && !card.preview_degraded)
      .map(card => ({ text: card.source_text, section: "Facts" })),
}));
vi.mock("@/lib/pkm/pkm-natural-language-ingestion", async importOriginal => ({
  ...await importOriginal<typeof import("@/lib/pkm/pkm-natural-language-ingestion")>(),
  prepareNaturalLanguagePkm: mocks.prepare,
}));
vi.mock("@/lib/pkm/pkm-domain-resource", () => ({ PkmDomainResourceService: { getStaleFirst: mocks.legacy } }));
vi.mock("@/lib/services/pkm-write-coordinator", () => ({ PkmWriteCoordinator: { saveMergedDomain: mocks.structuredWrite } }));

import { KycIdentityProfilePkmService, isKycIdentityPrefaceComplete, isValidDateOfBirth } from "@/lib/services/kyc-identity-profile-pkm-service";
import { publishValidatedAuthSessionOwner } from "@/lib/auth/session-owner";

const session = { userId: "user_1", vaultKey: "vault-key", vaultOwnerToken: "owner-token" };

describe("KYC intake uses only Soul.md personal memory", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    publishValidatedAuthSessionOwner("user_1");
    mocks.load.mockResolvedValue({ markdown: "# Soul.md\n", persisted: true });
    mocks.stage.mockResolvedValue({ success: true, saved: 1, markdown: "# Soul.md\n- A synthetic fact.\n" });
    mocks.prepare.mockResolvedValue({ cards: [{ source_text: "Studies engineering at Example University.", write_mode: "confirm_first" }] });
    mocks.legacy.mockResolvedValue(null);
  });

  it("recognizes retained legacy intake markers without rewriting their records", () => {
    expect(isKycIdentityPrefaceComplete({ freeform_import_completed_at: "2026-08-20T00:00:00Z" })).toBe(true);
    expect(isKycIdentityPrefaceComplete({ about_me: "legacy profile" })).toBe(true);
    expect(isKycIdentityPrefaceComplete({ about_me: "" })).toBe(false);
  });

  it("accepts only real past dates and refuses an invalid date before any effect", async () => {
    expect(isValidDateOfBirth("2000-02-29", new Date("2026-08-03"))).toBe(true);
    expect(isValidDateOfBirth("2099-01-01", new Date("2026-08-03"))).toBe(false);
    await expect(KycIdentityProfilePkmService.saveProfile({ ...session, profile: { dateOfBirth: "2099-01-01" } })).rejects.toThrow("past date");
    expect(mocks.load).not.toHaveBeenCalled();
    expect(mocks.stage).not.toHaveBeenCalled();
  });

  it("prepares imported facts then stages one flat document, without any structured-domain writes", async () => {
    await expect(KycIdentityProfilePkmService.saveProfile({
      ...session, profile: { legalName: "Example Person", aboutMe: "I study engineering at Example University." },
    })).resolves.toMatchObject({ success: true, message: expect.stringContaining("memory.md") });
    expect(mocks.prepare).toHaveBeenCalledWith(expect.objectContaining({
      currentDomains: ["one_memory"], currentManifests: [], source: "kyc_identity_onboarding",
    }));
    expect(mocks.stage).toHaveBeenCalledWith(expect.objectContaining({
      facts: ["Legal name: Example Person", { text: "Studies engineering at Example University.", section: "Facts" }],
      completeKycIntake: true,
    }));
    expect(mocks.structuredWrite).not.toHaveBeenCalled();
    expect(mocks.legacy).not.toHaveBeenCalled();
  });

  it("keeps eligible identity numbers locally while preventing passwords from entering model preparation or memory", async () => {
    const password = ["test-password-", "not-real"].join("");
    const passport = ["X", "1234567"].join("");
    const source = `My passport number is ${passport}. My password is ${password}. I study engineering.`;
    await KycIdentityProfilePkmService.saveProfile({ ...session, profile: { aboutMe: source } });
    const request = mocks.prepare.mock.calls[0]![0];
    expect(request.message).not.toContain(passport);
    expect(request.message).not.toContain(password);
    const staged = JSON.stringify(mocks.stage.mock.calls[0]![0].facts);
    expect(staged).toContain(passport);
    expect(staged).not.toContain(password);
  });

  it("does not complete intake when no usable facts or only degraded proposals were prepared", async () => {
    mocks.prepare.mockResolvedValue({ cards: [{ source_text: "Fallback fact.", preview_degraded: true }] });
    await expect(KycIdentityProfilePkmService.saveProfile({ ...session, profile: { aboutMe: "Thanks for helping." } }))
      .resolves.toMatchObject({ success: false, message: expect.stringContaining("No private details") });
    expect(mocks.stage).not.toHaveBeenCalled();
  });

  it("rejects an owner change while extraction is pending, before staging facts", async () => {
    let finish!: (value: unknown) => void;
    mocks.prepare.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const saving = KycIdentityProfilePkmService.saveProfile({ ...session, profile: { aboutMe: "I study engineering." } });
    await vi.waitFor(() => expect(finish).toBeDefined());
    publishValidatedAuthSessionOwner("other-owner");
    finish({ cards: [{ source_text: "Studies engineering." }] });
    await expect(saving).rejects.toThrow("session changed");
    expect(mocks.stage).not.toHaveBeenCalled();
  });

  it("does not complete or partially save mixed typed fields and an incomplete freeform import", async () => {
    mocks.prepare.mockResolvedValueOnce({ cards: [], previews: [], sourceCoverage: [{
      sourceBlockId: "synthetic", disposition: "failed", detectedFactCount: 1, accountedFactCount: 0,
    }] });
    await expect(KycIdentityProfilePkmService.saveProfile({ ...session,
      profile: { legalName: "Example Person", aboutMe: "A longer imported profile." },
    })).resolves.toMatchObject({ success: false, message: expect.stringContaining("full summary") });
    expect(mocks.stage).not.toHaveBeenCalled();
  });

  it("reads new intake completion from Soul and uses legacy records only for their old completion signal", async () => {
    mocks.load.mockResolvedValueOnce({ markdown: "# Soul.md\n", kycIntakeCompletedAt: "2026-10-12T00:00:00Z" });
    expect(await KycIdentityProfilePkmService.hasCompletedIntake(session)).toBe(true);
    expect(mocks.legacy).not.toHaveBeenCalled();
    mocks.legacy.mockResolvedValueOnce({ data: { identity_profile: { about_me: "Legacy information" } } });
    expect(await KycIdentityProfilePkmService.hasCompletedIntake(session)).toBe(true);
    expect(mocks.structuredWrite).not.toHaveBeenCalled();
    mocks.load.mockRejectedValueOnce(new Error("Unavailable"));
    await expect(KycIdentityProfilePkmService.hasCompletedIntake(session)).rejects.toThrow("Unavailable");
    expect(mocks.legacy).toHaveBeenCalledOnce();
  });
});
