import { beforeEach, describe, expect, it } from "vitest";
import { buildConsentExportForScope, answerable, compose, deliver, loadMarkdownMemory, encrypt, work, params, resetAnswerFixture, setScopeProjection, setSoulMemory, refreshIdentityForSession } from "./fixtures";
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
    "attr.health.identity_profile.sex",
    "attr.travel.identity_profile.full_name",
    "attr.health.identity_profile.*",
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
    setSoulMemory({ markdown: SOUL, dataVersion: 12 });
    // No structured leaf exists for these; Soul.md is the only source.
    buildConsentExportForScope.mockRejectedValue(new Error("no structured leaf"));
  });

  it("puts the age, not the birth date, into what the writer is given", async () => {
    compose.mockResolvedValue({ answerMode: "agent", compositionReceipt: "synthetic-composition-receipt", answer: "The approved current age is available.", covers: ["attr.identity.identity_profile.declared_age"], gaps: [] });
    const { payload, hasContent } = await buildAnswerPayload(
      identityWork("attr.identity.identity_profile.declared_age"),
      { ...params, ownerIdentity: { displayName: "UNAPPROVED_ACCOUNT_NAME", email: "unapproved@example.test", photoUrl: "https://example.test/unapproved-photo.png" } },
      "firebase-token",
    );

    expect(hasContent).toBe(true);
    const rendered = JSON.stringify(payload);
    expect(rendered).toContain("declared_age");
    // The birth date is its own approval and was not given here.
    expect(rendered).not.toContain("1998-03-14");
    expect(payload.sourceRevisions["attr.identity.identity_profile.declared_age"]).toBe(12);
    expect(compose).toHaveBeenCalledTimes(1);
    const input = JSON.stringify(compose.mock.calls[0]![2]);
    expect(input).toContain("declared_age");
    for (const unapproved of ["1998-03-14", "female", "Kyoto", "Smirthika Dharmalingam", "UNAPPROVED_ACCOUNT_NAME", "unapproved@example.test", "unapproved-photo.png", "Profile photo included"]) expect(input).not.toContain(unapproved);
  });

  it("sends only an explicitly saved sex to Gemini", async () => {
    compose.mockResolvedValue({ answerMode: "agent", compositionReceipt: "synthetic-composition-receipt", answer: "The recorded sex is female.", covers: ["attr.identity.identity_profile.sex"], gaps: [] });
    const result = await buildAnswerPayload(
      work({ approvedScopes: ["attr.identity.identity_profile.sex"], question: "What sex did you record?" }),
      { ...params, ownerIdentity: { displayName: "Unapproved name", photoUrl: "https://example.test/unapproved-photo.png" } },
      "firebase-token",
    );
    expect(result.hasContent).toBe(true);
    expect(result.payload.answer).toBe("The recorded sex is female.");
    const input = JSON.stringify(compose.mock.calls[0]![2]);
    expect(input).toContain("female");
    for (const unapproved of ["1998-03-14", "declared_age", "Kyoto", "Smirthika Dharmalingam", "Unapproved name", "unapproved-photo.png"]) expect(input).not.toContain(unapproved);
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
    setSoulMemory({
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
    buildConsentExportForScope.mockRejectedValue(new Error("no structured leaf"));
    askAge();

    const result = await sweep();

    expect(deliver).not.toHaveBeenCalled();
    expect(compose).not.toHaveBeenCalled();
    expect(result).toMatchObject({ retry: 1, delivered: 0, empty: 0 });
  });

  it("settles a fact nobody recorded as absent, so it is answered not retried", async () => {
    // The document read SUCCEEDED and the fact is simply not in it. That is a
    // verified absence -- an answer -- and it used to sit unreadable for ever.
    setSoulMemory({
      markdown: "## Facts\n\n- Legal name: Smirthika Dharmalingam\n",
      dataVersion: 12,
    });
    buildConsentExportForScope.mockRejectedValue(new Error("no structured leaf"));
    askAge();

    const result = await sweep();

    expect(deliver).toHaveBeenCalledTimes(1);
    // "Answer not found", and checkout refuses an empty staged answer.
    expect(deliver.mock.calls[0]![2]).toMatchObject({ hasContent: false });
    expect(result).toMatchObject({ empty: 1, retry: 0, delivered: 0 });
  });

  it("does not let the account name or photo make a missing age chargeable", async () => {
    // Public profile fields cannot replace the approved missing age.
    setSoulMemory({ markdown: "## Facts\n", dataVersion: 12 });
    buildConsentExportForScope.mockRejectedValue(new Error("no structured leaf"));
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
    setSoulMemory({ markdown: SOUL, dataVersion: 12 });
    buildConsentExportForScope.mockRejectedValue(new Error("no structured leaf"));
    compose.mockResolvedValue({
      answerMode: "agent", compositionReceipt: "synthetic-composition-receipt",
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
    buildConsentExportForScope.mockRejectedValue(new Error("no structured leaf"));
    compose.mockResolvedValue({ answerMode: "agent", compositionReceipt: "synthetic-composition-receipt", answer: "Smirthika.", covers: [], gaps: [] });
    encrypt.mockResolvedValue({ ciphertext: "sealed" });
  });

  it("prefers the legal name the person stated over their account name", async () => {
    setSoulMemory({
      markdown: "## Facts\n\n- Legal name: Smirthika Dharmalingam\n",
      dataVersion: 9,
    });
    ask();

    await runAnswerDeliverySweep({
      userId: "owner-A", vaultKey: "key", vaultOwnerToken: "token",
      firebaseIdToken: "id-token",
      ownerIdentity: { displayName: "smiri" },
    });

    const input = JSON.stringify(compose.mock.calls[0]![2]);
    expect(input).toContain("Smirthika Dharmalingam");
    expect(input).not.toContain("smiri");
  });

  it("falls back to the account name when no legal name was ever stated", async () => {
    // An owner who never completed the identity intake can still answer this.
    setSoulMemory({ markdown: "## Facts\n", dataVersion: 9 });
    refreshIdentityForSession.mockResolvedValue({ user_id: "owner-A", display_name: "Smirthika D" });
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


describe("existing profile identity acceptance", () => {
  const NAME = "attr.identity.identity_profile.full_name";
  const PHOTO = "attr.identity.identity_profile.profile_photo_url";
  it("prepares name and photo without an identity intake and seals the trusted photo", async () => {
    buildConsentExportForScope.mockRejectedValue(new Error("source absent"));
    setSoulMemory({ markdown: "", persisted: false });
    compose.mockResolvedValue({ answerMode: "agent", compositionReceipt: "synthetic-composition-receipt", answer: "Synthetic Ava's name and photo.", covers: [NAME, PHOTO], gaps: [] });
    const result = await buildAnswerPayload(work({ approvedScopes: [NAME, PHOTO] }), { ...params, ownerIdentity: { displayName: "Synthetic Ava", photoUrl: "https://example.test/avatar.jpg" } }, "token");
    expect(result.hasContent).toBe(true);
    expect(result.payload.unavailableScopes).toEqual([]);
    expect(result.payload.approvedInformation[PHOTO]).toEqual({ identity_profile: { profile_photo_url: "https://example.test/avatar.jpg" } });
    expect(result.payload.ownerIdentity?.photoUrl).toBe("https://example.test/avatar.jpg");
    expect(loadMarkdownMemory).toHaveBeenCalledWith(expect.objectContaining({ forceRefresh: true }));
  });
  it.each(["declared_age", "sex"])("does not sell a known name with missing %s", async field => {
    setScopeProjection({ payload: {}, sourceContentRevision: 1 });
    setSoulMemory({ markdown: "", persisted: false });
    const result = await buildAnswerPayload(work({ approvedScopes: [NAME, `attr.identity.identity_profile.${field}`] }), { ...params, ownerIdentity: { displayName: "Synthetic Ava" } }, "token");
    expect(result.hasContent).toBe(false);
    expect(compose).not.toHaveBeenCalled();
  });
  it("merges every approved wildcard fact and overrides legacy values without siblings", async () => {
    setScopeProjection({ payload: { identity: { identity_profile: { full_name: "Old name", sex: "old value" } } }, sourceContentRevision: 1 });
    setSoulMemory({ markdown: "- Legal name: Current name\n- Sex: female\n- Date of birth: 1998-03-14\n", dataVersion: 9 });
    const result = await buildAnswerPayload(work({ approvedScopes: ["attr.identity.identity_profile.*"] }), params);
    expect(result.payload.approvedInformation["attr.identity.identity_profile.*"]).toMatchObject({ identity_profile: { full_name: "Current name", sex: "female", declared_age: expect.any(String) } });
    expect(JSON.stringify(result.payload.approvedInformation)).not.toContain("Old name");
  });
  it("owner deletion suppresses a legacy sex value and never charges for it", async () => {
    setScopeProjection({ payload: { identity: { identity_profile: { sex: "legacy" } } }, sourceContentRevision: 1 });
    setSoulMemory({ markdown: "", dataVersion: 9, deletedFactLabels: ["sex"] });
    const result = await buildAnswerPayload(work({ approvedScopes: ["attr.identity.identity_profile.sex"] }), params);
    expect(result.hasContent).toBe(false);
    expect(JSON.stringify(result.payload.approvedInformation)).not.toContain("legacy");
  });
});

it("seals a custom avatar while passing only a bounded photo reference to the composer", async () => {
  buildConsentExportForScope.mockRejectedValue(new Error("source absent"));
  setSoulMemory({ markdown: "", persisted: false });
  const photoUrl = `data:image/png;base64,${btoa("x".repeat(100_000))}`;
  refreshIdentityForSession.mockResolvedValue({ user_id: "owner-A", display_name: "Synthetic Ava", photo_url: photoUrl });
  const photo = "attr.identity.identity_profile.profile_photo_url";
  const result = await buildAnswerPayload(work({ approvedScopes: [photo] }), { ...params, ownerIdentity: { displayName: "Synthetic Ava", photoUrl } }, "token");
  expect(result.hasContent).toBe(true);
  expect(result.payload.ownerIdentity?.photoUrl).toBe(photoUrl);
  expect(JSON.stringify(result.payload.approvedInformation)).toContain(photoUrl);
  const composed = JSON.stringify(compose.mock.calls[0]![2]);
  expect(composed.length).toBeLessThan(60_000);
  expect(composed).not.toContain(photoUrl);
  expect(composed).toContain("Profile photo included in the encrypted answer");
});
it("keeps unchanged source revisions when an unrelated Soul fact was deleted", async () => {
  setScopeProjection({ payload: { identity: { identity_profile: { full_name: "Legacy name" } } }, sourceContentRevision: 3, sourceManifestRevision: 4 });
  setSoulMemory({ markdown: "", dataVersion: 9, deletedFactLabels: ["sex"] });
  const name = "attr.identity.identity_profile.full_name";
  const result = await buildAnswerPayload(work({ approvedScopes: [name] }), params);
  expect(result.payload.sourceRevisions[name]).toBe(3);
  expect(result.payload.memory).toContain("Revision 3");
});

describe("Soul-backed projections retain exact scope limits", () => {
  const identityWork = (scope: string) => work({ approvedScopes: [scope] });
  beforeEach(() => { setSoulMemory({ markdown: SOUL, dataVersion: 12 }); setScopeProjection({ payload: {} }); });
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

});

it("does not satisfy a nested lookalike scope with a canonical identity fact", () => {
  expect(projectApprovedSoulFacts({ approvedScopes: ["attr.identity.other.identity_profile.sex", "attr.identity.other.identity_profile.*"], markdown: "- Sex: female\n" })).toEqual([]);
});
