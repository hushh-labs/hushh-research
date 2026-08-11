import { describe, expect, it, vi } from "vitest";

// The one URL rule lives in the service and is exercised by its own suite.
// Mocking it here keeps this suite about the owner draft: pre-fill, limits,
// and the projection onto the server payload.
vi.mock("@/lib/services/wallet-card-service", () => ({
  isAllowedWalletCardUrl: (value: string) => value.startsWith("https://"),
}));

const {
  EMPTY_WALLET_CARD_DRAFT,
  WALLET_CARD_MAX_SKILLS,
  buildSmartDefaultDraft,
  describeSharedFields,
  draftFromPayload,
  draftToPayload,
  hasValidationErrors,
  splitSkills,
  validateDraft,
} = await import("@/components/wallet-card/wallet-card-fields");

describe("wallet card smart defaults", () => {
  it("pre-fills from information the product already holds", () => {
    const draft = buildSmartDefaultDraft({
      displayName: "  Ada Lovelace  ",
      email: "ada@example.com",
      phoneNumber: "+91 99999 90000",
    });

    expect(draft.fullName).toBe("Ada Lovelace");
    expect(draft.email).toBe("ada@example.com");
    expect(draft.phone).toBe("+91 99999 90000");
    expect(draft.preferredContact).toBe("email");
  });

  it("falls back to phone when there is no email on the account", () => {
    expect(
      buildSmartDefaultDraft({ displayName: "Ada", phoneNumber: "+91 99999 90000" })
        .preferredContact,
    ).toBe("phone");
  });

  it("invents nothing when the account has nothing to offer", () => {
    expect(buildSmartDefaultDraft({})).toEqual(EMPTY_WALLET_CARD_DRAFT);
  });
});

describe("wallet card draft validation", () => {
  it("accepts a draft made only of smart defaults", () => {
    const draft = buildSmartDefaultDraft({
      displayName: "Ada Lovelace",
      email: "ada@example.com",
    });

    expect(hasValidationErrors(validateDraft(draft))).toBe(false);
  });

  it("rejects a malformed email and phone", () => {
    expect(
      validateDraft({ ...EMPTY_WALLET_CARD_DRAFT, email: "not an email" }).email,
    ).toBeTruthy();
    expect(
      validateDraft({
        ...EMPTY_WALLET_CARD_DRAFT,
        preferredContact: "phone",
        phone: "call me",
      }).phone,
    ).toBeTruthy();
  });

  it("rejects links that are not https", () => {
    const errors = validateDraft({
      ...EMPTY_WALLET_CARD_DRAFT,
      email: "ada@example.com",
      website: "javascript:alert(1)",
      linkedin: "http://linkedin.com/in/ada",
    });

    expect(errors.website).toBeTruthy();
    expect(errors.linkedin).toBeTruthy();
  });

  it("enforces the per-field length caps", () => {
    expect(
      validateDraft({ ...EMPTY_WALLET_CARD_DRAFT, fullName: "a".repeat(81) }).fullName,
    ).toBeTruthy();
    expect(
      validateDraft({ ...EMPTY_WALLET_CARD_DRAFT, fullName: "a".repeat(80) }).fullName,
    ).toBeUndefined();
    expect(
      validateDraft({ ...EMPTY_WALLET_CARD_DRAFT, summary: "s".repeat(401) }).summary,
    ).toBeTruthy();
  });

  it("caps skills at twelve entries of forty characters", () => {
    const tooMany = Array.from({ length: WALLET_CARD_MAX_SKILLS + 1 }, (_, i) => `s${i}`);
    expect(
      validateDraft({ ...EMPTY_WALLET_CARD_DRAFT, skills: tooMany.join(", ") }).skills,
    ).toBeTruthy();
    expect(
      validateDraft({ ...EMPTY_WALLET_CARD_DRAFT, skills: "x".repeat(41) }).skills,
    ).toBeTruthy();
  });

  it("will not let the preferred contact point at an empty field", () => {
    const errors = validateDraft({
      ...EMPTY_WALLET_CARD_DRAFT,
      preferredContact: "linkedin",
    });

    expect(errors.preferredContact).toBeTruthy();
  });
});

describe("wallet card payload projection", () => {
  it("omits empty values instead of storing blanks", () => {
    const payload = draftToPayload({
      ...EMPTY_WALLET_CARD_DRAFT,
      fullName: "  Ada Lovelace  ",
      email: "ada@example.com",
    });

    expect(payload).toEqual({
      full_name: "Ada Lovelace",
      email: "ada@example.com",
      preferred_contact: "email",
    });
  });

  it("splits, trims, and caps the skills line", () => {
    const payload = draftToPayload({
      ...EMPTY_WALLET_CARD_DRAFT,
      email: "ada@example.com",
      skills: " Python , , Cryptography ",
    });

    expect(payload.skills).toEqual(["Python", "Cryptography"]);
    expect(splitSkills("")).toEqual([]);
  });

  it("drops the preferred contact when its field is empty", () => {
    const payload = draftToPayload({
      ...EMPTY_WALLET_CARD_DRAFT,
      fullName: "Ada Lovelace",
    });

    expect(payload.preferred_contact).toBeUndefined();
  });

  it("round-trips a stored payload back into an editable draft", () => {
    const payload = {
      full_name: "Ada Lovelace",
      headline: "Founder, Hussh",
      skills: ["Python", "Cryptography"],
      email: "ada@example.com",
      preferred_contact: "email" as const,
    };

    const draft = draftFromPayload(payload);

    expect(draft.fullName).toBe("Ada Lovelace");
    expect(draft.skills).toBe("Python, Cryptography");
    expect(draftToPayload(draft)).toEqual(payload);
  });

  it("lists what a scan will reveal, photo included", () => {
    const shared = describeSharedFields({
      ...EMPTY_WALLET_CARD_DRAFT,
      fullName: "Ada Lovelace",
      headline: "Founder, Hussh",
      email: "ada@example.com",
    });

    expect(shared).toEqual(["Name", "Photo", "Headline", "Email"]);
  });
});
