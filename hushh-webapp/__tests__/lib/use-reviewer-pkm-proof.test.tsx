import { renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useReviewerPkmProof } from "@/lib/testing/use-reviewer-pkm-proof";

const mocks = vi.hoisted(() => ({ load: vi.fn(), build: vi.fn(), epochCurrent: true }));
vi.mock("@/lib/consent/export-builder", () => ({ buildConsentExportForScope: mocks.build }));
vi.mock("@/lib/services/personal-knowledge-model-service", () => ({
  PersonalKnowledgeModelService: { loadDomainSnapshot: mocks.load },
}));
vi.mock("@/lib/agent/agent-pkm-capture-runtime", async importOriginal => ({
  ...await importOriginal<typeof import("@/lib/agent/agent-pkm-capture-runtime")>(),
  createAgentPkmCaptureGuard: ({ signal, isEnabled }: { signal: AbortSignal; isEnabled: () => boolean }) => {
    const isCurrent = () => mocks.epochCurrent && !signal.aborted && isEnabled();
    return { isCurrent, assertCurrent: async () => { if (!isCurrent()) throw new Error("stale"); } };
  },
}));
const state = { userId: "owner", authLoading: false, sessionVerificationRequired: false,
  isVaultUnlocked: true, vaultKey: "test-key", vaultOwnerToken: "test-token", tokenExpiresAt: Date.now() + 60000 };
const expectation = { domain: "professional" as const, path: ["projects", "fixture"], value: "synthetic" };
const snapshot = { snapshot: { userId: "owner", domain: "professional", contentRevision: 2 },
  data: { projects: { old: "synthetic prior" } } };
beforeEach(() => {
  mocks.load.mockReset(); mocks.build.mockReset(); mocks.epochCurrent = true;
  window.__HUSHH_NATIVE_TEST__ = { enabled: true, autoReviewerLogin: true,
    pkmProofEnabled: true, pkmProofExpectation: expectation,
    expectedUserId: "owner", reviewerMutationPolicy: "bounded_mutation" };
});
afterEach(() => { delete window.__HUSHH_NATIVE_TEST__; });

describe("reviewer PKM proof hook admission", () => {
  it.each([{ authLoading: true }, { sessionVerificationRequired: true },
    { isVaultUnlocked: false }, { tokenExpiresAt: 1 }])("rejects unavailable auth or vault readiness", patch => {
    const { unmount } = renderHook(() => useReviewerPkmProof({ ...state, ...patch }));
    expect(window.__HUSHH_NATIVE_TEST__?.pkmProof).toBeUndefined();
    expect(mocks.load).not.toHaveBeenCalled(); unmount();
  });
  it.each([
    { enabled: false }, { autoReviewerLogin: false }, { pkmProofEnabled: false },
    { expectedUserId: "other" }, { reviewerMutationPolicy: "read_only" as const },
  ])("does not install outside explicit bounded admission", patch => {
    Object.assign(window.__HUSHH_NATIVE_TEST__!, patch);
    const { unmount } = renderHook(() => useReviewerPkmProof(state));
    expect(window.__HUSHH_NATIVE_TEST__?.pkmProof).toBeUndefined();
    expect(mocks.load).not.toHaveBeenCalled(); unmount();
  });
  it("uses the authenticated owner and force-read, never a caller supplied owner", async () => {
    mocks.load.mockResolvedValue(snapshot);
    const { unmount } = renderHook(() => useReviewerPkmProof(state));
    expect(await window.__HUSHH_NATIVE_TEST__!.pkmProof!.begin()).toEqual({ ok: true, code: "ready" });
    expect(mocks.load).toHaveBeenCalledWith({ userId: "owner", domain: "professional",
      vaultKey: "test-key", vaultOwnerToken: "test-token", force: true });
    unmount(); expect(window.__HUSHH_NATIVE_TEST__!.pkmProof).toBeNull();
  });
  it.each(["unmount", "epoch", "owner", "expiry"])("rejects pending work after %s changes", async change => {
    let resolve!: (value: typeof snapshot) => void;
    mocks.load.mockImplementation(() => new Promise(done => { resolve = done; }));
    const { unmount, rerender } = renderHook(props => useReviewerPkmProof(props), { initialProps: state });
    const api = window.__HUSHH_NATIVE_TEST__!.pkmProof!;
    const pending = api.begin();
    await vi.waitFor(() => expect(mocks.load).toHaveBeenCalledTimes(1));
    if (change === "unmount") unmount();
    if (change === "epoch") mocks.epochCurrent = false;
    if (change === "owner") rerender({ ...state, userId: "other" });
    if (change === "expiry") rerender({ ...state, tokenExpiresAt: 1 });
    resolve(snapshot);
    expect((await pending).ok).toBe(false);
    expect((await api.verify(3)).ok).toBe(false);
    unmount();
  });
  it("does not revive after auth readiness loss or reset admission by remounting", async () => {
    mocks.load.mockResolvedValue(snapshot);
    const first = renderHook(props => useReviewerPkmProof(props), { initialProps: state });
    const old = window.__HUSHH_NATIVE_TEST__!.pkmProof!;
    await old.begin();
    first.rerender({ ...state, sessionVerificationRequired: true });
    first.rerender(state);
    expect((await old.verify(3)).ok).toBe(false);
    expect((await window.__HUSHH_NATIVE_TEST__!.pkmProof!.begin()).ok).toBe(false);
    first.unmount();
    const second = renderHook(() => useReviewerPkmProof(state));
    expect((await window.__HUSHH_NATIVE_TEST__!.pkmProof!.begin()).ok).toBe(false);
    expect(mocks.load).toHaveBeenCalledTimes(1);
    second.unmount();
  });
});

