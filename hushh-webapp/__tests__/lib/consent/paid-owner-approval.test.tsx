import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  approvePendingConsent: vi.fn(),
  commerceAccount: vi.fn(),
  readiness: vi.fn(),
  scopeRequest: vi.fn(),
  approveInactive: vi.fn(),
  denyPendingConsent: vi.fn(),
  revokeConsent: vi.fn(),
  onConsentMutated: vi.fn(),
  toastPromise: vi.fn(),
  toastError: vi.fn(),
  toastInfo: vi.fn(),
  toastLoading: vi.fn(),
  toastSuccess: vi.fn(),
}));

vi.mock("sonner", () => ({
  toast: {
    promise: mocks.toastPromise,
    error: mocks.toastError,
    info: mocks.toastInfo,
    loading: mocks.toastLoading,
    success: mocks.toastSuccess,
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

vi.mock("@/lib/services/auth-service", () => ({ AuthService: { getIdToken: vi.fn(async () => "firebase-token") } }));
vi.mock("@/lib/services/scope-commerce-service", async importOriginal => ({ ...await importOriginal<typeof import("@/lib/services/scope-commerce-service")>(), ScopeCommerceService: {
  account: mocks.commerceAccount, readiness: mocks.readiness, scopeRequest: mocks.scopeRequest, approveInactive: mocks.approveInactive,
} }));

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

import { advanceVaultSessionEpoch } from "@/lib/vault/session-epoch";
import { approvePaidOwnerTerms } from "@/lib/consent/paid-owner-approval";
import { useConsentActions, type PendingConsent } from "@/lib/consent";

function consent(id = "req-1"): PendingConsent {
  return {
    id,
    developer: "Macy's CRM",
    scope: "crm.profile.update",
    requestedAt: Date.now(),
  };
}

describe("paid owner approval releases no encrypted information", () => {
  beforeEach(() => { vi.resetAllMocks(); mocks.readiness.mockResolvedValue({ capabilities: { approve_paid_request: true } }); });
  it("approves inactive terms before the export builder or legacy approval", async () => {
    mocks.commerceAccount.mockResolvedValue({ enabled: true });
    mocks.scopeRequest.mockResolvedValue({ role: "owner", tariff: { price_cents: 1 }, duration_seconds: 86400 });
    mocks.approveInactive.mockResolvedValue({ status: "approved_awaiting_payment" });
    const { buildConsentExportForScope } = await import("@/lib/consent/export-builder");
    const onActionComplete = vi.fn();
    const { result } = renderHook(() => useConsentActions({ userId: "user-1", onActionComplete }));
    await act(async () => result.current.handleApprove({ ...consent("paid-request"), scope: "attr.travel.plans", durationHours: 24, metadata: { scope_handle: "exact-handle" } }, { quiet: true }));
    expect(mocks.approveInactive).toHaveBeenCalledWith("vault-owner-token", "paid-request", 86400, expect.any(String));
    expect(onActionComplete).toHaveBeenCalledWith(expect.objectContaining({ accessPending: true }));
    expect(buildConsentExportForScope).not.toHaveBeenCalled();
    expect(mocks.approvePendingConsent).not.toHaveBeenCalled();
  });
  it("does not require account or provider readiness for an authoritative free request", async () => {
    mocks.commerceAccount.mockRejectedValue(new Error("no provider"));
    mocks.readiness.mockRejectedValue(new Error("no provider"));
    mocks.scopeRequest.mockResolvedValue({ role: "owner", tariff: null, duration_seconds: 86400 });
    const state = { paidApprovals: { current: new Set<string>() }, paidApprovalKeys: { current: new Map<string, string>() } };
    await expect(approvePaidOwnerTerms({ ...consent(), scope: "attr.travel.plans", metadata: { scope_handle: "exact-handle" } }, "vault-owner-token", state, message => new Error(message))).resolves.toBeNull();
    expect(mocks.commerceAccount).not.toHaveBeenCalled();
    expect(mocks.readiness).not.toHaveBeenCalled();
    expect(mocks.approveInactive).not.toHaveBeenCalled();
    mocks.scopeRequest.mockResolvedValue({ role: "owner", tariff: { price_cents: 1 }, duration_seconds: 86400 });
    await expect(approvePaidOwnerTerms({ ...consent(), scope: "attr.travel.plans", metadata: { scope_handle: "exact-handle" } }, "vault-owner-token", state, message => new Error(message))).rejects.toThrow("no provider");
    expect(mocks.approveInactive).not.toHaveBeenCalled();
  });
  it("stops a free export preflight when the vault session changes during the authoritative read", async () => {
    let resolve!: (value: unknown) => void;
    mocks.scopeRequest.mockReturnValue(new Promise(done => { resolve = done; }));
    const state = { paidApprovals: { current: new Set<string>() }, paidApprovalKeys: { current: new Map<string, string>() } };
    const pending = approvePaidOwnerTerms({ ...consent(), scope: "attr.travel.plans", metadata: { scope_handle: "exact-handle" } }, "vault-owner-token", state, message => new Error(message));
    await vi.waitFor(() => expect(mocks.scopeRequest).toHaveBeenCalled());
    advanceVaultSessionEpoch();
    resolve({ role: "owner", tariff: null, duration_seconds: 86400 });
    await expect(pending).rejects.toThrow("vault session changed");
    expect(mocks.approveInactive).not.toHaveBeenCalled();
  });
  it("fails closed if a known paid request cannot verify its tariff", async () => {
    mocks.commerceAccount.mockResolvedValue({ enabled: true });
    mocks.scopeRequest.mockResolvedValue({ role: "owner", tariff: null, duration_seconds: 86400 });
    const { buildConsentExportForScope } = await import("@/lib/consent/export-builder");
    const { result } = renderHook(() => useConsentActions({ userId: "user-1" }));
    await expect(act(async () => result.current.handleApprove({ ...consent("paid-stale"), scope: "attr.travel.plans", metadata: { commercial_required: true } }, { quiet: true }))).rejects.toThrow();
    expect(buildConsentExportForScope).not.toHaveBeenCalled();
    expect(mocks.approvePendingConsent).not.toHaveBeenCalled();
  });
});
