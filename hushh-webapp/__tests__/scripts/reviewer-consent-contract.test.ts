import { afterEach, describe, expect, it, vi } from "vitest";
import {
  assertRequestDraft, assertRequestState, assertStreamProof,
  createDraftAdmission, safeFailureCode, matchesExpectedJson, assertConfirmationReview, assertAllStreamProofs,
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

describe("consent rehearsal evidence", () => {
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
