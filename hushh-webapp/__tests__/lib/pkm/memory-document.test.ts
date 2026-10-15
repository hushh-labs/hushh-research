import { describe, expect, it } from "vitest";
import { buildMemoryDocument, type MemoryDocumentAudience } from "@/lib/pkm/memory-document";
import type { PkmMemoryCard, PkmMemorySnapshot } from "@/lib/pkm/pkm-memory-cards";

const card = (domain: string, title: string, value: string): PkmMemoryCard => ({
  id: `${domain}.${title}`,
  domain,
  domainTitle: domain,
  title,
  detail: title,
  value,
  valueFingerprint: value,
  path: `${domain}.${title}`,
  pathSegments: [domain, title],
  sourceLabel: "Owner",
  updatedAt: "2026-10-01T00:00:00.000Z",
  confidence: 1,
  kind: "profile",
  editable: true,
  searchText: `${title} ${value}`,
});

const snapshotOf = (cards: PkmMemoryCard[]): PkmMemorySnapshot => ({
  cards,
  domainInsights: [],
  totalCards: cards.length,
});

const build = (
  cards: PkmMemoryCard[],
  audience: MemoryDocumentAudience,
  sources: { domain: string; contentRevision: number | null; unavailableReason?: string }[],
) =>
  buildMemoryDocument({
    snapshot: snapshotOf(cards),
    sources,
    audience,
    builtAt: "2026-10-10T12:00:00.000Z",
  });

describe("memory.md audience exclusion", () => {
  // A document built for `agent` may travel to another person as a paid answer,
  // so it must drop what the always-on packet rule drops, not merely what the
  // Memory screen hides.
  it("withholds agent-restricted domains and says so, while `self` still shows them", () => {
    const cards = [
      card("personal_data", "Home city", "Bengaluru"),
      card("source_library", "Document text", "raw extract"),
      card("linked_accounts", "Account", "repeat of Plaid records"),
    ];
    const sources = [
      { domain: "personal_data", contentRevision: 7 },
      { domain: "source_library", contentRevision: 3 },
      { domain: "linked_accounts", contentRevision: 2 },
    ];

    const forAgent = build(cards, "agent", sources);
    expect(forAgent.excludedDomains).toEqual(["linked_accounts", "source_library"]);
    expect(forAgent.markdown).toContain("Bengaluru");
    expect(forAgent.markdown).not.toContain("raw extract");
    expect(forAgent.markdown).not.toContain("repeat of Plaid records");
    // The omission is stated, so a reader cannot mistake it for "nothing here".
    expect(forAgent.markdown).toContain("source_library");

    // Negative control: the same input under the Memory-screen rule keeps them.
    // This fails if `agent` silently falls back to the looser predicate.
    const forSelf = build(cards, "self", sources);
    expect(forSelf.excludedDomains).toEqual([]);
    expect(forSelf.markdown).toContain("raw extract");
  });

  // Regression: shouldSkipPkmAgentContextKey does NOT cover `wallet` or
  // `identity.identity_documents`, but reserved-branches.v1.json marks both
  // send_to_model: label_only. Without the registry check their values render
  // into a document built to travel to another person.
  it("withholds every branch the reserved registry does not mark send_to_model: full", () => {
    const walletCard = {
      ...card("wallet", "Card", "Visa ending 4242"),
      pathSegments: ["wallet", "summary", "card_1"],
    };
    const documentsCard = {
      ...card("identity", "Passport", "P<IND1234567"),
      pathSegments: ["identity", "identity_documents", "passport"],
    };
    const openCard = card("personal_data", "Home city", "Bengaluru");

    const privateArtwork = [
      { ...card("wallet", "Image", "private-raster-relative"), pathSegments: ["artwork", "card_1", "image"] },
      { ...card("wallet", "Image", "private-raster-prefixed"), pathSegments: ["wallet", "artwork", "card_2", "image"] },
    ];
    const forSelf = buildMemoryDocument({
      snapshot: { ...snapshotOf([walletCard, openCard, ...privateArtwork]),
        domainInsights: [{ domain: "wallet", title: "Wallet", summary: "private-raster-derived", highlights: ["private-raster-highlight"], updatedAt: null, cardCount: 3 }] },
      sources: [], audience: "self", builtAt: "2026-10-10T12:00:00.000Z",
    });
    expect(forSelf.markdown).toContain("Visa ending 4242");
    expect(forSelf.markdown).not.toContain("private-raster");
    const forAgent = build([walletCard, documentsCard, openCard, ...privateArtwork], "agent", [
      { domain: "wallet", contentRevision: 1 },
      { domain: "identity", contentRevision: 1 },
      { domain: "personal_data", contentRevision: 1 },
    ]);

    expect(forAgent.markdown).not.toContain("Visa ending 4242");
    expect(forAgent.markdown).not.toContain("P<IND1234567");
    expect(forAgent.excludedDomains).toEqual(["identity", "wallet"]);
    // The open domain is unaffected, so the rule is not just "withhold everything".
    expect(forAgent.markdown).toContain("Bengaluru");
  });

  it("withholds a regulated identifier branch from an agent document", () => {
    const cards = [card("identity", "Value", "shown"), card("passport_number", "Value", "X1234567")];
    const sources = [
      { domain: "identity", contentRevision: 1 },
      { domain: "passport_number", contentRevision: 1 },
    ];
    const forAgent = build(cards, "agent", sources);
    expect(forAgent.markdown).not.toContain("X1234567");
    expect(forAgent.excludedDomains).toContain("passport_number");
  });

  it("never recursively renders One's canonical Markdown domain", () => {
    const cards = [card("one_memory", "Markdown", "- Aadhaar number: protected")];
    const sources = [{ domain: "one_memory", contentRevision: 1 }];

    for (const audience of ["self", "agent"] as const) {
      const result = build(cards, audience, sources);
      expect(result.excludedDomains).toEqual(["one_memory"]);
      expect(result.markdown).not.toContain("Aadhaar number: protected");
    }
  });
});

