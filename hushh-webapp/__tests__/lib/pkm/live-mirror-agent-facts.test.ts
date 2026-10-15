// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  LIVE_MIRROR_FRESHNESS_MS,
  LIVE_MIRROR_HIDDEN_PREDICATES,
  LIVE_MIRROR_KINDS,
  LIVE_MIRROR_PRESENCE_ONLY_PREDICATES,
  LIVE_MIRROR_SOURCE_LABELS,
  LIVE_MIRROR_STALE_GRACE_MS,
  type LiveMirrorClaim,
  type LiveMirrorConflict,
  type LiveMirrorFact,
  type LiveMirrorHistoryEntry,
  type LiveMirrorKind,
  type LiveMirrorSource,
  type LiveMirrorView,
} from "@/lib/pkm/live-mirror-contract";
import { LIVING_SOURCE_FACT_FIELDS } from "@/lib/pkm/living-source-fact-index";
import {
  AGENT_FACT_FIELDS,
  CONSENTED_MEMORY_MAX_CHARS,
  LIVE_MIRROR_PACKET_END,
  LIVE_MIRROR_PACKET_HEADER,
  appendLiveMirrorPacket,
  buildLiveMirrorFactsPacket,
  liveMirrorPacketBudget,
} from "@/lib/pkm/live-mirror-agent-facts";

/**
 * The owner's own agent reads a bounded, allowlisted packet of the Live
 * Mirror (registry value owner_turn_allowlist). These tests pin the trust
 * boundary: only reviewed fields, read-time states, the owner and vault fence,
 * and a budget that the server's 20,000-character clip can never cut.
 */

const T = "2026-10-15T10:00:00.000Z";
const MIN = 60_000;
const at = (offsetMs: number) => new Date(Date.parse(T) + offsetMs).toISOString();

function source(kind: LiveMirrorKind, patch: Partial<LiveMirrorSource> = {}): LiveMirrorSource {
  return {
    id: `living:${kind}`, group: "living", kind, domain: null, label: LIVE_MIRROR_SOURCE_LABELS[kind],
    state: "current", verifiedAt: T, staleAfterMs: LIVE_MIRROR_FRESHNESS_MS + LIVE_MIRROR_STALE_GRACE_MS,
    contentRevision: null, reason: null, withheld: [], liveCount: kind === "profile" || kind === "consent" ? 1 : 0,
    pendingChanges: 0, lastLagMs: null, medianLagMs: null, ...patch,
  };
}

function fact(
  kind: LiveMirrorKind, ref: string, field: string, value: LiveMirrorFact["value"], patch: Partial<LiveMirrorFact> = {},
): LiveMirrorFact {
  const sourceId = `src-raw-${kind}-${ref.replace(/\W/g, "")}`;
  return {
    key: JSON.stringify([kind, sourceId, field]), predicate: `${kind}.${field}`, kind, sourceId, ref, field,
    label: field, value, state: "verified", revision: kind === "consent" ? 5 : 3,
    sourceUpdatedAt: at(-30 * MIN), capturedAt: at(-20 * MIN), verifiedAt: T, ...patch,
  };
}

const BASE_FACTS = [
  fact("profile", "Profile", "name", "Ankit Synthetic"),
  fact("profile", "Profile", "email", "ankit@example.test"),
  fact("consent", "Consent 2", "scope", "attr.food.*"),
  fact("consent", "Consent 2", "status", "active"),
];

function view(patch: Partial<LiveMirrorView> = {}): LiveMirrorView {
  return {
    schemaVersion: "live_mirror.v1", ownerId: "owner-a", vaultEpoch: 3, builtAt: T, inventoryObservedAt: T,
    inventoryComplete: true, issues: [], nameConflict: false, sources: LIVE_MIRROR_KINDS.map((kind) => source(kind)),
    facts: BASE_FACTS, markdown: "",
    history: { entries: [], firstRetainedSequence: 1, droppedCount: 0, truncatedAt: null, coverage: "open_app_only" },
    evaluatedAt: at(MIN), overall: "current", lastVerifiedAt: T, ...patch,
  };
}

