import { beforeEach, describe, expect, it } from "vitest";
import { buildConsentExportForScope, answerable, compose, deliver, loadMarkdownMemory, encrypt, work, params, resetAnswerFixture } from "./fixtures";
import { buildAnswerPayload, runAnswerDeliverySweep } from "@/lib/answers/answer-delivery-sweep";

beforeEach(resetAnswerFixture);

import { projectApprovedSoulFacts } from "@/lib/answers/identity-soul-facts";

// Exactly what the identity intake writes (`suppliedIdentityFacts`).
const SOUL = [
  "# Soul.md",
  "",
  "## Facts",
  "",
  "- Legal name: Smirthika Dharmalingam",
  "- Date of birth: 1998-03-14",
  "- Sex: female",
  "- Citizenship: India / IN",
  "- Favourite coffee is a flat white",
  "",
].join("\n");

const NOW = new Date("2026-03-13T00:00:00Z");
const scope = (path: string) => `attr.identity.${path}`;

describe("approved identity facts come from the Soul bullets the product wrote", () => {
  it.each([
    "attr.business.identity_profile.date_of_birth",
    "attr.identity.other.identity_profile.date_of_birth",
    "attr.business.identity_profile.*",
  ])("does not disclose identity facts under another scope: %s", (approvedScope) => {
    expect(projectApprovedSoulFacts({ approvedScopes: [approvedScope], markdown: SOUL, now: NOW })).toEqual([]);
  });
  it("answers a name request from the recorded legal name", () => {
    const [fact, ...rest] = projectApprovedSoulFacts({
      approvedScopes: [scope("identity_profile.full_name")],
      markdown: SOUL,
      now: NOW,
    });
    expect(rest).toHaveLength(0);
    expect(fact).toMatchObject({ path: "full_name", value: "Smirthika Dharmalingam" });
  });

  it("answers an age request with the age, and never the birth date", () => {
    const projected = projectApprovedSoulFacts({
      approvedScopes: [scope("identity_profile.declared_age")],
      markdown: SOUL,
      now: NOW,
    });
    expect(projected).toHaveLength(1);
    expect(projected[0]).toMatchObject({
      path: "declared_age",
      value: "27",
      derived: "age_from_date_of_birth",
    });
    // The birth date is a separate decision and was not approved here.
    expect(JSON.stringify(projected)).not.toContain("1998-03-14");
  });

  it("gives the birth date only when its own scope was approved", () => {
    const projected = projectApprovedSoulFacts({
      approvedScopes: [scope("identity_profile.date_of_birth")],
      markdown: SOUL,
      now: NOW,
    });
    expect(projected).toEqual([
      expect.objectContaining({ path: "date_of_birth", value: "1998-03-14" }),
    ]);
  });

  it("never hands over an unapproved fact, or the prose around it", () => {
    const projected = projectApprovedSoulFacts({
      approvedScopes: [scope("identity_profile.full_name")],
      markdown: SOUL,
      now: NOW,
    });
    const rendered = JSON.stringify(projected);
    expect(rendered).not.toContain("female");
    expect(rendered).not.toContain("India");
    expect(rendered).not.toContain("flat white");
    expect(rendered).not.toContain("1998-03-14");
  });

  it("says nothing rather than guessing when the fact was never recorded", () => {
    const projected = projectApprovedSoulFacts({
      approvedScopes: [scope("identity_profile.sex"), scope("identity_profile.declared_age")],
      markdown: "## Facts\n\n- Legal name: Someone\n",
      now: NOW,
    });
    // No sex recorded and no birth date to work an age from.
    expect(projected).toEqual([]);
  });

  it("does not infer sex from a name, a pronoun or anything else nearby", () => {
    const projected = projectApprovedSoulFacts({
      approvedScopes: [scope("identity_profile.sex")],
      markdown: "## Facts\n\n- Legal name: Smirthika Dharmalingam\n- She prefers window seats\n",
      now: NOW,
    });
    expect(projected).toEqual([]);
  });
});