describe("memory.md account identity", () => {
  // "Everything One holds" has to include the plain account facts, not only
  // PKM domains: a document that omitted the person's own name and picture
  // would not be the complete picture it claims to be.
  it("renders name, email, picture and role from the account profile", () => {
    const result = buildMemoryDocument({
      snapshot: snapshotOf([card("personal_data", "Home city", "Bengaluru")]),
      sources: [{ domain: "personal_data", contentRevision: 1 }],
      audience: "self",
      builtAt: "2026-10-10T12:00:00.000Z",
      account: {
        displayName: "Ankit Kumar Singh",
        email: "ankit@hushh.ai",
        photoUrl: "https://example.test/a.png",
        verifiedRole: "Investor",
      },
    });
    expect(result.markdown).toContain("## Account");
    expect(result.markdown).toContain("Ankit Kumar Singh");
    expect(result.markdown).toContain("ankit@hushh.ai");
    expect(result.markdown).toContain("https://example.test/a.png");
    expect(result.markdown).toContain("Investor");
    // It is labelled as account data so it is never mistaken for a PKM value.
    expect(result.markdown).toContain("not from encrypted PKM");
  });

  it("omits the section entirely when there is no account identity", () => {
    const result = build([card("personal_data", "Home city", "Bengaluru")], "agent", [
      { domain: "personal_data", contentRevision: 1 },
    ]);
    expect(result.markdown).not.toContain("## Account");
  });
});

describe("memory.md freshness honesty", () => {
  // An unreadable section must never look like an empty one: a paid answer
  // built on a partial document would otherwise read fully confident.
  it("reports an unreadable domain as unavailable instead of dropping it", () => {
    const result = build(
      [card("personal_data", "Home city", "Bengaluru")],
      "agent",
      [
        { domain: "personal_data", contentRevision: 7 },
        { domain: "finance", contentRevision: null, unavailableReason: "decrypt failed" },
      ],
    );

    expect(result.complete).toBe(false);
    expect(result.markdown).toContain("Partial.");
    expect(result.markdown).toContain("decrypt failed");

    const finance = result.freshness.find((entry) => entry.domain === "finance");
    expect(finance?.status).toBe("unavailable");
    expect(finance?.contentRevision).toBeNull();

    const personal = result.freshness.find((entry) => entry.domain === "personal_data");
    expect(personal?.status).toBe("current");
    expect(personal?.contentRevision).toBe(7);
  });

  it("stamps each section with the revision it was built from and is byte-stable", () => {
    const cards = [card("personal_data", "Home city", "Bengaluru")];
    const sources = [{ domain: "personal_data", contentRevision: 7 }];
    const first = build(cards, "agent", sources);
    const second = build([...cards], "agent", [...sources]);

    expect(first.complete).toBe(true);
    expect(first.markdown).toContain("Revision 7");
    // Determinism: an unchanged revision must not produce a changed document.
    expect(second.markdown).toBe(first.markdown);
  });
});