function change(sequence: number, patch: Partial<LiveMirrorHistoryEntry> = {}): LiveMirrorHistoryEntry {
  return {
    sequence, kind: "consent", ref: `Consent ${sequence}`, revision: 1, operation: "upsert",
    capturedAt: at(-sequence * MIN), sourceUpdatedAt: null, current: true, redacted: false, gap: null,
    changes: [{ predicate: "consent.scope", label: "Scope", value: `HISTORY_VALUE_${sequence}` }], ...patch,
  };
}

const build = (input: LiveMirrorView | null, patch: Partial<Parameters<typeof buildLiveMirrorFactsPacket>[0]> = {}) =>
  buildLiveMirrorFactsPacket({ expectedOwnerId: "owner-a", currentVaultEpoch: 3, view: input, budgetChars: 1_800, ...patch });

const withSource = (kind: LiveMirrorKind, patch: Partial<LiveMirrorSource>) =>
  LIVE_MIRROR_KINDS.map((each) => source(each, each === kind ? patch : {}));

/** A Soul-versus-profile name conflict beside a record conflict, each with its claims. */
const CONFLICTS: LiveMirrorConflict[] = [
  { predicate: "profile.name", label: "Name", claims: [
    { source: "soul", origin: "named", label: "Your memory", value: "Ankit K", revision: 9, sourceUpdatedAt: at(-45 * MIN), verifiedAt: null },
    { source: "profile", origin: "named", label: "Profile", value: "Ankit Synthetic", revision: 3, sourceUpdatedAt: at(-30 * MIN), verifiedAt: T },
  ] },
  { predicate: "consent.scope", label: "Scope", claims: [
    { source: "consent", origin: "record", label: "Consent 2, copy 1", value: "CANDIDATE_A", revision: 5, sourceUpdatedAt: null, verifiedAt: T },
    { source: "consent", origin: "record", label: "Consent 2, copy 2", value: "CANDIDATE_B", revision: 5, sourceUpdatedAt: null, verifiedAt: T },
  ] },
];

describe("Live Mirror agent allowlist (B-R5)", () => {
  it("admits a reviewed subset of the fact index, never other people's ids or the photo", () => {
    const excluded = new Set<string>([...LIVE_MIRROR_HIDDEN_PREDICATES, ...LIVE_MIRROR_PRESENCE_ONLY_PREDICATES]);
    for (const kind of LIVE_MIRROR_KINDS) {
      const index = LIVING_SOURCE_FACT_FIELDS[kind];
      for (const field of AGENT_FACT_FIELDS[kind]) {
        expect(index, `${kind}.${field}`).toContain(field);
        expect(excluded.has(`${kind}.${field}`), `${kind}.${field}`).toBe(false);
      }
      // Review ratchet: a field added to the index stays out of the model until
      // someone decides it belongs here.
      expect([...AGENT_FACT_FIELDS[kind]].sort()).toEqual(
        index.filter((field) => !excluded.has(`${kind}.${field}`)).sort(),
      );
    }
  });

  it("never sends birth dates, tokens, coordinates, photo URLs, raw ids or another person's id", () => {
    const { text } = build(view({ facts: [
      ...BASE_FACTS,
      fact("profile", "Profile", "photo", "https://photo.example/p.png"),
      fact("profile", "Profile", "dateOfBirth", "1990-01-01"),
      fact("profile", "Profile", "accessToken", "ya29.SYNTH"),
      fact("profile", "Profile", "latitude", 37.7749),
      fact("consent", "Consent 2", "counterpart", "uid-other"),
      fact("connection", "Connection 1", "counterpartId", "uid-other", { revision: 1 }),
      fact("connection", "Connection 1", "establishedAt", at(-90 * MIN), { revision: 1 }),
      fact("document_request_payment", "Document payment 1", "counterpartRef", "uid-other"),
      // A record id that leaked into `ref` is never a safe reference.
      fact("connection", "uid-other", "establishedAt", at(-10 * MIN)),
    ] }));
    expect(text).toContain('name="Ankit Synthetic"');
    expect(text).toContain('- Connection 1: establishedAt="2026-10-15T08:30Z"');
    for (const forbidden of [
      "1990-01-01", "ya29.SYNTH", "uid-other", "latitude", "37.7749", "dateOfBirth", "accessToken",
      "https://photo", "profile.photo", "counterpart", "src-raw",
    ]) expect(text, forbidden).not.toContain(forbidden);
  });
});

