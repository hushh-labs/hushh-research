import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  approvePendingConsent: vi.fn(),
  denyPendingConsent: vi.fn(),
  revokeConsent: vi.fn(),
  onConsentMutated: vi.fn(),
  toastPromise: vi.fn(),
  toastError: vi.fn(),
  toastInfo: vi.fn(),
}));

vi.mock("sonner", () => ({
  toast: {
    promise: mocks.toastPromise,
    error: mocks.toastError,
    info: mocks.toastInfo,
  },
}));

vi.mock("@/lib/vault/vault-context", () => ({
  useVault: () => ({
    vaultKey: "vault-key",
    getVaultOwnerToken: () => "vault-owner-token",
  }),
}));

vi.mock("@/lib/services/api-service", () => ({
  ApiService: {
    approvePendingConsent: mocks.approvePendingConsent,
    denyPendingConsent: mocks.denyPendingConsent,
    revokeConsent: mocks.revokeConsent,
  },
}));

vi.mock("@/lib/cache/cache-sync-service", () => ({
  CacheSyncService: { onConsentMutated: mocks.onConsentMutated },
}));

vi.mock("@/lib/consent/export-builder", () => ({
  ConsentExportNoDataError: class ConsentExportNoDataError extends Error {},
  buildConsentExportForScope: vi.fn(),
}));

vi.mock("@/lib/vault/export-encrypt", () => ({
  generateExportKey: vi.fn(async () => "export-key"),
  encryptForExport: vi.fn(async () => ({
    ciphertext: "ciphertext",
    iv: "iv",
    tag: "tag",
  })),
  wrapExportKeyForConnector: vi.fn(),
}));

vi.mock("@/lib/utils/browser-navigation", () => ({
  requestInternalAppNavigation: vi.fn(),
}));

import { useConsentActions, type PendingConsent } from "@/lib/consent";

function deferredResponse() {
  let resolve!: (response: Response) => void;
  const promise = new Promise<Response>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

function consent(id = "req-1"): PendingConsent {
  return {
    id,
    developer: "Macy's CRM",
    scope: "crm.profile.update",
    requestedAt: Date.now(),
  };
}

describe("useConsentActions async action locks", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("deduplicates approve calls for the same request while in flight", async () => {
    const pending = deferredResponse();
    mocks.approvePendingConsent.mockReturnValueOnce(pending.promise);

    const { result } = renderHook(() =>
      useConsentActions({ userId: "user-1" }),
    );

    let first!: Promise<void>;
    let second!: Promise<void>;
    act(() => {
      first = result.current.handleApprove(consent("req-approve"));
      second = result.current.handleApprove(consent("req-approve"));
    });

    expect(first).toBe(second);
    await waitFor(() =>
      expect(result.current.isRequestBusy("req-approve")).toBe(true),
    );
    expect(mocks.approvePendingConsent).toHaveBeenCalledTimes(1);

    await act(async () => {
      pending.resolve(new Response(JSON.stringify({ ok: true }), { status: 200 }));
      await first;
    });

    await waitFor(() =>
      expect(result.current.isRequestBusy("req-approve")).toBe(false),
    );
    expect(mocks.onConsentMutated).toHaveBeenCalledWith("user-1");
  });

  it("deduplicates deny calls for the same request while in flight", async () => {
    const pending = deferredResponse();
    mocks.denyPendingConsent.mockReturnValueOnce(pending.promise);

    const { result } = renderHook(() =>
      useConsentActions({ userId: "user-1" }),
    );

    let first!: Promise<void>;
    let second!: Promise<void>;
    act(() => {
      first = result.current.handleDeny("req-deny");
      second = result.current.handleDeny("req-deny");
    });

    expect(first).toBe(second);
    await waitFor(() =>
      expect(result.current.isRequestBusy("req-deny")).toBe(true),
    );
    expect(mocks.denyPendingConsent).toHaveBeenCalledTimes(1);

    await act(async () => {
      pending.resolve(new Response(JSON.stringify({ ok: true }), { status: 200 }));
      await first;
    });

    await waitFor(() =>
      expect(result.current.isRequestBusy("req-deny")).toBe(false),
    );
  });

  it("deduplicates revoke calls for the same scope while in flight", async () => {
    const pending = deferredResponse();
    mocks.revokeConsent.mockReturnValueOnce(pending.promise);

    const { result } = renderHook(() =>
      useConsentActions({ userId: "user-1" }),
    );

    let first!: Promise<void>;
    let second!: Promise<void>;
    act(() => {
      first = result.current.handleRevoke("attr.shopping.*");
      second = result.current.handleRevoke("attr.shopping.*");
    });

    expect(first).toBe(second);
    await waitFor(() =>
      expect(result.current.isScopeBusy("attr.shopping.*")).toBe(true),
    );
    expect(mocks.revokeConsent).toHaveBeenCalledTimes(1);

    await act(async () => {
      pending.resolve(new Response(JSON.stringify({ lockVault: false }), { status: 200 }));
      await first;
    });

    await waitFor(() =>
      expect(result.current.isScopeBusy("attr.shopping.*")).toBe(false),
    );
  });
});
