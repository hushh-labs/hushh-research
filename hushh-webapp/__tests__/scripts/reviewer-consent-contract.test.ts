import { afterEach, describe, expect, it, vi } from "vitest";
import { spawnSync } from "node:child_process";
import path from "node:path";
import {
  assertRequestDraft, assertRequestState, assertStreamProof,
  createDraftAdmission, safeFailureCode, matchesExpectedJson, assertConfirmationReview, assertAllStreamProofs,
  matchesOwnerBinding, assertGrantTiming, createFixtureMutationAdmission, createFixtureReviewGate,
} from "../../../.codex/skills/reviewer-app-testing/scripts/consent-rehearsal-contract.mjs";
import { installConsentStreamProbe } from "../../../.codex/skills/reviewer-app-testing/scripts/consent-rehearsal-stream-probe.mjs";

const expected = {
  bundleId: "fresh-request", personRef: "intended-owner", purpose: "unique-run-purpose",
  durationSeconds: 172800, scopeRefs: ["selected-scope"], status: "pending",
};
const payload = () => ({
  bundleId: expected.bundleId, personRef: expected.personRef, purpose: expected.purpose,
  durationSeconds: expected.durationSeconds, cancelled: false,
  items: [{ requestId: "fresh-item", scopeRef: "selected-scope", status: "pending" }],
});