describe("Live Mirror packet states read at turn time (B-R6)", () => {
  const stale = { state: "stale" as const, verifiedAt: T };
  const gap = {
    ref: "*", revision: 0, operation: "gap" as const, current: false, changes: [],
    gap: { reason: "unobserved_changes" as const, committedChanges: 3, verifiedChanges: 1, firstOccurredAt: T, lastOccurredAt: T },
  };
  const history = {
    entries: Array.from({ length: 12 }, (_, index) => change(131 - index, index === 1 ? gap : {})),
    firstRetainedSequence: 120, droppedCount: 119, truncatedAt: "2026-10-01T00:00:00.000Z", coverage: "open_app_only" as const,
  };
  it.each<[string, Partial<LiveMirrorView>, string[], string[]]>([
    ["verified", {}, [
      '- Profile: name="Ankit Synthetic", email="ankit@example.test" [verified 2026-10-15T10:00Z; revision 3]',
      "Mirror: up to date; read 2026-10-15T10:01Z; last verified 2026-10-15T10:00Z",
    ], []],
    ["stale with its last verified time", {
      evaluatedAt: at(8 * MIN), overall: "stale",
      sources: LIVE_MIRROR_KINDS.map((kind) => source(kind, stale)),
      facts: BASE_FACTS.map((each) => ({ ...each, state: "stale" as const })),
    }, ["[stale, last verified 2026-10-15T10:00Z; revision 3]", "Mirror: may be out of date"], ["[verified"]],
    ["cannot verify now", {
      overall: "partial",
      sources: withSource("consent", { state: "unavailable", verifiedAt: at(-20 * MIN) }),
      facts: BASE_FACTS.map((each) => each.kind === "consent" ? { ...each, state: "unavailable" as const, verifiedAt: at(-20 * MIN) } : each),
    }, [
      '- Consent 2: scope="attr.food.*", status="active" [cannot verify now, last verified 2026-10-15T09:40Z; revision 5]',
      "consent cannot verify now (last verified 2026-10-15T09:40Z)",
    ], ["Consent 2: scope=\"attr.food.*\", status=\"active\" [verified"]],
    ["none recorded", {}, ["connection, curated_oauth_connector, document_earning, payout_activity, document_request_payment verified 2026-10-15T10:00Z, none recorded"], []],
    ["deleted at a revision, without values", {
      facts: [...BASE_FACTS, fact("consent", "Consent 3", "scope", "OLD_SCOPE_VALUE", { state: "deleted", revision: 6 })],
      history: { ...view().history, entries: [
        change(7, { ref: "Consent 3", operation: "delete", revision: 6, changes: [] }),
        change(6, { ref: "Consent 3", revision: 5, current: false, changes: [{ predicate: "consent.scope", label: "Scope", value: "OLD_SCOPE_VALUE" }] }),
      ] },
    }, ["- Consent 3: deleted at revision 6", "#7 Consent 3 delete r6"], ["OLD_SCOPE_VALUE"]],
    ["deleted from history alone", {
      history: { ...view().history, entries: [change(9, { ref: "Consent 9", operation: "delete", revision: 4, changes: [] })] },
    }, ["- Consent 9: deleted at revision 4"], ["HISTORY_VALUE"]],
    ["conflicting, with no value selected", {
      overall: "conflict",
      facts: [...BASE_FACTS,
        fact("connection", "Connection 1", "establishedAt", "CANDIDATE_A", { state: "conflicted" }),
        fact("connection", "Connection 1", "connectedFromContacts", "CANDIDATE_B", { state: "conflicted" })],
    }, ["- Connection 1: conflicting revisions, no value selected", "Mirror: conflicting records need the owner's review"],
    ["CANDIDATE_A", "CANDIDATE_B"]],
    ["update pending", {
      overall: "updating", sources: withSource("consent", { state: "updating", pendingChanges: 2 }),
    }, ["[update pending, last verified 2026-10-15T10:00Z; revision 5]", "consent update pending (last verified 2026-10-15T10:00Z)"],
    ["status=\"active\" [verified"]],
    ["name conflict without claims", { nameConflict: true },
      ["Name conflict: the owner-authored Soul name differs from the verified profile.name."], []],
    ["name conflict with both names and the profile claim's provenance only", {
      nameConflict: true, overall: "conflict", conflicts: CONFLICTS,
      facts: [...BASE_FACTS.filter((each) => each.kind === "profile"),
        fact("consent", "Consent 2", "scope", null, { state: "conflicted" })],
    }, [
      'Name conflict: memory says "Ankit K"; verified profile says "Ankit Synthetic" [profile r3, verified 2026-10-15T10:00Z]',
      "- Consent 2: conflicting revisions, no value selected",
    ], ["the owner-authored Soul name differs", "CANDIDATE_A", "CANDIDATE_B", "Your memory", "09:15Z", "09:30Z", "r9"]],
    ["name conflict while Profile is withheld, without either name", {
      nameConflict: true, overall: "conflict", conflicts: CONFLICTS, sources: withSource("profile", { state: "withheld" }),
    }, ["Name conflict: the owner-authored Soul name differs from the verified profile.name."], ["Ankit K", "Ankit Synthetic"]],
    ["retained history window", { history }, [
      "History: retained changes #120-#131; earlier changes not retained (cutoff 2026-10-01T00:00Z); only changes seen while the app was open.",
      "Recent: #131 Consent 131 upsert r1",
      "#130 consent gap (3 changes committed, 1 recorded)",
      "#129 Consent 129 upsert r1",
    ], ["#128", "HISTORY_VALUE"]],
    ["a one-change gap whose recorded count is unknown", {
      history: { ...view().history, entries: [
        change(5, { ...gap, gap: { ...gap.gap, committedChanges: 1, verifiedChanges: null } }),
      ] },
    }, ["#5 consent gap (1 change committed, recorded count unknown)"], ["not all", "1 changes"]],
  ])("labels %s", (_label, patch, expected, forbidden) => {
    const { text } = build(view(patch));
    for (const fragment of expected) expect(text).toContain(fragment);
    for (const fragment of forbidden) expect(text).not.toContain(fragment);
  });

  it("never labels a stale fact verified, even when a cached view still says current", () => {
    const cached = { sources: LIVE_MIRROR_KINDS.map((kind) => source(kind)), overall: "current" as const };
    // Inside the five-minute window plus two minutes of grace: still verified.
    expect(build(view({ ...cached, evaluatedAt: at(6 * MIN) })).text).toContain("[verified 2026-10-15T10:00Z");
    // Past it: stale, whatever the cached states claim (negative control).
    const late = build(view({ ...cached, evaluatedAt: at(8 * MIN) })).text;
    expect(late).toContain("[stale, last verified 2026-10-15T10:00Z; revision 3]");
    expect(late).toContain("Mirror: may be out of date");
    expect(late).not.toContain("[verified");
    // The caller's turn time counts too, so an old view cannot look fresh.
    expect(build(view(cached), { now: Date.parse(at(9 * MIN)) }).text).not.toContain("[verified");
  });
});