it("shares revision-linked stated identity facts and derived age without copying Soul prose", () => {
  const result = buildMemoryDocument({ snapshot: snapshotOf([]), domainData: { one_memory: { markdown: "- Legal name: Synthetic Ava\n- Date of birth: 1998-03-14\n- Sex: female\n- Private free prose never exported\n" } },
    sources: [{ domain: "one_memory", contentRevision: 9 }], audience: "self", builtAt: "2026-03-13T00:00:00Z", account: { displayName: "Account Ava", photoUrl: "https://example.test/avatar.jpg" } });
  expect(result.markdown).toContain("Synthetic Ava");
  expect(result.markdown).toContain("declared age | 27");
  expect(result.markdown).toContain("female");
  expect(result.markdown).toContain("https://example.test/avatar.jpg");
  expect(result.markdown).not.toContain("Private free prose");
  expect(result.sourceLinks).toContainEqual(expect.objectContaining({ domain: "one_memory", path: "markdown.legal name", contentRevision: 9 }));
});

it("keeps a distinct legal name while flagging only a conflicting Soul display name", () => {
  const soul = { markdown: "- Legal name: Ankit Kumar Singh\n- Display name: Ankit Kumar Singh\n" };
  const params = { snapshot: snapshotOf([]),
    domainData: { one_memory: soul },
    sources: [{ domain: "one_memory", contentRevision: 9 }],
    builtAt: "2026-10-15T00:00:00Z", account: { displayName: "Ankit" },
    verifiedProfileName: "Ankit" };
  const owner = buildMemoryDocument({ ...params, audience: "self" });
  expect(owner.complete).toBe(false);
  expect(owner.freshness.find(row => row.domain === "one_memory")?.status).toBe("conflicted");
  expect(owner.markdown).toContain("Legal name (owner-authored Soul)");
  expect(owner.markdown).toContain("Display name (owner-authored Soul; conflicted)");
  expect(owner.markdown).toContain("Name conflict.");
  expect(soul.markdown).toContain("Display name: Ankit Kumar Singh");
  const agent = buildMemoryDocument({ ...params, audience: "agent" });
  expect(agent.markdown).not.toContain("Ankit Kumar Singh");
  expect(agent.markdown).not.toContain("Name conflict.");

  const onlyLegal = buildMemoryDocument({ ...params, audience: "self",
    domainData: { one_memory: { markdown: "- Legal name: Ankit Kumar Singh\n" } } });
  expect(onlyLegal.complete).toBe(true);
  expect(onlyLegal.markdown).not.toContain("Name conflict.");
  const corrected = buildMemoryDocument({ ...params, audience: "self",
    domainData: { one_memory: { markdown: "- Legal name: Ankit Kumar Singh\n- Display name: Ankit\n" } } });
  expect(corrected.complete).toBe(true);
  const deleted = buildMemoryDocument({ ...params, audience: "self",
    domainData: { one_memory: { ...soul, _deleted_fact_labels: ["display name"] } } });
  expect(deleted.complete).toBe(true);
  expect(deleted.markdown).not.toContain("Display name (owner-authored Soul; conflicted)");
});

it("shows corrections once and removes deleted identity rows without changing the source", () => {
  const identity = { identity_profile: { full_name: "Old name", sex: "old sex", date_of_birth: "1980-01-01", declared_age: 46, citizenship: "retained" } };
  const document = buildMemoryDocument({ snapshot: snapshotOf([]), audience: "self", builtAt: "2026-10-13T00:00:00Z", sources: [{ domain: "identity", contentRevision: 3 }, { domain: "one_memory", contentRevision: 9 }], domainData: { identity, one_memory: { markdown: "- Legal name: Current name\n", _deleted_fact_labels: ["sex", "date of birth"] } } });
  expect(document.markdown).toContain("Current name");
  expect(document.markdown).toContain("retained");
  for (const old of ["Old name", "old sex", "1980-01-01", "| 46 |"] ) expect(document.markdown).not.toContain(old);
  expect(identity.identity_profile.sex).toBe("old sex");
  expect(document.sourceLinks).toContainEqual({ domain: "one_memory", path: "markdown.legal name", contentRevision: 9, manifestRevision: null });
  expect(document.sourceLinks.some(link => link.domain === "identity" && ["identity_profile.full_name", "identity_profile.sex", "identity_profile.date_of_birth", "identity_profile.declared_age"].includes(link.path))).toBe(false);
});

