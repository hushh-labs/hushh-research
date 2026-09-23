import { describe, expect, it, vi } from "vitest";
import { createReviewerPkmProof, type ReviewerPkmExpectation } from "@/lib/testing/reviewer-pkm-proof";

const expectation: ReviewerPkmExpectation = {
  domain: "professional", path: ["projects", "fixture"], value: { role: "technical writer" },
};
const before = { userId: "owner", domain: "professional", contentRevision: 2,
  data: { projects: { old: { role: "editor" } } } };
const after = { ...before, contentRevision: 3,
  data: { projects: { old: { role: "editor" }, fixture: { role: "technical writer" } } } };

describe("reviewer PKM proof", () => {
  it("proves exactly the additive write without returning values", async () => {
    const load = vi.fn().mockResolvedValueOnce(before).mockResolvedValueOnce(after);
    const proof = createReviewerPkmProof({ owner: "owner", isCurrent: () => true, load });
    expect(await proof.begin(expectation)).toEqual({ ok: true, code: "ready" });
    expect(await proof.verify(3)).toEqual({ ok: true, code: "verified" });
    expect(await proof.verify(3)).toEqual({ ok: false, code: "refused" });
  });
  it.each([
    { ...after, userId: "other" }, { ...after, domain: "financial" },
    { ...after, contentRevision: 2 }, { ...after, contentRevision: 4 }, null,
  ])("rejects stale or misbound readback", async invalid => {
    const proof = createReviewerPkmProof({ owner: "owner", isCurrent: () => true,
      load: vi.fn().mockResolvedValueOnce(before).mockResolvedValueOnce(invalid) });
    await proof.begin(expectation);
    expect((await proof.verify(3)).ok).toBe(false);
  });
  it.each([
    { projects: { old: { role: "changed" }, fixture: { role: "technical writer" } } },
    { projects: { old: { role: "editor" }, fixture: { role: "wrong" } } },
    { ...after.data, extra: "not approved" },
  ])("rejects loss, a wrong value, or an unapproved addition", async data => {
    const proof = createReviewerPkmProof({ owner: "owner", isCurrent: () => true,
      load: vi.fn().mockResolvedValueOnce(before).mockResolvedValueOnce({ ...after, data }) });
    await proof.begin(expectation);
    expect(await proof.verify(3)).toEqual({ ok: false, code: "mismatch" });
  });
  it("claims the baseline before awaiting and refuses replacement", async () => {
    let resolve!: (value: typeof before) => void;
    const proof = createReviewerPkmProof({ owner: "owner", isCurrent: () => true,
      load: () => new Promise(done => { resolve = done; }) });
    const pending = proof.begin(expectation);
    expect(await proof.begin({ ...expectation, value: "changed" })).toEqual({ ok: false, code: "refused" });
    resolve(before); await pending;
    expect(await proof.begin(expectation)).toEqual({ ok: false, code: "refused" });
  });
  it.each(["session", "dispose"])("rejects a pending read after %s invalidation", async kind => {
    let current = true, resolve!: (value: typeof before) => void;
    const proof = createReviewerPkmProof({ owner: "owner", isCurrent: () => current,
      load: () => new Promise(done => { resolve = done; }) });
    const pending = proof.begin(expectation);
    if (kind === "session") current = false; else proof.dispose();
    resolve(before);
    expect(await pending).toEqual({ ok: false, code: "refused" });
  });
  it("does not read for a disabled guard or expose exceptions", async () => {
    const load = vi.fn().mockRejectedValue(new Error("PRIVATE_SENTINEL"));
    const disabled = createReviewerPkmProof({ owner: "owner", isCurrent: () => false, load });
    expect((await disabled.begin(expectation)).ok).toBe(false);
    expect(load).not.toHaveBeenCalled();
    const enabled = createReviewerPkmProof({ owner: "owner", isCurrent: () => true, load });
    expect(await enabled.begin(expectation)).toEqual({ ok: false, code: "unavailable" });
  });
  it("does not reinterpret an existing empty container or permit replacement", async () => {
    const proof = createReviewerPkmProof({ owner: "owner", isCurrent: () => true,
      load: vi.fn().mockResolvedValueOnce({ ...before, data: { projects: {} } }).mockResolvedValueOnce(after) });
    await proof.begin(expectation);
    expect((await proof.verify(3)).ok).toBe(false);
    const existing = createReviewerPkmProof({ owner: "owner", isCurrent: () => true,
      load: vi.fn().mockResolvedValue(after) });
    expect((await existing.begin(expectation)).ok).toBe(false);
  });
  it.each([
    { ...expectation, path: new Array(1) },
    { ...expectation, value: new Array(1) },
    { ...expectation, value: new Date() },
    { ...expectation, value: undefined },
    { ...expectation, value: Number.NaN },
    { ...expectation, value: { [Symbol("unsupported")]: "synthetic" } },
    { ...expectation, value: Object.defineProperty({}, "hidden", { value: "synthetic" }) },
    { ...expectation, value: Object.defineProperty({}, "getter", { enumerable: true,
      get() { throw new Error("Getter must never run"); } }) },
  ])("rejects non-JSON or sparse expectations before reading", async input => {
    const load = vi.fn();
    const proof = createReviewerPkmProof({ owner: "owner", isCurrent: () => true, load });
    expect((await proof.begin(input as ReviewerPkmExpectation)).ok).toBe(false);
    expect(load).not.toHaveBeenCalled();
  });
  it("permanently retires on observed authority loss", async () => {
    let current = true;
    const load = vi.fn().mockResolvedValue(before);
    const proof = createReviewerPkmProof({ owner: "owner", isCurrent: () => current, load });
    await proof.begin(expectation);
    current = false; expect((await proof.verify(3)).ok).toBe(false);
    current = true; expect((await proof.verify(3)).ok).toBe(false);
    expect(load).toHaveBeenCalledTimes(1);
  });
  it("does not invoke accessors while validating", async () => {
    const getter = vi.fn(() => "synthetic"), load = vi.fn();
    const proof = createReviewerPkmProof({ owner: "owner", isCurrent: () => true, load });
    await proof.begin({ ...expectation, value: Object.defineProperty({}, "value", { enumerable: true, get: getter }) });
    expect(getter).not.toHaveBeenCalled();
    expect(load).not.toHaveBeenCalled();
  });
});