describe("Live Mirror name conflict read at turn time (B-R6)", () => {
  const FALLBACK = "Name conflict: the owner-authored Soul name differs from the verified profile.name.";
  const SOUL: LiveMirrorClaim = {
    source: "soul", origin: "named", label: "Your memory", value: "SOUL_NAME", revision: 9,
    sourceUpdatedAt: at(-45 * MIN), verifiedAt: null,
  };
  const PROFILE: LiveMirrorClaim = {
    source: "profile", origin: "named", label: "Profile", value: "PROFILE_NAME", revision: 3,
    sourceUpdatedAt: at(-30 * MIN), verifiedAt: T,
  };
  /** One side of a profile record whose own copies disagree on the name. */
  const copy = (number: number, value: string): LiveMirrorClaim => ({
    source: "profile", origin: "record", label: `Profile, copy ${number}`, value, revision: 3,
    sourceUpdatedAt: at(-number * MIN), verifiedAt: T,
  });
  const SENTINELS = ["SOUL_NAME", "PROFILE_NAME", "SECOND_PROFILE_NAME", "RECORD_NAME_A", "RECORD_NAME_B"];
  const packet = (claims: LiveMirrorClaim[], patch: Partial<LiveMirrorView> = {}) => build(view({
    nameConflict: true, overall: "conflict", conflicts: [{ predicate: "profile.name", label: "Name", claims }], ...patch,
  })).text;

  // Hand-built views: the projection no longer pairs memory's name with a
  // record's copies. Profile stays current here, so only the sides decide.
  it.each<[string, LiveMirrorClaim[]]>([
    // The reviewed case: the first profile string, a record copy, went out as "verified profile says".
    ["a profile record's copies beside a named profile side without a value",
      [SOUL, { ...PROFILE, value: null }, copy(1, "RECORD_NAME_A"), copy(2, "RECORD_NAME_B")]],
    ["a profile record's copies alone", [SOUL, copy(1, "RECORD_NAME_A"), copy(2, "RECORD_NAME_B")]],
    ["a lone record copy, the only profile name on offer", [SOUL, copy(1, "RECORD_NAME_A")]],
    ["sides without an origin", [{ ...SOUL, origin: undefined }, { ...PROFILE, origin: undefined }]],
    ["two named profile names", [SOUL, PROFILE, { ...PROFILE, value: "SECOND_PROFILE_NAME" }]],
    ["a blank profile name", [SOUL, { ...PROFILE, value: "  " }]],
    ["no written name", [{ ...SOUL, value: null }, PROFILE]],
  ])("names the conflict without values for %s", (_label, claims) => {
    const text = packet(claims);
    expect(text).toContain(FALLBACK);
    for (const value of SENTINELS) expect(text, value).not.toContain(value);
  });

  it.each<[string, Partial<LiveMirrorView>, string]>([
    ["verified while current", {}, 'verified profile says "PROFILE_NAME" [profile r3, verified 2026-10-15T10:00Z]'],
    ["stale past its window, though the cached view says current", { evaluatedAt: at(8 * MIN) },
      'profile (stale, last verified 2026-10-15T10:00Z) says "PROFILE_NAME" [profile r3]'],
    ["pending an update", { sources: withSource("profile", { state: "updating", pendingChanges: 1 }) },
      'profile (update pending, last verified 2026-10-15T10:00Z) says "PROFILE_NAME" [profile r3]'],
    ["unverifiable three hours after its last check", {
      overall: "partial", evaluatedAt: at(3 * 60 * MIN), sources: withSource("profile", { state: "unavailable" }),
    }, 'profile (cannot verify now, last verified 2026-10-15T10:00Z) says "PROFILE_NAME" [profile r3]'],
  ])("words the profile side by its state at turn time: %s", (label, patch, side) => {
    const text = packet([SOUL, PROFILE], patch);
    expect(text).toContain(`\nName conflict: memory says "SOUL_NAME"; ${side}\n`);
    // Only a current profile is called verified (negative control for the rest).
    if (label.startsWith("verified")) expect(text).toContain("verified profile says");
    else expect(text).not.toContain("verified profile");
  });

  it("says never for a pending profile side that was never verified", () => {
    // The line words the claim's own provenance, not the source's last check.
    const text = packet([SOUL, { ...PROFILE, verifiedAt: null }], {
      sources: withSource("profile", { state: "updating", pendingChanges: 1 }),
    });
    expect(text).toContain(
      '\nName conflict: memory says "SOUL_NAME"; profile (update pending, last verified never) says "PROFILE_NAME" [profile r3]\n',
    );
  });

  it.each<[string, LiveMirrorSource[]]>([
    ["withheld", withSource("profile", { state: "withheld" })],
    ["not checked yet", withSource("profile", { state: "not_checked", verifiedAt: null })],
    ["conflicting", withSource("profile", { state: "conflict" })],
    ["missing", LIVE_MIRROR_KINDS.filter((kind) => kind !== "profile").map((kind) => source(kind))],
  ])("names the conflict without values while the profile source is %s", (_label, sources) => {
    const text = packet([SOUL, PROFILE], { sources });
    expect(text).toContain(FALLBACK);
    for (const value of SENTINELS) expect(text, value).not.toContain(value);
  });
});