it("derives current shared age from canonical saved PKM DOB and never renders a stale age number", () => {
  const identity = { identity_profile: { date_of_birth: "1998-10-13", declared_age: 999 }, profile: { age: 888 } };
  const build = (builtAt: string, one_memory?: unknown) => buildMemoryDocument({ snapshot: snapshotOf([]), audience: "self", builtAt,
    sources: [{ domain: "identity", contentRevision: 7, manifestRevision: 3 }, ...(one_memory ? [{ domain: "one_memory", contentRevision: 9 }] : [])], domainData: { identity, ...(one_memory ? { one_memory } : {}) } });
  expect(build("2026-10-12T23:59:59Z").markdown).toContain("| declared age | 27 |");
  const birthday = build("2026-10-13T00:00:00Z");
  expect(birthday.markdown).toContain("| declared age | 28 |");
  expect(birthday.markdown).not.toContain("999"); expect(birthday.markdown).not.toContain("888");
  expect(birthday.sourceLinks).toContainEqual({ domain: "identity", path: "identity_profile.date_of_birth", contentRevision: 7, manifestRevision: 3 });
  expect(build("2026-10-13T00:00:00Z", { markdown: "", _deleted_fact_labels: ["date of birth"] }).markdown).not.toContain("| declared age |");
  expect(build("2026-10-13T00:00:00Z", { markdown: "- Date of birth: 2026-02-31\n" }).markdown).not.toContain("| declared age |");
});

it("keeps legacy professional age current through canonical DOB and preserves ordinary employment rows", () => {
  const identity = { identity_profile: { date_of_birth: "1998-10-13", declared_age: 999 }, profile: { age: 888 } };
  const professional = { profile: { age: 777, employment_status: "independent", employer: { age: "UNRELATED_EMPLOYER_AGE", sex: "UNRELATED_EMPLOYER_SEX" } } };
  const build = (builtAt: string, one_memory?: unknown) => buildMemoryDocument({ snapshot: snapshotOf([]), audience: "self", builtAt,
    sources: [{ domain: "identity", contentRevision: 7, manifestRevision: 3 }, { domain: "professional", contentRevision: 4 }, ...(one_memory ? [{ domain: "one_memory", contentRevision: 9 }] : [])],
    domainData: { identity, professional, ...(one_memory ? { one_memory } : {}) } });
  expect(build("2026-10-12T23:59:59Z").markdown).toContain("| declared age | 27 |");
  const birthday = build("2026-10-13T00:00:00Z");
  expect(birthday.markdown).toContain("| declared age | 28 |");
  for (const stale of ["| 999 |", "| 888 |", "| 777 |"]) expect(birthday.markdown).not.toContain(stale);
  expect(birthday.markdown).toContain("independent");
  expect(birthday.markdown).toContain("UNRELATED_EMPLOYER_AGE");
  expect(birthday.markdown).toContain("UNRELATED_EMPLOYER_SEX");
  expect(birthday.sourceLinks).toContainEqual({ domain: "identity", path: "identity_profile.date_of_birth", contentRevision: 7, manifestRevision: 3 });
  expect(birthday.sourceLinks.some(link => link.domain === "professional" && link.path === "profile.age")).toBe(false);
  const deleted = build("2026-10-13T00:00:00Z", { markdown: "- Date of birth: 1998-10-13\n", _deleted_fact_labels: ["date of birth"] });
  expect(deleted.markdown).not.toContain("| declared age |");
  expect(deleted.markdown).not.toContain("1998-10-13");
  expect(professional.profile.age).toBe(777);
});

it.each([undefined, "2026-02-31"])("missing or invalid DOB cannot leave legacy professional age visible (%s)", birth => {
  const document = buildMemoryDocument({ snapshot: snapshotOf([]), audience: "self", builtAt: "2026-10-13T00:00:00Z",
    sources: [{ domain: "identity", contentRevision: 7 }, { domain: "professional", contentRevision: 4 }],
    domainData: { identity: { identity_profile: { date_of_birth: birth } }, professional: { profile: { age: "STALE_LEGACY_AGE", employment_status: "retained employment" } } } });
  expect(document.markdown).not.toContain("STALE_LEGACY_AGE");
  expect(document.markdown).not.toContain("| declared age |");
  expect(document.markdown).toContain("retained employment");
});

