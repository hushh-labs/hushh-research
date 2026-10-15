import { describe, expect, it } from "vitest";
import {
  applyLiveMirrorReadTime,
  buildLiveMirrorProjection,
  type BuildLiveMirrorProjectionParams,
} from "@/lib/pkm/live-mirror-projection";
import { formatLiveMirrorValue, liveMirrorHistoryDetail } from "@/lib/pkm/live-mirror-presentation";
import {
  appendVerifiedLivingSourceChanges,
  reconcileLivingSources,
  type LivingSourceChange,
  type LivingSourceHistory,
  type LivingSourceInput,
  type LivingSourceInventory,
} from "@/lib/pkm/living-source-records";
import type { MemoryDocument } from "@/lib/pkm/memory-document";

const OWNER = "owner-a";
const T0 = "2026-10-15T10:00:00.000Z";
const T1 = "2026-10-15T10:01:00.000Z";
const T2 = "2026-10-15T10:02:00.000Z";
const WINDOW_MS = 7 * 60_000;

const profile = (name: string, extra: Record<string, unknown> = {}): LivingSourceInput => ({
  kind: "profile", id: OWNER, createdAt: null, updatedAt: T0,
  value: { name, email: "owner@example.test", photo: "https://example.test/private-photo.png", ...extra },
});
const consent = (id: string, scope: string): LivingSourceInput => ({
  kind: "consent", id, createdAt: T0, updatedAt: T0,
  value: { scope, status: "active", counterpart: "OTHER_PERSON_ID" },
});

/** Runs real source reconciliation and verified-history append, step by step. */
function sync(steps: { inputs: LivingSourceInput[]; kinds: string[]; unavailable?: string[]; now: string }[]) {
  let inventory: LivingSourceInventory | null = null;
  let history: LivingSourceHistory | null = null;
  for (const step of steps) {
    const next = reconcileLivingSources(inventory, step.inputs, step.kinds, step.unavailable ?? [], step.now);
    history = appendVerifiedLivingSourceChanges(history, inventory, next);
    inventory = next;
  }
  return { inventory: inventory!, history: history! };
}

const doc = (overrides: Partial<MemoryDocument> = {}): MemoryDocument => ({
  markdown: "", complete: true, sourceLinks: [], excludedDomains: [],
  freshness: [{ domain: "identity", title: "Identity", status: "current", contentRevision: 7, updatedAt: null, cardCount: 1 }],
  ...overrides,
});
const build = (overrides: Partial<BuildLiveMirrorProjectionParams> = {}) => buildLiveMirrorProjection({
  ownerId: OWNER, vaultEpoch: 0, now: T2, inventory: null, history: null, document: doc(), ...overrides,
});