describe("Live Mirror owner and vault fence (B-R7)", () => {
  it.each<[string, Partial<Parameters<typeof buildLiveMirrorFactsPacket>[0]>]>([
    ["another owner", { expectedOwnerId: "owner-b" }],
    ["a newer vault epoch", { currentVaultEpoch: 4 }],
    ["a missing projection", { view: null }],
    ["an owner mismatch in the index", { view: view({ issues: ["owner_mismatch"] }) }],
  ])("is empty for %s", (_label, patch) => {
    expect(build(view(), patch)).toEqual({ text: "", shownFacts: 0, omittedFacts: 0 });
  });

  it("returns the packet for the same owner and epoch (positive control)", () => {
    const packet = build(view());
    expect(packet.text.startsWith(LIVE_MIRROR_PACKET_HEADER)).toBe(true);
    expect(packet.shownFacts).toBe(2);
  });
});

describe("Live Mirror packet budget (B-R8)", () => {
  it("fits after an 18,000-character Soul, newest records first, and names what it left out", () => {
    const soul = `# memory.md\n${"s".repeat(18_000 - 12)}`;
    const consents = Array.from({ length: 40 }, (_, index) =>
      fact("consent", `Consent ${index + 1}`, "status", "active", { capturedAt: at((index - 40) * MIN), sourceUpdatedAt: null }));
    const packet = build(view({
      facts: [...BASE_FACTS.filter((each) => each.kind === "profile"), ...consents],
      sources: withSource("consent", { liveCount: 40 }),
    }), { budgetChars: liveMirrorPacketBudget(soul.length) });
    const context = appendLiveMirrorPacket(soul, packet.text);

    expect(soul).toHaveLength(18_000);
    expect(liveMirrorPacketBudget(soul.length)).toBe(1_800);
    expect(packet.text.length).toBeLessThanOrEqual(1_800);
    expect(context.length).toBeLessThanOrEqual(CONSENTED_MEMORY_MAX_CHARS);
    expect(context.slice(0, soul.length)).toBe(soul);
    expect(packet.text.endsWith(`\n${LIVE_MIRROR_PACKET_END}`)).toBe(true);
    expect(packet.shownFacts + packet.omittedFacts).toBe(41);
    expect(packet.omittedFacts).toBeGreaterThan(0);
    expect(packet.text).toContain(`Not shown: ${packet.omittedFacts} more records`);
    expect(packet.text).toContain("- Profile: name=");
    expect(packet.text).toContain("- Consent 40:");
    expect(packet.text).not.toContain("- Consent 1:");
  });

  it("is omitted, never clipped, below 300 characters of room", () => {
    expect(build(view(), { budgetChars: 299 }).text).toBe("");
    expect(build(view(), { budgetChars: 300 }).text.endsWith(LIVE_MIRROR_PACKET_END)).toBe(true);
    expect(liveMirrorPacketBudget(19_800)).toBeLessThan(300);
    expect(appendLiveMirrorPacket("soul", "")).toBe("soul");
  });
});