it("canonical explicit sex corrections and tombstones supersede both legacy domains without reviving old labels", () => {
  const domainData = {
    identity: { identity_profile: { sex: "OLD_CANONICAL_SEX" }, profile: { sex: "OLD_IDENTITY_SEX" } },
    professional: { profile: { sex: "OLD_PROFESSIONAL_SEX", employment_status: "retained employment", employer: { sex: "UNRELATED_EMPLOYER_SEX" } } },
  };
  const build = (one_memory: unknown) => buildMemoryDocument({ snapshot: snapshotOf([]), audience: "self", builtAt: "2026-10-13T00:00:00Z",
    sources: [{ domain: "identity", contentRevision: 7 }, { domain: "professional", contentRevision: 4 }, { domain: "one_memory", contentRevision: 9 }], domainData: { ...domainData, one_memory } });
  const corrected = build({ markdown: "- Sex: current supplied value\n" });
  expect(corrected.markdown.match(/current supplied value/g)).toHaveLength(1);
  const deleted = build({ markdown: "- Sex: stale labelled value\n", _deleted_fact_labels: ["sex"] });
  for (const document of [corrected, deleted]) {
    for (const stale of ["OLD_CANONICAL_SEX", "OLD_IDENTITY_SEX", "OLD_PROFESSIONAL_SEX", "stale labelled value"]) expect(document.markdown).not.toContain(stale);
    expect(document.markdown).toContain("retained employment");
    expect(document.markdown).toContain("UNRELATED_EMPLOYER_SEX");
    expect(document.sourceLinks.some(link => ["identity_profile.sex", "profile.sex"].includes(link.path))).toBe(false);
  }
  expect(corrected.sourceLinks).toContainEqual({ domain: "one_memory", path: "markdown.sex", contentRevision: 9, manifestRevision: null });
  expect(domainData.professional.profile.sex).toBe("OLD_PROFESSIONAL_SEX");
});

it("an unavailable canonical source cannot make stale legacy age or sex appear current", () => {
  const document = buildMemoryDocument({ snapshot: snapshotOf([]), audience: "self", builtAt: "2026-10-13T00:00:00Z",
    sources: [{ domain: "identity", contentRevision: 7 }, { domain: "professional", contentRevision: 4 }, { domain: "one_memory", contentRevision: null, unavailableReason: "read failed" }],
    domainData: { identity: { identity_profile: { date_of_birth: "1998-10-13", sex: "OLD_CANONICAL_SEX" }, profile: { age: "OLD_IDENTITY_AGE", sex: "OLD_IDENTITY_SEX" } },
      professional: { profile: { age: "OLD_PROFESSIONAL_AGE", sex: "OLD_PROFESSIONAL_SEX", employment_status: "retained employment" } } } });
  expect(document.complete).toBe(false);
  for (const stale of ["OLD_CANONICAL_SEX", "OLD_IDENTITY_AGE", "OLD_IDENTITY_SEX", "OLD_PROFESSIONAL_AGE", "OLD_PROFESSIONAL_SEX"]) expect(document.markdown).not.toContain(stale);
  expect(document.markdown).toContain("retained employment");
  expect(document.markdown).toContain("read failed");
});

it("does not change ordinary professional employment summaries or snapshot fallback exclusion", () => {
  const ordinary = buildMemoryDocument({ snapshot: { ...snapshotOf([]), domainInsights: [{ domain: "professional", title: "Work", summary: "Ordinary employment summary", highlights: [] }] },
    audience: "self", builtAt: "2026-10-13T00:00:00Z", sources: [{ domain: "professional", contentRevision: 4 }, { domain: "one_memory", contentRevision: 9 }],
    domainData: { professional: { profile: { employment_status: "independent" } }, one_memory: { markdown: "- Sex: supplied value\n" } } });
  expect(ordinary.markdown).toContain("Ordinary employment summary");
  expect(ordinary.markdown).toContain("independent");
  const legacy = buildMemoryDocument({ snapshot: snapshotOf([card("professional", "profile.age", "STALE_SNAPSHOT_AGE"), card("professional", "profile.sex", "STALE_SNAPSHOT_SEX"), card("professional", "profile.employment_status", "snapshot employment")]),
    audience: "self", builtAt: "2026-10-13T00:00:00Z", sources: [{ domain: "professional", contentRevision: 4 }, { domain: "one_memory", contentRevision: 9 }],
    domainData: { one_memory: { markdown: "", _deleted_fact_labels: ["sex"] } } });
  expect(legacy.markdown).not.toContain("STALE_SNAPSHOT_AGE");
  expect(legacy.markdown).not.toContain("STALE_SNAPSHOT_SEX");
  expect(legacy.markdown).toContain("snapshot employment");
});