describe("Live Mirror projection", () => {
  it("is deterministic and fails closed for another owner's profile", () => {
    const { inventory, history } = sync([{ inputs: [profile("Ankit"), consent("c1", "attr.food.*")], kinds: ["profile", "consent"], now: T1 }]);
    const first = build({ inventory, history });
    const second = build({ inventory: structuredClone(inventory), history: structuredClone(history) });
    expect(second).toEqual(first);
    expect(second.markdown).toBe(first.markdown);
    expect(first.facts.find(fact => fact.predicate === "profile.name")?.value).toBe("Ankit");

    const foreignProfile = { ...inventory, records: inventory.records.map(record => record.kind === "profile" ? { ...record, id: "owner-b" } : record) };
    const foreignHistory = { ...history, changes: history.changes.map(change => change.kind === "profile" ? { ...change, id: "owner-b" } : change) };
    for (const rejected of [build({ inventory: foreignProfile, history }), build({ inventory, history: foreignHistory })]) {
      expect(rejected.facts).toHaveLength(0);
      expect(rejected.history.entries).toHaveLength(0);
      expect(rejected.issues).toContain("owner_mismatch");
      expect(rejected.sources.filter(source => source.group === "living").every(source => source.state === "unavailable")).toBe(true);
      expect(rejected.markdown).not.toContain("Ankit");
    }
  });

  it("never turns another person's identifier into a fact and reduces the photo to presence", () => {
    const { inventory, history } = sync([{ inputs: [profile("Ankit"), consent("c1", "attr.food.*")], kinds: ["profile", "consent"], now: T1 }]);
    expect(JSON.stringify(inventory)).toContain("OTHER_PERSON_ID");
    const projection = build({ inventory, history });
    expect(projection.facts.map(fact => fact.predicate)).not.toContain("consent.counterpart");
    expect(projection.facts.find(fact => fact.predicate === "profile.photo")?.value).toBe(true);
    const serialized = JSON.stringify(projection);
    expect(serialized).not.toContain("OTHER_PERSON_ID");
    expect(serialized).not.toContain("private-photo.png");
  });

  it("shows one current name after a rename and keeps the earlier one only in history", () => {
    const { inventory, history } = sync([
      { inputs: [profile("Ankit Kumar Singh")], kinds: ["profile"], now: T0 },
      { inputs: [profile("Ankit")], kinds: ["profile"], now: T1 },
    ]);
    const projection = build({ inventory, history });
    expect(projection.facts.filter(fact => fact.predicate === "profile.name"))
      .toEqual([expect.objectContaining({ value: "Ankit", revision: 2, ref: "Profile" })]);
    expect(projection.history.entries.map(entry => [entry.sequence, entry.current])).toEqual([[2, true], [1, false]]);
    expect(projection.history.entries[1]!.changes).toContainEqual({ predicate: "profile.name", label: "Name", value: "Ankit Kumar Singh" });
  });

  it("lists only the fields a revision changed, and a replaced photo reads Updated", () => {
    const { inventory, history } = sync([
      { inputs: [profile("Ankit")], kinds: ["profile"], now: T0 },
      { inputs: [profile("Ankit", { photo: "https://example.test/replaced-photo.png" })], kinds: ["profile"], now: T1 },
    ]);
    const projection = build({ inventory, history });
    const [replaced, added] = projection.history.entries;
    expect(replaced!.changes).toEqual([{ predicate: "profile.photo", label: "Photo", value: true }]);
    expect(liveMirrorHistoryDetail(replaced!)).toBe("Photo: Updated");
    expect(added!.changes.map(change => change.predicate)).toEqual(["profile.name", "profile.photo", "profile.email"]);
    expect(liveMirrorHistoryDetail(added!)).toBe("Name: Ankit, Photo: Added, Email: owner@example.test");
    expect(JSON.stringify(projection)).not.toContain("replaced-photo.png");
  });

  it("keeps record refs stable as records arrive, dated or not", () => {
    const consentAt = (id: string, createdAt: string | null, scope: string, status = "active"): LivingSourceInput => ({
      kind: "consent", id, createdAt, updatedAt: null, value: { scope, status },
    });
    const refs = (steps: Parameters<typeof sync>[0]) => Object.fromEntries(build(sync(steps)).facts
      .filter(fact => fact.predicate === "consent.scope").map(fact => [fact.value, fact.ref]));
    const first = { inputs: [consentAt("z-food", "2026-10-01T00:00:00.000Z", "attr.food.*"), consentAt("y-travel", null, "attr.travel.*")],
      kinds: ["consent"], now: T0 };
    expect(refs([first])).toEqual({ "attr.food.*": "Consent 1", "attr.travel.*": "Consent 2" });
    // Later: the undated record changes, an undated record whose id sorts
    // first arrives, and so does a newer dated one. No existing ref moves.
    const later = { inputs: [first.inputs[0]!, consentAt("y-travel", null, "attr.travel.*", "revoked"),
      consentAt("a-health", null, "attr.health.*"), consentAt("b-work", "2026-10-05T00:00:00.000Z", "attr.work.*")],
    kinds: ["consent"], now: T1 };
    expect(refs([first, later])).toEqual({
      "attr.food.*": "Consent 1", "attr.travel.*": "Consent 2", "attr.work.*": "Consent 3", "attr.health.*": "Consent 4",
    });
  });

  it("hides values of a record that was later removed, maps gaps and counts dropped changes", () => {
    const steps = [
      { inputs: [profile("Ankit", { dateOfBirth: "1990-01-01" }), consent("c1", "OLD_CONSENT_SCOPE")], kinds: ["profile", "consent"], now: T0 },
      { inputs: [profile("Ankit", { dateOfBirth: "1990-01-01" })], kinds: ["profile", "consent"], now: T1 },
    ];
    const kept = sync(steps.slice(0, 1));
    expect(JSON.stringify(build(kept))).toContain("OLD_CONSENT_SCOPE");
    expect(build(kept).history.droppedCount).toBe(0);

    const { inventory, history } = sync(steps);
    const gap: LivingSourceChange = {
      sequence: history.nextSequence, kind: "consent", id: "*", revision: 0, operation: "gap", capturedAt: T1, sourceUpdatedAt: null,
      value: { reason: "unobserved_changes", committedChanges: 3, verifiedChanges: 1, firstOccurredAt: T0, lastOccurredAt: T1 },
    };
    const rolled = { ...history, truncatedAt: T0, firstRetainedSequence: 6,
      changes: [...history.changes, gap].map(change => ({ ...change, sequence: change.sequence + 5 })) };
    const projection = build({ inventory, history: rolled });
    expect(projection.history.droppedCount).toBe(5);
    expect(projection.history.entries[0]).toMatchObject({ operation: "gap", ref: "Consents", changes: [], current: false,
      gap: { committedChanges: 3, verifiedChanges: 1 } });
    const consentEntries = projection.history.entries.filter(entry => entry.kind === "consent" && entry.operation !== "gap");
    expect(consentEntries.map(entry => [entry.operation, entry.current, entry.redacted, entry.changes]))
      .toEqual([["delete", true, false, []], ["upsert", false, true, []]]);
    const serialized = JSON.stringify(projection);
    expect(serialized).not.toContain("OLD_CONSENT_SCOPE");
    expect(serialized).not.toContain("1990-01-01");
  });

  it("never shows a disagreeing value as current", () => {
    const { inventory, history } = sync([{ inputs: [profile("NAME_A")], kinds: ["profile"], now: T1 }]);
    expect(build({ inventory, history }).facts.find(fact => fact.predicate === "profile.name")?.value).toBe("NAME_A");
    const record = inventory.records[0]!;
    const disagreeing = { ...inventory, records: [record, { ...record, value: { ...record.value, name: "NAME_X" } }] };
    const projection = build({ inventory: disagreeing, history });
    const names = projection.facts.filter(fact => fact.predicate === "profile.name");
    expect(names).toEqual([expect.objectContaining({ value: null, state: "conflicted" })]);
    expect(JSON.stringify(projection)).not.toMatch(/NAME_A|NAME_X/);
    expect(applyLiveMirrorReadTime(projection, T2, "current").overall).toBe("conflict");
  });

  it("keeps withheld and unavailable saved sections distinct, one row each", () => {
    const document = doc({
      excludedDomains: ["secrets"],
      freshness: [
        { domain: "identity", title: "Identity", status: "current", contentRevision: 7, updatedAt: null, cardCount: 1, withheld: ["wallet"] },
        { domain: "professional", title: "Professional", status: "unavailable", contentRevision: null, updatedAt: null, cardCount: 0, reason: "could not be read" },
      ],
    });
    const saved = build({ document }).sources.filter(source => source.group === "saved");
    expect(saved).toHaveLength(document.freshness.length + document.excludedDomains.length);
    expect(saved.map(source => [source.domain, source.state, source.reason, source.withheld])).toEqual([
      ["identity", "current", null, ["wallet"]],
      ["professional", "unavailable", "could_not_read", []],
      ["secrets", "withheld", "excluded_by_rule", []],
    ]);
  });

  it("decides freshness at read time from verification age plus grace", () => {
    const { inventory, history } = sync([{ inputs: [profile("Ankit"), consent("c1", "attr.food.*")], kinds: ["profile", "consent"], now: T0 }]);
    const projection = build({ inventory, history, now: T0 });
    const fresh = applyLiveMirrorReadTime(projection, Date.parse(T0) + WINDOW_MS - 1_000, "current");
    expect(fresh.overall).toBe("current");
    expect(fresh.facts.every(fact => fact.state === "verified")).toBe(true);
    const expired = applyLiveMirrorReadTime(projection, Date.parse(T0) + WINDOW_MS + 1_000, "current");
    expect(expired).toMatchObject({ overall: "stale", lastVerifiedAt: T0 });
    expect(expired.facts.every(fact => fact.state === "stale")).toBe(true);
    expect(expired.markdown).toContain("Name: Ankit · May be old");

    const pending = { version: 1 as const, kinds: { consent: { count: 3, firstOccurredAt: T0, lastOccurredAt: T0, historySequence: 2 } } };
    const waiting = applyLiveMirrorReadTime(build({ inventory, history, now: T0, pending }), T0, "current");
    expect(waiting.overall).toBe("updating");
    expect(waiting.sources.find(source => source.id === "living:consent")).toMatchObject({ state: "updating", pendingChanges: 3 });
  });

  it.each([
    ["refresh_failed", ["consent"], true, "partial"],
    ["refresh_failed", [], true, "conflict"],
    ["refresh_pending", [], true, "conflict"],
    ["refresh_pending", [], false, "updating"],
    ["refresh_failed", [], false, "stale"],
    ["stale", [], false, "stale"],
    ["current", [], false, "current"],
  ] as const)("ranks a %s view with unavailable %o and name conflict %s as %s", (viewStatus, unavailable, nameConflict, overall) => {
    const { inventory, history } = sync([{ inputs: [profile("Ankit")], kinds: ["profile"], unavailable: [...unavailable], now: T1 }]);
    expect(applyLiveMirrorReadTime(build({ inventory, history, nameConflict }), T2, viewStatus).overall).toBe(overall);
  });

  it("is empty only when there are no facts and no history", () => {
    expect(applyLiveMirrorReadTime(build(), T2, "current").overall).toBe("empty");
  });

  it("escapes hostile values so the preview cannot open images, HTML, links or new blocks", () => {
    const hostile = "# Hi ![t](https://x.test/p.png) <script>alert(1)</script> [l](javascript:alert(1))";
    const markdown = build(sync([{ inputs: [profile(hostile)], kinds: ["profile"], now: T1 }])).markdown;
    expect(markdown).toContain("## Profile");
    expect(markdown).not.toMatch(/!\[t\]\(/);
    expect(markdown).not.toContain("<script");
    expect(markdown).not.toContain("](javascript:");
    const injected = build(sync([{ inputs: [profile("Ankit\n## Injected")], kinds: ["profile"], now: T1 }])).markdown;
    expect(injected).not.toMatch(/^## Injected/m);
  });

  it("previews from level two without repeating the panel, with readable times and one line for empty sources", () => {
    const { inventory, history } = sync([{ inputs: [profile("Ankit")], kinds: ["profile", "consent"], now: T1 }]);
    const gap: LivingSourceChange = {
      sequence: history.nextSequence, kind: "connection", id: "*", revision: 0, operation: "gap", capturedAt: T1, sourceUpdatedAt: null,
      value: { reason: "unobserved_changes", committedChanges: 1, verifiedChanges: 0, firstOccurredAt: T0, lastOccurredAt: T1 },
    };
    const markdown = applyLiveMirrorReadTime(build({ inventory, history: { ...history, changes: [...history.changes, gap] } }), T2, "current").markdown;
    expect(markdown.startsWith("## Profile\n")).toBe(true);
    expect(markdown).not.toMatch(/^# /m);
    for (const repeated of ["Live memory", "Up to date", "Updates while", "Only changes seen"]) expect(markdown).not.toContain(repeated);
    expect(markdown).not.toMatch(/\d{4}\\?-\d{2}\\?-\d{2}T\d{2}/);
    expect(markdown.match(/Nothing recorded/g)).toHaveLength(1);
    expect(markdown).toContain("_Nothing recorded: Consents, Connections, Connected apps, Earnings, Wallet activity, Document payments._");
    expect(markdown).toContain("Connections · 1 change made\\, nothing new seen");
  });
});

describe("Live Mirror presentation", () => {
  it("formats values for people: money, times, states and scope names", () => {
    expect(formatLiveMirrorValue("document_earning.grossCents", 123_456)).toBe("$1,234.56");
    expect(formatLiveMirrorValue("document_request_payment.amountCents", 1_200, { currency: "eur" })).toBe("€12.00");
    expect(formatLiveMirrorValue("consent.expiresAt", "2026-11-01T00:00:00.000Z", { timeZone: "UTC" }).replace(/\s/g, " "))
      .toBe("Nov 1, 2026, 12:00 AM");
    expect(formatLiveMirrorValue("document_earning.status", "succeeded")).toBe("Paid");
    expect(formatLiveMirrorValue("document_earning.stripeMode", "test")).toBe("Test mode");
    expect(formatLiveMirrorValue("document_earning.status", "awaiting_delivery")).toBe("Awaiting delivery");
    expect(formatLiveMirrorValue("consent.scope", "attr.financial.*")).toBe("Financial data");
    expect(formatLiveMirrorValue("consent.active", false)).toBe("No");
    // Owner text is never relabelled as a state.
    expect(formatLiveMirrorValue("profile.name", "test")).toBe("test");
  });
});