describe("reviewer projection digest", () => {
  it("hashes the owner's own projected domain with the rehearsal's canonical form", async () => {
    mocks.build.mockResolvedValue({ payload: { professional: { routines: { b: 2, a: [1, { d: 4, c: 3 }] } } } });
    const { unmount } = renderHook(() => useReviewerPkmProof(state));
    const result = await window.__HUSHH_NATIVE_TEST__!.pkmProof!.projectionDigest("attr.professional.routines.*");
    const { createHash } = await import("node:crypto");
    const expected = createHash("sha256").update('{"routines":{"a":[1,{"c":3,"d":4}],"b":2}}').digest("hex");
    expect(result).toEqual({ ok: true, code: "digest", digest: expected });
    expect(mocks.build).toHaveBeenCalledWith({ userId: "owner", scope: "attr.professional.routines.*",
      vaultKey: "test-key", vaultOwnerToken: "test-token" });
    unmount();
  });
  it.each(["attr.financial.accounts.*", "attr.wallet.cards.*", "pkm.read", "attr.professional.*",
    "attr.professional", "attr.professional.routines.*.*", "attr.professional.Routines.*"])(
    "refuses scope %s without building an export", async scope => {
      const { unmount } = renderHook(() => useReviewerPkmProof(state));
      expect(await window.__HUSHH_NATIVE_TEST__!.pkmProof!.projectionDigest(scope))
        .toEqual({ ok: false, code: "refused" });
      expect(mocks.build).not.toHaveBeenCalled(); unmount();
    });
  it("admits a leaf field under a digestible domain", async () => {
    mocks.build.mockResolvedValue({ payload: { professional: { routines: { summary: "s" } } } });
    const { unmount } = renderHook(() => useReviewerPkmProof(state));
    const result = await window.__HUSHH_NATIVE_TEST__!.pkmProof!
      .projectionDigest("attr.professional.routines.entities._entities.summary");
    expect(result.ok).toBe(true);
    unmount();
  });
  it("reports unavailable without detail when the export cannot be built", async () => {
    mocks.build.mockRejectedValue(new Error("secret detail"));
    const { unmount } = renderHook(() => useReviewerPkmProof(state));
    expect(await window.__HUSHH_NATIVE_TEST__!.pkmProof!.projectionDigest("attr.travel.trips.*"))
      .toEqual({ ok: false, code: "unavailable" });
    unmount();
  });
});