// The identity intake writes what the person states as labelled Soul bullets,
// so these are the paths a real "what is your name" / "what is your age"
// request actually has to read.
describe("identity facts recorded in Soul.md answer the question they were approved for", () => {
  const SOUL = [
    "## Facts",
    "",
    "- Legal name: Smirthika Dharmalingam",
    "- Date of birth: 1998-03-14",
    "- Sex: female",
    "- Saving for a trip to Kyoto",
    "",
  ].join("\n");

  const identityWork = (scope: string) =>
    work({ approvedScopes: [scope], question: "What is your age?" });

  beforeEach(() => {
    loadMarkdownMemory.mockResolvedValue({ markdown: SOUL, dataVersion: 12 });
    // A successful empty canonical read admits the alternate source.
    buildConsentExportForScope.mockResolvedValue({ payload: {} });
  });

  it.each(["owner denied", "manifest changed", "source invalidated"])("does not replace a failed canonical export: %s", async (reason) => {
    const scope = "attr.identity.identity_profile.full_name";
    buildConsentExportForScope.mockRejectedValue(new Error(reason));
    const { payload, hasContent } = await buildAnswerPayload(identityWork(scope), params);
    expect(payload.unavailableScopes).toEqual([scope]);
    expect(hasContent).toBe(false);
    expect(loadMarkdownMemory).not.toHaveBeenCalled();
  });

  it("retains a current structured fact over a stale Soul value", async () => {
    const scope = "attr.identity.identity_profile.full_name";
    buildConsentExportForScope.mockResolvedValue({ payload: { identity_profile: { full_name: "Current owner name" } }, sourceContentRevision: 19 });
    const { payload } = await buildAnswerPayload(identityWork(scope), params);
    expect(payload.approvedInformation[scope]).toEqual({ identity_profile: { full_name: "Current owner name" } });
    expect(payload.sourceRevisions[scope]).toBe(19);
    expect(loadMarkdownMemory).not.toHaveBeenCalled();
  });

  it("keeps every mapped fact in the exact approved parent wildcard", async () => {
    const scope = "attr.identity.identity_profile.*";
    const { payload } = await buildAnswerPayload(identityWork(scope), params);
    expect(payload.approvedInformation[scope]).toMatchObject({ identity_profile: {
      full_name: "Smirthika Dharmalingam", date_of_birth: "1998-03-14", sex: "female", declared_age: expect.any(String),
    } });
  });

  it("does not use the public account name for an unrelated nested name", async () => {
    const scope = "attr.identity.employer.name";
    const { hasContent } = await buildAnswerPayload(identityWork(scope), { ...params, ownerIdentity: { displayName: "Public owner name" } });
    expect(hasContent).toBe(false);
    expect(loadMarkdownMemory).not.toHaveBeenCalled();
  });

  it("puts the age, not the birth date, into what the writer is given", async () => {
    const { payload, hasContent } = await buildAnswerPayload(
      identityWork("attr.identity.identity_profile.declared_age"),
      params,
    );

    expect(hasContent).toBe(true);
    const rendered = JSON.stringify(payload);
    expect(rendered).toContain("declared_age");
    // The birth date is its own approval and was not given here.
    expect(rendered).not.toContain("1998-03-14");
    expect(payload.sourceRevisions["attr.identity.identity_profile.declared_age"]).toBe(12);
  });

  it("answers a name request from the recorded legal name", async () => {
    const { payload, hasContent } = await buildAnswerPayload(
      identityWork("attr.identity.identity_profile.full_name"),
      params,
    );
    expect(hasContent).toBe(true);
    expect(JSON.stringify(payload)).toContain("Smirthika Dharmalingam");
  });

  it("carries no unapproved fact and none of the surrounding prose", async () => {
    const { payload } = await buildAnswerPayload(
      identityWork("attr.identity.identity_profile.declared_age"),
      params,
    );
    const rendered = JSON.stringify(payload);
    expect(rendered).not.toContain("female");
    expect(rendered).not.toContain("Kyoto");
    expect(rendered).not.toContain("Smirthika Dharmalingam");
  });

  it("stays pending when the Soul document cannot be read", async () => {
    // Locked or failed: not an absent fact, so it must not deliver "not found".
    loadMarkdownMemory.mockRejectedValue(new Error("vault locked"));
    const { payload } = await buildAnswerPayload(
      identityWork("attr.identity.identity_profile.declared_age"),
      params,
    );
    expect(payload.unavailableScopes).toContain(
      "attr.identity.identity_profile.declared_age",
    );
  });

  it("says nothing rather than guessing a sex that was never recorded", async () => {
    loadMarkdownMemory.mockResolvedValue({
      markdown: "## Facts\n\n- Legal name: Smirthika Dharmalingam\n- She prefers window seats\n",
      dataVersion: 3,
    });
    const { hasContent } = await buildAnswerPayload(
      identityWork("attr.identity.identity_profile.sex"),
      params,
    );
    expect(hasContent).toBe(false);
  });
});

