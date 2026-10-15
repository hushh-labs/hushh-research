import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { describe, expect, it } from "vitest";
import routeLayout from "@/lib/navigation/app-route-layout.contract.json";
import { LIVE_MIRROR_KINDS, type LiveMirrorKind } from "@/lib/pkm/live-mirror-contract";
import {
  applyLiveMirrorReadTime,
  buildLiveMirrorProjection,
  type BuildLiveMirrorProjectionParams,
} from "@/lib/pkm/live-mirror-projection";
import { formatLiveMirrorValue, liveMirrorHistoryDetail, liveMirrorSourceRoute } from "@/lib/pkm/live-mirror-presentation";
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

/** Markdown rendered as the app renders it (react-markdown with GFM), so links and tables are judged as rendered. */
function rendered(markdown: string): Document {
  const html = renderToStaticMarkup(createElement(Markdown, { remarkPlugins: [remarkGfm] }, markdown));
  return new DOMParser().parseFromString(html, "text/html");
}
/** Text as read; the invisible word joiner that keeps owner text from linking is dropped. */
const visible = (node: Element) => (node.textContent ?? "").replaceAll("\u2060", "");

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
    const named = { nameConflict: true, nameClaims: { soul: ["Ankit K"], profile: "Ankit" } };
    for (const rejected of [build({ inventory: foreignProfile, history, ...named }), build({ inventory, history: foreignHistory, ...named })]) {
      expect(rejected.facts).toHaveLength(0);
      expect(rejected.history.entries).toHaveLength(0);
      expect(rejected.issues).toContain("owner_mismatch");
      expect(rejected.sources.filter(source => source.group === "living").every(source => source.state === "unavailable")).toBe(true);
      expect(rejected.markdown).not.toContain("Ankit");
      // A mirror that fails closed reports no conflict or claim either.
      expect(rejected).toMatchObject({ nameConflict: false, conflicts: [] });
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

  it("never shows a disagreeing value as current, and lists every side as a claim for review", () => {
    const earning: LivingSourceInput = { kind: "document_earning", id: "e1", createdAt: T0, updatedAt: T0,
      value: { stripeMode: "live", status: "succeeded", grossCents: 1_111, createdAt: T0 } };
    const { inventory, history } = sync([{ inputs: [profile("NAME_A"), consent("c1", "SCOPE_A"), earning],
      kinds: ["profile", "consent", "document_earning"], now: T1 }]);
    const clean = build({ inventory, history });
    expect(clean.facts.find(fact => fact.predicate === "profile.name")?.value).toBe("NAME_A");
    expect(clean.conflicts).toEqual([]);
    const disagree = (kind: string, change: Record<string, unknown>) => {
      const record = inventory.records.find(each => each.kind === kind)!;
      return [record, { ...record, value: { ...record.value, ...change } }];
    };
    const projection = build({ history, inventory: { ...inventory, records: [
      ...disagree("profile", { name: "NAME_X", photo: null }),
      ...disagree("consent", { scope: "SCOPE_X", counterpart: "OTHER_PERSON_X" }),
      ...disagree("document_earning", { grossCents: 2_222 }),
    ] } });
    const names = projection.facts.filter(fact => fact.predicate === "profile.name");
    expect(names).toEqual([expect.objectContaining({ value: null, state: "conflicted" })]);
    // No side is selected anywhere a value is read as current, the money table included.
    const current = `${JSON.stringify([projection.facts, projection.history])}${projection.markdown.replaceAll("\\", "")}`;
    expect(current).not.toMatch(/NAME_A|NAME_X|SCOPE_A|SCOPE_X|1111|2222|11\.11|22\.22/);
    expect(projection.markdown).toContain("| Earning 1 · Needs review | — | — | — |");
    // Every side is a claim naming its record and revision, one conflict per
    // field in display order. Agreeing fields, other people's identifiers and
    // the photo URL never become claims.
    const claim = (source: LiveMirrorKind, label: string, value: unknown) =>
      ({ source, label, value, revision: 1, sourceUpdatedAt: T0, verifiedAt: T1 });
    expect(projection.conflicts).toEqual([
      { predicate: "profile.name", label: "Name", claims: [claim("profile", "Profile", "NAME_A"), claim("profile", "Profile", "NAME_X")] },
      { predicate: "profile.photo", label: "Photo", claims: [claim("profile", "Profile", true), claim("profile", "Profile", false)] },
      { predicate: "consent.scope", label: "Scope", claims: [claim("consent", "Consent 1", "SCOPE_A"), claim("consent", "Consent 1", "SCOPE_X")] },
      { predicate: "document_earning.grossCents", label: "Gross",
        claims: [claim("document_earning", "Earning 1", 1_111), claim("document_earning", "Earning 1", 2_222)] },
    ]);
    expect(JSON.stringify(projection.conflicts)).not.toMatch(/OTHER_PERSON|private-photo|status/);
    expect(projection.nameConflict).toBe(false);
    const view = applyLiveMirrorReadTime(projection, T2, "current");
    expect(view.overall).toBe("conflict");
    expect(view.conflicts).toEqual(projection.conflicts);
  });

  it("shows both names with their provenance when memory and the verified profile disagree", () => {
    const { inventory, history } = sync([{ inputs: [profile("Ankit")], kinds: ["profile"], now: T1 }]);
    const document = doc({ complete: false, freshness: [
      { domain: "one_memory", title: "Identity facts", status: "conflicted", contentRevision: 9, updatedAt: T0, cardCount: 1 },
    ] });
    const projection = build({ inventory, history, document, nameConflict: true, nameClaims: { soul: ["Ankit K"], profile: "Ankit" } });
    expect(projection.nameConflict).toBe(true);
    expect(projection.conflicts).toEqual([{ predicate: "profile.name", label: "Name", claims: [
      { source: "soul", label: "Memory (you wrote)", value: "Ankit K", revision: 9, sourceUpdatedAt: T0, verifiedAt: null },
      { source: "profile", label: "Profile", value: "Ankit", revision: 1, sourceUpdatedAt: T0, verifiedAt: T1 },
    ] }]);
    // The verified fact stays as it is: nothing is overwritten by the review.
    expect(projection.facts.find(fact => fact.predicate === "profile.name")).toMatchObject({ value: "Ankit", state: "verified" });
    // Read time keeps both sides, and a failed refresh never hides the conflict.
    const view = applyLiveMirrorReadTime(projection, T2, "refresh_failed");
    expect(view.overall).toBe("conflict");
    expect(view.conflicts).toEqual(projection.conflicts);
    // Negative control: without the document's conflict, names alone raise none.
    expect(build({ inventory, history, nameClaims: { soul: ["Ankit K"], profile: "Ankit" } }))
      .toMatchObject({ nameConflict: false, conflicts: [] });
    // A side that is not known stays null rather than invented.
    expect(build({ inventory, history, nameConflict: true }).conflicts?.[0]?.claims.map(each => each.value)).toEqual([null, "Ankit"]);
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

  it("renders money sources as tables and the rest as lists, with one link per section to its source", () => {
    const hostile = "Paid | [x](https://x.test) www.evil.test <b> a@b.test";
    const { inventory, history } = sync([{ inputs: [
      profile("Ankit https://x.test/p.png"),
      consent("c1", "attr.food.*"),
      { kind: "document_earning", id: "e1", createdAt: T0, updatedAt: T0,
        value: { stripeMode: "test", status: "succeeded", grossCents: 123_456, netCents: 120_000, createdAt: T0 } },
      { kind: "payout_activity", id: "p1", createdAt: T0, updatedAt: T0,
        value: { kind: "redemption", mode: "live", occurredAt: T0, amountCents: 5_000, status: hostile } },
      { kind: "document_request_payment", id: "r1", createdAt: T0, updatedAt: T0,
        value: { counterpartRef: "OTHER_REF", mode: "live", status: "paid", amountCents: 1_200, currency: "eur", paidAt: T0 } },
    ], kinds: [...LIVE_MIRROR_KINDS], now: T0 }]);
    const projection = build({ inventory, history, now: T0 });
    const page = rendered(projection.markdown);
    // One four-column table per money source. The hostile value stays one
    // literal cell: its pipe splits nothing and its HTML never renders.
    const when = formatLiveMirrorValue("document_earning.createdAt", T0);
    const head = ["Record", "Amount", "Status", "When"];
    expect([...page.querySelectorAll("table")].map(table => [...table.rows].map(row => [...row.cells].map(visible)))).toEqual([
      [head, ["Earning 1 · Test mode", "$1,234.56", "Paid", when]],
      [head, ["Wallet activity 1 · Redemption", "$50.00", hostile, when]],
      [head, ["Document payment 1", "€12.00", "Paid", when]],
    ]);
    expect(page.querySelector("img, script, b")).toBeNull();
    expect(projection.markdown).toContain("- Consent 1\n  - Scope: Food data");
    expect(projection.markdown).not.toContain("OTHER_REF");
    // The only links are the sections' generated ones, each to an existing route.
    const routes = new Set(routeLayout.map(entry => entry.route));
    const sections: LiveMirrorKind[] = ["profile", "consent", "document_earning", "payout_activity", "document_request_payment"];
    const links = [...page.querySelectorAll("a")].map(link => [link.getAttribute("href"), visible(link)]);
    expect(links).toEqual(sections.map(kind => [liveMirrorSourceRoute(kind)!.href, liveMirrorSourceRoute(kind)!.label]));
    for (const [href] of links) expect(routes.has(href!.split("?")[0]!), href!).toBe(true);
    // Negative control: this renderer links URL and email text, escaped or not.
    expect(rendered("www.evil.test a@b.test https\\:\\/\\/x\\.test www\\.evil\\.test").querySelectorAll("a")).toHaveLength(4);
    // Deterministic, and read-time states reach the record cell.
    expect(build({ inventory: structuredClone(inventory), history: structuredClone(history), now: T0 }).markdown).toBe(projection.markdown);
    expect(applyLiveMirrorReadTime(projection, Date.parse(T0) + WINDOW_MS + 1_000, "current").markdown)
      .toContain("| Earning 1 · Test mode · May be old |");
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
  it("sends every source to an existing surface the owner changes it on, with a short label", () => {
    const routes = new Set(routeLayout.map(entry => entry.route));
    const expected: Record<LiveMirrorKind, string> = {
      profile: "/one/profile/account",
      consent: "/one/consent",
      connection: "/one/connect",
      curated_oauth_connector: "/one/profile/connectors",
      document_earning: "/one/profile/payouts",
      payout_activity: "/one/profile/payouts",
      document_request_payment: "/one/consent?tab=pending&requestView=sent",
    };
    for (const kind of LIVE_MIRROR_KINDS) {
      const route = liveMirrorSourceRoute(kind);
      expect(route?.href, kind).toBe(expected[kind]);
      expect(routes.has(route!.href.split("?")[0]!), `${kind} -> ${route!.href}`).toBe(true);
      expect(route!.label, kind).toMatch(/^[A-Z][a-z]+(?: [a-z]+){0,2}$/);
    }
    // Negative control: a name that is not a source kind has no route.
    expect(liveMirrorSourceRoute("__proto__" as LiveMirrorKind)).toBeNull();
  });

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