describe("packet built from a real projection", () => {
  // Cross-lane contract: refs, states and fields produced by the real
  // projection must survive the packet's fail-closed checks unchanged.
  it("keeps every allowlisted record and leaks no identifier", async () => {
    const { reconcileLivingSources, appendVerifiedLivingSourceChanges } = await import("@/lib/pkm/living-source-records");
    const { buildLiveMirrorProjection, applyLiveMirrorReadTime } = await import("@/lib/pkm/live-mirror-projection");
    const inputs = [
      { kind: "profile", id: "owner-a", createdAt: null, updatedAt: T,
        value: { name: "Ankit Synthetic", email: "ankit@example.test", photo: "https://example.test/private-photo.png" } },
      { kind: "consent", id: "src-consent-alpha", createdAt: at(-9 * MIN), updatedAt: T,
        value: { scope: "attr.food.*", status: "active", active: true, counterpart: "OTHER_PERSON_UID_1" } },
      { kind: "consent", id: "src-consent-beta", createdAt: at(-8 * MIN), updatedAt: T,
        value: { scope: "attr.travel.*", status: "revoked", active: false, counterpart: "OTHER_PERSON_UID_2" } },
      { kind: "connection", id: "src-connection-gamma", createdAt: at(-7 * MIN), updatedAt: T,
        value: { counterpartId: "OTHER_PERSON_UID_3", establishedAt: T, connectedFromContacts: false } },
      { kind: "curated_oauth_connector", id: "src-connector-delta", createdAt: at(-6 * MIN), updatedAt: T,
        value: { provider: "google_calendar", status: "connected", connectedAt: T, authStyle: "oauth" } },
      { kind: "document_earning", id: "src-earning-epsilon", createdAt: at(-5 * MIN), updatedAt: T,
        value: { stripeMode: "test", status: "paid", grossCents: 1000, netCents: 970, createdAt: T } },
      { kind: "payout_activity", id: "src-activity-zeta", createdAt: at(-4 * MIN), updatedAt: T,
        value: { kind: "earning", mode: "test", occurredAt: T, amountCents: 970, status: "available" } },
      { kind: "document_request_payment", id: "src-payment-eta", createdAt: at(-3 * MIN), updatedAt: T,
        value: { counterpartRef: "OTHER_REF_9", mode: "test", status: "paid", amountCents: 500, currency: "usd", paidAt: T } },
    ] as const;
    const inventory = reconcileLivingSources(null, inputs.map((input) => ({ ...input, value: { ...input.value } })),
      LIVE_MIRROR_KINDS, [], T);
    const history = appendVerifiedLivingSourceChanges(null, null, inventory);
    const projection = buildLiveMirrorProjection({ ownerId: "owner-a", vaultEpoch: 0, now: T, inventory, history, document: null });
    const view = applyLiveMirrorReadTime(projection, Date.parse(T) + MIN, "current");
    const packet = buildLiveMirrorFactsPacket({
      expectedOwnerId: "owner-a", currentVaultEpoch: 0, view, budgetChars: 1_800, now: Date.parse(T) + MIN,
    });

    const eligible = view.facts.filter((each) => (AGENT_FACT_FIELDS[each.kind] as readonly string[]).includes(each.field));
    const records = new Set(eligible.map((each) => `${each.kind}|${each.ref}`));
    expect(view.overall).toBe("current");
    expect(records.size).toBe(inputs.length);
    expect(packet.omittedFacts).toBe(0);
    expect(packet.shownFacts).toBe(records.size);
    for (const each of eligible) expect(packet.text).toContain(`- ${each.ref}:`);
    for (const value of ["Ankit Synthetic", "ankit@example.test", "attr.food.*", "google_calendar"])
      expect(packet.text).toContain(value);
    for (const leaked of ["OTHER_PERSON_UID", "OTHER_REF_9", "private-photo.png", "owner-a", "src-"])
      expect(packet.text).not.toContain(leaked);
  });
});