describe("the three outcomes of preparing an answer, at staging level", () => {
  const AGE = "attr.identity.identity_profile.declared_age";

  const sweep = () =>
    runAnswerDeliverySweep({
      userId: "owner-A",
      vaultKey: "key",
      vaultOwnerToken: "token",
      firebaseIdToken: "id-token",
      ownerIdentity: {
        displayName: "Smirthika Dharmalingam",
        photoUrl: "https://example.test/photo.png",
      },
    });

  const askAge = () =>
    answerable.mockResolvedValue([
      work({ approvedScopes: [AGE], question: "What is your age?" }),
    ]);

  it("stages nothing and stays retryable when the document cannot be read", async () => {
    // Locked, stale or denied: not an answer in either direction.
    loadMarkdownMemory.mockRejectedValue(new Error("vault locked"));
    buildConsentExportForScope.mockResolvedValue({ payload: {} });
    askAge();

    const result = await sweep();

    expect(deliver).not.toHaveBeenCalled();
    expect(compose).not.toHaveBeenCalled();
    expect(result).toMatchObject({ retry: 1, delivered: 0, empty: 0 });
  });

  it("settles a fact nobody recorded as absent, so it is answered not retried", async () => {
    // The document read SUCCEEDED and the fact is simply not in it. That is a
    // verified absence -- an answer -- and it used to sit unreadable for ever.
    loadMarkdownMemory.mockResolvedValue({
      markdown: "## Facts\n\n- Legal name: Smirthika Dharmalingam\n",
      dataVersion: 12,
    });
    buildConsentExportForScope.mockResolvedValue({ payload: {} });
    askAge();

    const result = await sweep();

    expect(deliver).toHaveBeenCalledTimes(1);
    // "Answer not found", and checkout refuses an empty staged answer.
    expect(deliver.mock.calls[0]![2]).toMatchObject({ hasContent: false });
    expect(result).toMatchObject({ empty: 1, retry: 0, delivered: 0 });
  });

  it("does not let the account name or photo make a missing age chargeable", async () => {
    // Both are carried into the document's Account section for every answer.
    // If they counted as content, an age nobody recorded would be sold.
    loadMarkdownMemory.mockResolvedValue({ markdown: "## Facts\n", dataVersion: 12 });
    buildConsentExportForScope.mockResolvedValue({ payload: {} });
    askAge();

    await sweep();

    expect(deliver.mock.calls[0]![2]).toMatchObject({ hasContent: false });
  });
});

describe("a Soul-backed fact is finished work, not a failed read", () => {
  const SOUL = "## Facts\n\n- Legal name: Smirthika Dharmalingam\n- Date of birth: 1998-03-14\n";

  it("composes and stages when the structured leaf is simply absent", async () => {
    // Identity facts have no structured leaf at all, so the per-scope export
    // always fails for them. If that counts as an unreadable scope the request
    // retries for ever and the answer is never staged, even though the fact
    // was read successfully from the document.
    loadMarkdownMemory.mockResolvedValue({ markdown: SOUL, dataVersion: 12 });
    buildConsentExportForScope.mockResolvedValue({ payload: {} });
    compose.mockResolvedValue({
      answerMode: "agent",
      answer: "She is 27.",
      covers: ["attr.identity.identity_profile.declared_age"],
      gaps: [],
    });
    encrypt.mockResolvedValue({ ciphertext: "sealed" });
    answerable.mockResolvedValue([
      work({
        approvedScopes: ["attr.identity.identity_profile.declared_age"],
        question: "What is your age?",
      }),
    ]);

    const result = await runAnswerDeliverySweep({
      userId: "owner-A",
      vaultKey: "key",
      vaultOwnerToken: "token",
      firebaseIdToken: "id-token",
    });

    expect(compose).toHaveBeenCalledTimes(1);
    expect(deliver).toHaveBeenCalledTimes(1);
    expect(deliver.mock.calls[0]![2]).toMatchObject({ hasContent: true });
    expect(result).toMatchObject({ delivered: 1, retry: 0, empty: 0 });
  });
});

describe("which name answers a name request", () => {
  const NAME = "attr.identity.identity_profile.full_name";

  const ask = () =>
    answerable.mockResolvedValue([
      work({ approvedScopes: [NAME], question: "What is your name?" }),
    ]);

  beforeEach(() => {
    buildConsentExportForScope.mockResolvedValue({ payload: {} });
    compose.mockResolvedValue({ answerMode: "agent", answer: "Smirthika.", covers: [], gaps: [] });
    encrypt.mockResolvedValue({ ciphertext: "sealed" });
  });

  it("prefers the legal name the person stated over their account name", async () => {
    loadMarkdownMemory.mockResolvedValue({
      markdown: "## Facts\n\n- Legal name: Smirthika Dharmalingam\n",
      dataVersion: 9,
    });
    ask();

    await runAnswerDeliverySweep({
      userId: "owner-A", vaultKey: "key", vaultOwnerToken: "token",
      firebaseIdToken: "id-token",
      ownerIdentity: { displayName: "smiri" },
    });

    const values = JSON.stringify(compose.mock.calls[0]![2].values);
    expect(values).toContain("Smirthika Dharmalingam");
    expect(values).not.toContain("smiri");
  });

  it("falls back to the account name when no legal name was ever stated", async () => {
    // An owner who never completed the identity intake can still answer this.
    loadMarkdownMemory.mockResolvedValue({ markdown: "## Facts\n", dataVersion: 9 });
    ask();

    const result = await runAnswerDeliverySweep({
      userId: "owner-A", vaultKey: "key", vaultOwnerToken: "token",
      firebaseIdToken: "id-token",
      ownerIdentity: { displayName: "Smirthika D" },
    });

    expect(JSON.stringify(compose.mock.calls[0]![2].values)).toContain("Smirthika D");
    expect(result).toMatchObject({ delivered: 1, retry: 0, empty: 0 });
  });
});