describe("Profile rehearsal startup safety", () => {
  it("refuses Memory import before authentication without explicit mutation authority", () => {
    const script = path.resolve(process.cwd(), "../.codex/skills/reviewer-app-testing/scripts/verify-reviewer-memory-import.mjs");
    const result = spawnSync(process.execPath, [script], {
      env: { REVIEWER_ALLOW_SHARED_MUTATIONS: "false" }, encoding: "utf8", timeout: 10000,
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toBe("");
    expect(JSON.parse(result.stdout)).toEqual({ passed: false, code: "MUTATION_AUTHORITY_REQUIRED" });
  });
  it.each([
    [{ REVIEWER_ALLOW_SHARED_MUTATIONS: "false" }, "MUTATION_AUTHORITY_REQUIRED"],
    [{ REVIEWER_ALLOW_SHARED_MUTATIONS: "true" }, "EXPLICIT_PAIR_AND_SCOPE_REQUIRED"],
    [{ REVIEWER_ALLOW_SHARED_MUTATIONS: "true", REVIEWER_UID: "synthetic-owner", REVIEWER_COUNTERPART_UID: "synthetic-requester",
      REVIEWER_PERSON_REF: "synthetic-person", REVIEWER_CONSENT_SCOPE_REF: "synthetic-scope", REVIEWER_EXPECTED_PAYLOAD_JSON: "{}" }, "EXACT_SYNTHETIC_PAYLOAD_REQUIRED"],
    [{ REVIEWER_ALLOW_SHARED_MUTATIONS: "true", REVIEWER_UID: "synthetic-owner", REVIEWER_COUNTERPART_UID: "synthetic-requester",
      REVIEWER_PERSON_REF: "synthetic-person", REVIEWER_CONSENT_SCOPE_REF: "synthetic-scope", REVIEWER_EXPECTED_PAYLOAD_JSON: "invalid-private-sentinel" }, "REHEARSAL_UNEXPECTED_FAILURE"],
  ])("fails closed before authentication and emits only safe diagnostics", (env, code) => {
    const script = path.resolve(process.cwd(), "../.codex/skills/reviewer-app-testing/scripts/verify-reviewer-consent-profile.mjs");
    const result = spawnSync(process.execPath, [script], {
      env, encoding: "utf8", timeout: 10000,
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toBe("");
    expect(JSON.parse(result.stdout)).toEqual({ passed: false, phase: "preflight", code, createdRequestRetained: false });
    expect(result.stdout).not.toContain("private-sentinel");
  });
});

describe("consent rehearsal evidence", () => {
  it("pins one synthetic mutation to the reviewed owner/root/impact and identical retries", () => {
    const target = { ownerUid: "owner", domain: "professional", scope: "projects", operation: "create", grantIds: ["grant"], exportIds: ["export"] };
    const body = { user_id: "owner", domain: "professional", encrypted_blob: { ciphertext: "ciphertext" }, mutation_plan: {
      plan_id: "plan", operation: "create", proposed_domain: "professional", proposed_scope: "projects",
      affected_grant_ids: ["grant"], affected_export_ids: ["export"], confirmation_receipt: {
        plan_id: "plan", confirmed_by_user_id: "owner", displayed_domain: "professional", displayed_scope: "projects",
        authorization_mode: "owner_confirmed", sharing_impact_acknowledged: true,
      },
    } };
    expect(() => createFixtureMutationAdmission({ ...target, domain: "" })).toThrow("FIXTURE_TARGET_REQUIRED");
    expect(() => createFixtureMutationAdmission({ ...target, operation: "delete" })).toThrow("FIXTURE_OPERATION_REQUIRED");
    const updateAdmission = createFixtureMutationAdmission({ ...target, operation: "update" });
    expect(() => updateAdmission(body)).toThrow("FIXTURE_CONFIRMATION_MISMATCH");
    const domainUpdate = structuredClone(body);
    domainUpdate.mutation_plan.operation = "update";
    expect(() => updateAdmission(domainUpdate)).not.toThrow();
    const admit = createFixtureMutationAdmission(target);
    const wrongRoot = structuredClone(body);
    wrongRoot.mutation_plan.proposed_scope = "profile";
    expect(() => admit(wrongRoot)).toThrow("FIXTURE_TARGET_MISMATCH");
    const wrongReceipt = structuredClone(body);
    wrongReceipt.mutation_plan.confirmation_receipt.displayed_scope = "profile";
    expect(() => admit(wrongReceipt)).toThrow("FIXTURE_TARGET_MISMATCH");
    const automatic = structuredClone(body);
    automatic.mutation_plan.confirmation_receipt.authorization_mode = "auto_save";
    expect(() => admit(automatic)).toThrow("FIXTURE_CONFIRMATION_MISMATCH");
    const otherGrant = structuredClone(body);
    otherGrant.mutation_plan.affected_grant_ids = ["outside-grant"];
    expect(() => admit(otherGrant)).toThrow("FIXTURE_IMPACT_MISMATCH");
    expect(() => admit(body)).not.toThrow();
    expect(() => admit(structuredClone(body))).not.toThrow();
    const secondPlan = structuredClone(body);
    secondPlan.mutation_plan.plan_id = "second";
    secondPlan.mutation_plan.confirmation_receipt.plan_id = "second";
    expect(() => admit(secondPlan)).toThrow("FIXTURE_CONFIRMATION_ALREADY_USED");
    const changedCiphertext = structuredClone(body);
    changedCiphertext.encrypted_blob.ciphertext = "different";
    expect(() => admit(changedCiphertext)).toThrow("FIXTURE_CONFIRMATION_ALREADY_USED");
    const gate = createFixtureReviewGate();
    expect(() => gate.admit(body)).toThrow("FIXTURE_REVIEW_REQUIRED");
    gate.review(target);
    gate.admit(body);
    expect(() => gate.review(target)).toThrow("FIXTURE_REVIEW_ALREADY_BOUND");
    expect(() => gate.admit(secondPlan)).toThrow("FIXTURE_CONFIRMATION_ALREADY_USED");
    expect(() => gate.admit(changedCiphertext)).toThrow("FIXTURE_CONFIRMATION_ALREADY_USED");
  });
  it("binds public references to the exact authorized UID, never first candidate or name", () => {
    const rows = [{ userId: "other", publicPersonRef: "other-ref" }, { userId: "owner", publicPersonRef: "owner-ref" }];
    expect(matchesOwnerBinding(rows, "owner", "owner-ref")).toBe(true);
    expect(matchesOwnerBinding(rows, "missing", "owner-ref")).toBe(false);
    expect(() => matchesOwnerBinding(rows, "owner", "other-ref")).toThrow("OWNER_REFERENCE_MISMATCH");
    expect(() => matchesOwnerBinding([...rows, rows[1]], "owner", "owner-ref")).toThrow("OWNER_BINDING_AMBIGUOUS");
  });
  it("binds exact envelope expiry while allowing server issuance processing latency", () => {
    const start = 1_000_000, end = start + 30_000, expiry = start + 86_400_000;
    expect(() => assertGrantTiming({ issuedAt: end, expiresAt: expiry }, expiry, start, end)).not.toThrow();
    expect(() => assertGrantTiming({ issuedAt: end, expiresAt: start + 3_600_000 }, expiry, start, end)).toThrow("GRANT_DURATION_MISMATCH");
    expect(() => assertGrantTiming({ issuedAt: start - 120_000, expiresAt: expiry }, expiry, start, end)).toThrow("GRANT_ISSUANCE_TIME_MISMATCH");
  });
  it("binds confirmation to the selected duration without substring matches", () => {
    const review = { displayName: "Synthetic Owner", scopeLabel: "Synthetic Field", purpose: "Synthetic purpose", durationSeconds: 86400 };
    for (const duration of ["24 hours", "1 day"]) {
      expect(() => assertConfirmationReview(`Synthetic Owner: Synthetic Field for ${duration}`, "Synthetic purpose", review)).not.toThrow();
    }
    for (const duration of ["48 hours", "124 hours", "11 days"]) {
      expect(() => assertConfirmationReview(`Synthetic Owner: Synthetic Field for ${duration}`, "Synthetic purpose", review)).toThrow("CONFIRMATION_REVIEW_INCOMPLETE");
    }
  });

  it("pins item identities across lifecycle reads", () => {
    const state = payload();
    const binding = { ...expected, requestIds: ["fresh-item"] };
    expect(() => assertRequestState({ ok: true, payload: state }, binding)).not.toThrow();
    state.items[0]!.requestId = "historical-item";
    expect(() => assertRequestState({ ok: true, payload: state }, binding)).toThrow("REQUEST_ITEM_ID_MISMATCH");
  });
  it("rejects an execution continuation error after an otherwise valid parked confirmation", () => {
    const parked = { httpOk: true, settled: true, finished: false, runError: false,
      malformed: false, aborted: true, parkedActions: ["consent.request"] };
    const continuation = { ...parked, aborted: false, parkedActions: [], finished: true, runError: true };
    expect(() => assertAllStreamProofs([parked, continuation], new Map([[0, "consent.request"]]))).toThrow("STREAM_RUN_ERROR");
    expect(() => assertAllStreamProofs([parked, { ...continuation, runError: false }], new Map([[0, "consent.request"]]))).not.toThrow();
    expect(() => assertAllStreamProofs([parked, parked], new Map([[0, "consent.request"]]))).toThrow("STREAM_NOT_FINISHED");
  });
  it("requires informed confirmation, not field text echoed in the user prompt", () => {
    const review = { displayName: "Synthetic Owner", scopeLabel: "Synthetic Field", purpose: "Synthetic purpose" };
    expect(() => assertConfirmationReview("Send request", "Synthetic Field", review)).toThrow("CONFIRMATION_REVIEW_INCOMPLETE");
    expect(() => assertConfirmationReview("Ask Synthetic Owner for Synthetic Field for 48 hours.", "", review)).toThrow("CONFIRMATION_PURPOSE_MISSING");
    expect(() => assertConfirmationReview("Ask Synthetic Owner for Synthetic Field for 48 hours.", "Synthetic purpose", review)).not.toThrow();
  });
  it("compares exact payloads in-browser, excluding extra sibling fields and substring matches", () => {
    const node = document.createElement("pre");
    const expected = { professional: { role: "synthetic role", active: true } };
    node.textContent = JSON.stringify({ professional: { active: true, role: "synthetic role" } });
    expect(matchesExpectedJson(node, expected)).toBe(true);
    node.textContent = JSON.stringify({ professional: { active: true, role: "synthetic role", privateSibling: "not selected" } });
    expect(matchesExpectedJson(node, expected)).toBe(false);
    node.textContent = JSON.stringify({ professional: { active: true, role: "synthetic role extra" } });
    expect(matchesExpectedJson(node, expected)).toBe(false);
    node.textContent = "malformed";
    expect(matchesExpectedJson(node, expected)).toBe(false);
  });
  it("pins one confirmed draft across concurrent submissions and retries", () => {
    const admit = createDraftAdmission(expected);
    const draft = { person_ref: expected.personRef, purpose: expected.purpose,
      duration_seconds: expected.durationSeconds, scope_refs: expected.scopeRefs,
      idempotency_key: "first-key", connector_key_id: "first-connector" };
    admit(draft);
    expect(() => admit({ ...draft })).not.toThrow();
    expect(() => admit({ ...draft, idempotency_key: "second-key" })).toThrow("CONFIRMATION_ALREADY_USED");
    expect(() => admit({ ...draft, connector_key_id: "other" })).toThrow("CONFIRMED_DRAFT_CHANGED");
  });
  it("accepts only the expected parked abort with no stream error", () => {
    const proof = { httpOk: true, settled: true, finished: false, runError: false,
      malformed: false, aborted: true, parkedActions: ["consent.request"] };
    expect(() => assertStreamProof(proof, "consent.request")).not.toThrow();
    expect(() => assertStreamProof(proof)).toThrow("STREAM_NOT_FINISHED");
    expect(() => assertStreamProof(proof, "consent.cancel_request")).toThrow("STREAM_NOT_FINISHED");
    expect(() => assertStreamProof({ ...proof, parkedActions: [] }, "consent.request")).toThrow("STREAM_NOT_FINISHED");
    expect(() => assertStreamProof({ ...proof, runError: true }, "consent.request")).toThrow("STREAM_RUN_ERROR");
  });
  it("refuses wrong recipients and extra scopes before a request can leave the browser", () => {
    const draft = { person_ref: expected.personRef, purpose: expected.purpose,
      duration_seconds: expected.durationSeconds, scope_refs: expected.scopeRefs, idempotency_key: "unique-draft" };
    expect(() => assertRequestDraft(draft, expected)).not.toThrow();
    expect(() => assertRequestDraft({ ...draft, person_ref: "wrong-person" }, expected)).toThrow("DRAFT_RECIPIENT_MISMATCH");
    expect(() => assertRequestDraft({ ...draft, scope_refs: [...expected.scopeRefs, "sibling"] }, expected)).toThrow("DRAFT_FIELDS_MISMATCH");
    expect(() => assertRequestDraft({ ...draft, idempotency_key: "" }, expected)).toThrow("DRAFT_IDEMPOTENCY_MISSING");
  });
  it("accepts an exact current request and its explicit cancellation", () => {
    expect(assertRequestState({ ok: true, payload: payload() }, expected)).toEqual(payload());
    const cancelled = payload();
    cancelled.cancelled = true;
    cancelled.items[0].status = "cancelled";
    expect(assertRequestState({ ok: true, payload: cancelled }, { ...expected, status: "cancelled" })).toEqual(cancelled);
  });
  it.each([null, {}, { ok: false, payload: {} }, { ok: false, payload: payload() }])(
    "rejects unsuccessful authority reads", result => {
      expect(() => assertRequestState(result, expected)).toThrow("REQUEST_STATE_READ_FAILED");
    },
  );
  it.each([
    ["bundleId", "old-request", "REQUEST_ID_MISMATCH"],
    ["personRef", "wrong-person", "REQUEST_RECIPIENT_MISMATCH"],
    ["purpose", "historical-purpose", "REQUEST_RUN_MISMATCH"],
    ["durationSeconds", 86400, "REQUEST_DURATION_MISMATCH"],
  ])("rejects changed %s", (key, value, code) => {
    expect(() => assertRequestState({ ok: true, payload: { ...payload(), [key]: value } }, expected)).toThrow(String(code));
  });
  it("rejects extra or substituted fields", () => {
    for (const items of [[], [{ requestId: "item", scopeRef: "other", status: "pending" }],
      [...payload().items, { requestId: "sibling", scopeRef: "unselected", status: "pending" }]]) {
      expect(() => assertRequestState({ ok: true, payload: { ...payload(), items } }, expected)).toThrow("REQUEST_FIELDS_MISMATCH");
    }
  });
  it("does not confuse denial, expiry, or emptiness with successful cancellation", () => {
    for (const status of ["pending", "denied", "expired", "granted", "", "revoked"]) {
      const bundle = payload();
      bundle.cancelled = true;
      bundle.items[0].status = status;
      expect(() => assertRequestState({ ok: true, payload: bundle }, { ...expected, status: "cancelled" })).toThrow("REQUEST_STATUS_MISMATCH");
    }
  });
  it("rejects truncated and malformed evidence even if the UI appears settled", () => {
    const proof = { httpOk: true, settled: true, finished: false, runError: false,
      malformed: false, aborted: false, parkedActions: [] };
    expect(() => assertStreamProof(proof)).toThrow("STREAM_NOT_FINISHED");
    expect(() => assertStreamProof({ ...proof, finished: true, malformed: true })).toThrow("STREAM_MALFORMED_EVENT");
    expect(() => assertStreamProof({ ...proof, finished: true })).not.toThrow();
  });
  it("never includes arbitrary error messages or stacks in retained diagnostics", () => {
    expect(safeFailureCode(new Error("decrypted value or provider response"))).toBe("REHEARSAL_UNEXPECTED_FAILURE");
  });
});

describe("incremental reviewer stream observation", () => {
  const originalFetch = window.fetch;
  afterEach(() => { window.fetch = originalFetch; });
  it("records a parked directive before intentional abort without retaining contents", async () => {
    let controller: ReadableStreamDefaultController<Uint8Array>;
    const stream = new ReadableStream<Uint8Array>({ start(value) { controller = value; } });
    window.fetch = vi.fn(async () => new Response(stream));
    installConsentStreamProbe();
    await window.fetch("/api/one/agent-chat");
    const encoder = new TextEncoder();
    controller!.enqueue(encoder.encode('data: {"type":"TOOL_CALL_'));
    controller!.enqueue(encoder.encode('RESULT","content":{"status":"confirm_pending","directive":{"actionId":"consent.request","slots":{"private":"never retained"}}}}\n\n'));
    const proofs = () => (window as unknown as { __consentRehearsalStreams: Array<{ parkedActions: string[]; settled: boolean }> }).__consentRehearsalStreams;
    await vi.waitFor(() => expect(proofs()[0].parkedActions).toEqual(["consent.request"]));
    controller!.error(new DOMException("private error", "AbortError"));
    await vi.waitFor(() => expect(proofs()[0].settled).toBe(true));
    expect(() => assertStreamProof(proofs()[0], "consent.request")).not.toThrow();
    expect(JSON.stringify(proofs())).not.toMatch(/private|never retained/);
  });
  it("records RUN_ERROR on an HTTP-200 stream", async () => {
    window.fetch = vi.fn(async () => new Response('data: {"type":"RUN_ERROR","message":"private"}\n\ndata: {"type":"RUN_FINISHED"}\n\n'));
    installConsentStreamProbe();
    await window.fetch("/api/one/agent-chat");
    const proofs = () => (window as unknown as { __consentRehearsalStreams: Array<{ settled: boolean }> }).__consentRehearsalStreams;
    await vi.waitFor(() => expect(proofs()[0].settled).toBe(true));
    expect(() => assertStreamProof(proofs()[0])).toThrow("STREAM_RUN_ERROR");
    expect(JSON.stringify(proofs())).not.toContain("private");
  });
});
