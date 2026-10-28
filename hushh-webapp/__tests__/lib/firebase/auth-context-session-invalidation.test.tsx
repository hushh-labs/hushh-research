// Register the shared provider mocks before importing the provider itself.
import {
  mocks, deferred, makeUser, activeSessionResponse,
  cleanupStatusResponse, deletionInProgressResponse, emitLifecycle, requestExplicitSessionVerification,
  dispatchInvalidation, dispatchAccountNotFoundInvalidation, SessionProbe, renderProvider,
  CleanupInterfaceProbe, ScopedSignOutRaceProbe, OrdinarySignOutProbe, InteractiveSettlementProbe,
  VerifiedPhoneProbe, RetainedPhoneProbe, resetWebAuthMocks, cleanupWebAuthMocks,
} from "./fixtures/auth-context-web-harness";
import { AuthProvider } from "@/lib/firebase/auth-context";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { User } from "firebase/auth";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { isAccountDeletionActive, markAccountDeletionActive } from "@/lib/auth/account-deletion-activity";

import { AUTH_SESSION_INVALIDATED_EVENT, dispatchAuthSessionInvalidated, AUTH_SESSION_SIBLING_TAB_STORAGE_KEY, publishAccountDeletionToSiblingTabs, type AuthSessionInvalidationDetail } from "@/lib/auth/session-invalidation";
import { ACCOUNT_SESSION_VALIDATION_BUDGET_MS } from "@/lib/auth/account-session-policy";
import { CACHE_KEYS, CacheService } from "@/lib/services/cache-service";
import { AUTH_SESSION_VERIFICATION_REQUIRED_EVENT, publishPendingAuthSessionIdentity, publishValidatedAuthSessionOwner, snapshotAuthSessionGeneration, snapshotValidatedAuthSessionOwner } from "@/lib/auth/session-owner";

describe("@feature_account_deletion @trace_loop AuthProvider terminal session invalidation", () => {
  beforeEach(resetWebAuthMocks);

  afterEach(cleanupWebAuthMocks);

  it("purges the exact departed owner after pending sign-out and completed cleanup", async () => {
    const ownerId = "acct_" + "d".repeat(32);
    const operationId = "b99efb85-c1f2-4714-8a63-614d774a25a3";
    const { rememberPendingAccountDeviceDeparture } = await import("@/lib/auth/account-departure-device");
    rememberPendingAccountDeviceDeparture("account-owner", ownerId, operationId);
    publishValidatedAuthSessionOwner(null);
    const review = { previous_generation: 1, cleanup_operation: operationId,
      enrollment_operation: "86f55df8-4527-49e4-81f7-62d9ac3dde7a", expires_at: Math.floor(Date.now() / 1000) + 300, terms_version: 1, digest: "a".repeat(64) };
    mocks.apiGetAccountSessionStatus.mockImplementation(async () => Response.json({ detail: { code: "AUTH_ACCOUNT_NOT_FOUND" } }, { status: 401 }));
    mocks.apiGetAccountCleanupStatus.mockImplementation(async () => Response.json({ operation: {
      ...(await cleanupStatusResponse("complete").json()).operation,
      owner_hash: `sha256:${createHash("sha256").update(ownerId).digest("hex")}`,
    } }));
    mocks.apiGetAccountRegistrationStatus.mockImplementation(async () => Response.json({ state: "ready", review }));
    render(<AuthProvider><CleanupInterfaceProbe /></AuthProvider>);
    await screen.findByRole("heading", { name: "Start fresh?" });
    expect(mocks.clearForUser).toHaveBeenCalledWith(ownerId, { deleteDurableReceipts: true });
    expect(mocks.clearDeviceSecretsForDeletedAccount).toHaveBeenCalledWith(ownerId);
    expect(mocks.clearForUser).not.toHaveBeenCalledWith("account-owner", { deleteDurableReceipts: true });
    expect(mocks.apiStartFreshAccount).not.toHaveBeenCalled();
  });

  it.each(["confirmed", "lost_response"])("starts fresh only after exact review and normal session admission: %s", async outcome => {
    const ownerId = "acct_" + "d".repeat(32);
    const review = { previous_generation: 0, cleanup_operation: "b99efb85-c1f2-4714-8a63-614d774a25a3",
      enrollment_operation: "86f55df8-4527-49e4-81f7-62d9ac3dde7a", expires_at: Math.floor(Date.now() / 1000) + 300, terms_version: 1, digest: "a".repeat(64) };
    mocks.apiGetAccountSessionStatus.mockImplementation(async () => Response.json({ detail: { code: "AUTH_ACCOUNT_NOT_FOUND", account_lifecycle: "deleted" } }, { status: 401 }));
    mocks.apiGetAccountRegistrationStatus.mockImplementation(async () => Response.json({ state: "ready", review }));
    mocks.apiStartFreshAccount.mockImplementation(async () => {
      mocks.apiGetAccountSessionStatus.mockImplementation(async () => activeSessionResponse("account-owner", ownerId, 1));
      if (outcome === "lost_response") throw new TypeError("synthetic lost response");
      return Response.json({ active: true });
    });
    render(<AuthProvider><CleanupInterfaceProbe /></AuthProvider>);
    await screen.findByRole("heading", { name: "Start fresh?" });
    expect(snapshotValidatedAuthSessionOwner()).toBeNull();
    const create = screen.getByRole("button", { name: "Create new account" });
    expect(create).toBeDisabled();
    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.click(create);
    if (outcome === "lost_response") {
      await screen.findByText("We couldn’t confirm the result. Refresh status before trying again.");
      expect(screen.getByRole("button", { name: "Create new account" })).toBeDisabled();
      fireEvent.click(screen.getByRole("button", { name: "Refresh status" }));
    }
    await screen.findByText("Vault content for account-owner");
    expect(snapshotValidatedAuthSessionOwner()?.userId).toBe(ownerId);
    expect(mocks.apiStartFreshAccount).toHaveBeenCalledTimes(1);
    expect(mocks.apiStartFreshAccount).toHaveBeenCalledWith("persisted-token", review, expect.any(Function));
    expect(mocks.authServiceSignOut).not.toHaveBeenCalled();
  });

  it("requires renewed confirmation when registration review terms change", async () => {
    const review = { previous_generation: 0, cleanup_operation: "b99efb85-c1f2-4714-8a63-614d774a25a3",
      enrollment_operation: "86f55df8-4527-49e4-81f7-62d9ac3dde7a", expires_at: Math.floor(Date.now() / 1000) + 300, terms_version: 1, digest: "a".repeat(64) };
    mocks.apiGetAccountSessionStatus.mockImplementation(async () => Response.json({ detail: { code: "AUTH_ACCOUNT_NOT_FOUND" } }, { status: 401 }));
    mocks.apiGetAccountRegistrationStatus.mockImplementation(async () => Response.json({ state: "ready", review }));
    render(<AuthProvider><CleanupInterfaceProbe /></AuthProvider>);
    await screen.findByRole("heading", { name: "Start fresh?" });
    fireEvent.click(screen.getByRole("checkbox"));
    expect(screen.getByRole("button", { name: "Create new account" })).toBeEnabled();
    mocks.apiGetAccountRegistrationStatus.mockImplementation(async () => Response.json({ state: "ready", review: { ...review, digest: "b".repeat(64) } }));
    fireEvent.click(screen.getByRole("button", { name: "Refresh status" }));
    await waitFor(() => expect(screen.getByRole("checkbox")).not.toBeChecked());
    expect(screen.getByRole("button", { name: "Create new account" })).toBeDisabled();
    expect(mocks.apiStartFreshAccount).not.toHaveBeenCalled();
  });

  it("withdraws an admitted owner when forced verification discovers registration recovery", async () => {
    render(<AuthProvider><CleanupInterfaceProbe /></AuthProvider>);
    await screen.findByText("Vault content for account-owner");
    expect(snapshotValidatedAuthSessionOwner()?.userId).toBe("account-owner");
    mocks.apiGetAccountSessionStatus.mockImplementation(async () => Response.json({ detail: { code: "AUTH_ACCOUNT_NOT_FOUND" } }, { status: 401 }));
    mocks.apiGetAccountRegistrationStatus.mockImplementation(async () => Response.json({ state: "fresh_identity_required" }));
    act(() => requestExplicitSessionVerification());
    await screen.findByRole("heading", { name: "Sign in again to start fresh" });
    expect(snapshotValidatedAuthSessionOwner()).toBeNull();
    expect(screen.queryByText("Vault content for account-owner")).toBeNull();
    expect(mocks.authServiceSignOut).not.toHaveBeenCalled();
  });

  it("purges the erased replacement owner's device state before offering a new account", async () => {
    const { CacheSyncService } = await import("@/lib/cache/cache-sync-service");
    vi.mocked(CacheSyncService.onAccountDeleted).mockClear();
    const ownerId = "acct_" + "e".repeat(32);
    mocks.apiGetAccountSessionStatus.mockImplementation(async () => activeSessionResponse("account-owner", ownerId, 1));
    render(<AuthProvider><CleanupInterfaceProbe /></AuthProvider>);
    await screen.findByText("Vault content for account-owner");
    mocks.apiGetAccountSessionStatus.mockImplementation(async () => Response.json({ detail: { code: "AUTH_ACCOUNT_NOT_FOUND" } }, { status: 401 }));
    mocks.apiGetAccountCleanupStatus.mockResolvedValue(cleanupStatusResponse("complete"));
    mocks.apiGetAccountRegistrationStatus.mockImplementation(async () => Response.json({ state: "fresh_identity_required" }));
    act(() => requestExplicitSessionVerification());
    await screen.findByRole("heading", { name: "Sign in again to start fresh" });
    // Registration replaces the terminal sign-out, so its erased-account purge runs here, keyed by the owner.
    expect(mocks.clearDeviceSecretsForDeletedAccount).toHaveBeenCalledWith(ownerId);
    expect(CacheSyncService.onAccountDeleted).toHaveBeenCalledWith(ownerId);
    expect(mocks.clearForUser).toHaveBeenCalledWith(ownerId, { deleteDurableReceipts: true });
    expect(mocks.clearDeviceSecretsForDeletedAccount).not.toHaveBeenCalledWith("account-owner");
    expect(mocks.authServiceSignOut).not.toHaveBeenCalled();
  });

  it.each([
    ["refuses a missing identity", { code: "AUTH_ACCOUNT_NOT_FOUND" }, true],
    ["rejects an expired token", "Invalid Firebase ID token", false],
  ])("admission-on registration status %s", async (_case, detail, terminal) => {
    mocks.apiGetAccountSessionStatus.mockImplementation(async () => Response.json({ detail: { code: "AUTH_ACCOUNT_NOT_FOUND" } }, { status: 401 }));
    mocks.apiGetAccountRegistrationStatus.mockImplementation(async () => Response.json({ detail }, { status: 401 }));
    renderProvider();
    if (terminal) {
      // The same terminal result as the admission-off 404, never an open-ended verification gate.
      await waitFor(() => expect(mocks.replaceDocument).toHaveBeenCalledWith("/login?auth_notice=account_not_found"));
      expect(mocks.clearDeviceSecretsForDeletedAccount).toHaveBeenCalledWith("account-owner");
      return;
    }
    // A generic 401 is recoverable with a fresh token: no sign-out and no purge.
    await screen.findByText("Verification required");
    expect(mocks.replaceDocument).not.toHaveBeenCalled();
    expect(mocks.clearDeviceSecretsForDeletedAccount).not.toHaveBeenCalled();
  });

  it("keeps a replacement owner's device state when an admission-off backend reports it deleted", async () => {
    // Rolling the backend back without admission: the owner cannot even authenticate, so
    // its erasure is unproven. Sign out, but never purge a still-live account's device keys.
    const ownerId = "acct_" + "f".repeat(32);
    mocks.apiGetAccountSessionStatus.mockImplementation(async () => activeSessionResponse("account-owner", ownerId, 1));
    render(<AuthProvider><CleanupInterfaceProbe /></AuthProvider>);
    await screen.findByText("Vault content for account-owner");
    mocks.apiGetAccountSessionStatus.mockImplementation(async () => Response.json({ detail: { code: "AUTH_ACCOUNT_NOT_FOUND", account_lifecycle: "deleted" } }, { status: 401 }));
    act(() => requestExplicitSessionVerification());
    await waitFor(() => expect(mocks.replaceDocument).toHaveBeenCalledWith("/login?auth_notice=session_invalid"));
    expect(mocks.clearDeviceSecretsForDeletedAccount).not.toHaveBeenCalled();
    expect(mocks.clearForUser).not.toHaveBeenCalledWith(ownerId, { deleteDurableReceipts: true });
  });

  it.each(["historical_cleanup_unconfirmed", "identity_write_unconfirmed"])("leads %s to support without refresh or polling", async reason => {
    render(<AuthProvider><CleanupInterfaceProbe /></AuthProvider>);
    await screen.findByText("Vault content for account-owner");
    vi.useFakeTimers();
    mocks.apiGetAccountSessionStatus.mockImplementation(async () => Response.json({ detail: { code: "AUTH_ACCOUNT_NOT_FOUND" } }, { status: 401 }));
    mocks.apiGetAccountRegistrationStatus.mockImplementation(async () => Response.json({ state: "action_required", reason }));
    act(() => requestExplicitSessionVerification());
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(screen.getByRole("heading", { name: "Your previous cleanup needs attention" })).toBeInTheDocument();
    // Neither reason expires or replays on its own (migration 419): only support can settle it,
    // so no refresh is offered and nothing re-checks behind the person.
    expect(screen.getAllByRole("button").map(button => button.textContent)).toEqual(["Sign out"]);
    expect(screen.getByRole("link", { name: "Email support@hushh.ai" })).toHaveAttribute("href", "mailto:support@hushh.ai");
    const reads = mocks.apiGetAccountRegistrationStatus.mock.calls.length;
    await act(async () => { await vi.advanceTimersByTimeAsync(300_000); });
    expect(mocks.apiGetAccountRegistrationStatus).toHaveBeenCalledTimes(reads);
    expect(mocks.apiStartFreshAccount).not.toHaveBeenCalled();
    expect(mocks.authServiceSignOut).not.toHaveBeenCalled();
    expect(snapshotValidatedAuthSessionOwner()).toBeNull();
  });

  it.each([
    ["a phone session", { state: "fresh_identity_required" }, [{ providerId: "phone" }], "phone", "Starting fresh with a phone sign-in isn’t available yet", ["Sign out"]],
    // The phone mandate links a phone to most accounts; only the session's own method names it.
    ["an email-code session with a linked phone", { state: "fresh_identity_required" }, [{ providerId: "phone" }], "custom", "Sign in again to start fresh", ["Sign out"]],
    ["a Google session", { state: "fresh_identity_required" }, [{ providerId: "google.com" }, { providerId: "phone" }], "google.com", "Verify it’s you", ["Verify with Google", "Sign out"]],
    ["a waiting phone session", { state: "waiting_for_identity", retry_at: Math.floor(Date.now() / 1000) + 45 }, [{ providerId: "phone" }], "phone", "Starting fresh with a phone sign-in isn’t available yet", ["Sign out"]],
  ])("offers %s only controls that can change its fresh-proof outcome", async (_case, recovery, providerData, signInProvider, heading, buttons) => {
    mocks.firebaseUser = { ...makeUser(), providerData, getIdTokenResult: async () => ({ signInProvider }) } as unknown as User;
    mocks.apiGetAccountSessionStatus.mockImplementation(async () => Response.json({ detail: { code: "AUTH_ACCOUNT_NOT_FOUND" } }, { status: 401 }));
    mocks.apiGetAccountRegistrationStatus.mockImplementation(async () => Response.json(recovery));
    render(<AuthProvider><CleanupInterfaceProbe /></AuthProvider>);
    await screen.findByRole("heading", { name: heading });
    // Refreshing or waiting can never give this session fresh proof, so neither is offered or promised.
    expect(screen.getAllByRole("button").map(button => button.textContent)).toEqual(buttons);
    expect(screen.queryByText("A fresh sign-in opens shortly.")).toBeNull();
    expect(screen.getByRole("button", { name: "Sign out" })).toBeEnabled();
  });

  it("starts at most two validations for five rapid refreshes and frees the waiting slot once it starts", async () => {
    const notFound = () => Response.json({ detail: { code: "AUTH_ACCOUNT_NOT_FOUND" } }, { status: 401 });
    mocks.apiGetAccountSessionStatus.mockImplementation(async () => notFound());
    mocks.apiGetAccountRegistrationStatus.mockImplementation(async () => Response.json({ state: "fresh_identity_required" }));
    renderProvider();
    const retry = await screen.findByRole("button", { name: "Retry verification" });
    const running = deferred<Response>();
    const waiting = deferred<Response>();
    mocks.apiGetAccountSessionStatus.mockReturnValueOnce(running.promise).mockReturnValueOnce(waiting.promise);
    const reads = () => mocks.apiGetAccountSessionStatus.mock.calls.length - before;
    const before = mocks.apiGetAccountSessionStatus.mock.calls.length;
    for (let tap = 0; tap < 5; tap += 1) fireEvent.click(retry);
    await act(async () => { running.resolve(notFound()); await running.promise; });
    // One ran and one waited; the other three joined the waiting one instead of stacking.
    await waitFor(() => expect(reads()).toBe(2));
    // The waiting one has now read the session, so a later tap must queue a fresh validation.
    fireEvent.click(retry);
    await act(async () => { waiting.resolve(notFound()); await waiting.promise; });
    await waitFor(() => expect(reads()).toBe(3));
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 50)); });
    expect(reads()).toBe(3);
  });

  it("shows Checking… while a review refresh is pending and never disables Sign out", async () => {
    const review = { previous_generation: 0, cleanup_operation: "b99efb85-c1f2-4714-8a63-614d774a25a3",
      enrollment_operation: "86f55df8-4527-49e4-81f7-62d9ac3dde7a", expires_at: Math.floor(Date.now() / 1000) + 300, terms_version: 1, digest: "a".repeat(64) };
    mocks.apiGetAccountSessionStatus.mockImplementation(async () => Response.json({ detail: { code: "AUTH_ACCOUNT_NOT_FOUND" } }, { status: 401 }));
    mocks.apiGetAccountRegistrationStatus.mockImplementation(async () => Response.json({ state: "ready", review }));
    render(<AuthProvider><CleanupInterfaceProbe /></AuthProvider>);
    await screen.findByRole("heading", { name: "Start fresh?" });
    const pending = deferred<Response>();
    mocks.apiGetAccountSessionStatus.mockReturnValueOnce(pending.promise);
    fireEvent.click(screen.getByRole("button", { name: "Refresh status" }));
    expect(await screen.findByRole("button", { name: "Checking…" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Sign out" })).toBeEnabled();
    await act(async () => { pending.resolve(Response.json({ detail: { code: "AUTH_ACCOUNT_NOT_FOUND" } }, { status: 401 })); await pending.promise; });
    expect(await screen.findByRole("button", { name: "Refresh status" })).toBeEnabled();
    // Creating the account keeps Sign out available too.
    const created = deferred<Response>();
    mocks.apiStartFreshAccount.mockReturnValueOnce(created.promise);
    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.click(screen.getByRole("button", { name: "Create new account" }));
    expect(await screen.findByRole("button", { name: "Creating your account…" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Sign out" })).toBeEnabled();
    await act(async () => { created.resolve(Response.json({}, { status: 409 })); await created.promise; });
  });

  it("warns that validation is unavailable only without cleanup or registration evidence", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const outage = "🔒 [AuthProvider] Session validation unavailable; preserving session";
    mocks.apiGetAccountSessionStatus.mockImplementation(async () => Response.json({ detail: { code: "AUTH_ACCOUNT_NOT_FOUND" } }, { status: 401 }));
    mocks.apiGetAccountRegistrationStatus.mockImplementation(async () => Response.json({ state: "fresh_identity_required" }));
    renderProvider();
    fireEvent.click(await screen.findByRole("button", { name: "Retry verification" }));
    await waitFor(() => expect(mocks.apiGetAccountRegistrationStatus.mock.calls.length).toBeGreaterThan(1));
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)); });
    expect(warn).not.toHaveBeenCalledWith(outage);
    // A real outage, with no definite answer, still warns.
    mocks.apiGetAccountSessionStatus.mockRejectedValue(new TypeError("Failed to fetch"));
    fireEvent.click(screen.getByRole("button", { name: "Retry verification" }));
    await waitFor(() => expect(warn).toHaveBeenCalledWith(outage));
    warn.mockRestore();
  });

  it("admits a replacement owner without changing Firebase identity and handles terminal verification", async () => {
    const ownerId = "acct_" + "1".repeat(32);
    mocks.apiGetAccountSessionStatus.mockImplementation(async () => activeSessionResponse("account-owner", ownerId, 1));
    renderProvider();
    await screen.findByText("Vault content for account-owner");
    expect(snapshotValidatedAuthSessionOwner()?.userId).toBe(ownerId);
    act(() => dispatchAuthSessionInvalidated({ code: "account_not_found", userId: "account-owner" }));
    expect(mocks.authServiceSignOut).not.toHaveBeenCalled();
    mocks.apiGetAccountSessionStatus.mockResolvedValueOnce(Response.json({ detail: { code: "AUTH_ACCOUNT_NOT_FOUND" } }, { status: 401 }));
    act(() => requestExplicitSessionVerification());
    // Sign-out cleanup is keyed by the application owner, not the Firebase UID.
    await waitFor(() => expect(mocks.authServiceSignOut).toHaveBeenCalledWith(ownerId));
    expect(mocks.authServiceSignOut).not.toHaveBeenCalledWith("account-owner");
    expect(mocks.clearForUser).toHaveBeenCalledWith(ownerId);
    await waitFor(() => expect(snapshotValidatedAuthSessionOwner()).toBeNull());
    act(() => mocks.authStateListener?.(mocks.firebaseUser));
    await act(async () => { await Promise.resolve(); });
    expect(snapshotValidatedAuthSessionOwner()).toBeNull();
  });

  it.each([null, "account-b"])("retires interactive admission when Firebase changes to %s", async replacement => {
    render(<AuthProvider><SessionProbe /><InteractiveSettlementProbe /></AuthProvider>);
    await screen.findByText("Vault content for account-owner");
    const admission = deferred<Response>();
    mocks.apiGetAccountSessionStatus.mockReturnValueOnce(admission.promise);
    fireEvent.click(screen.getByRole("button", { name: "Complete interactive sign-in" }));
    await waitFor(() => expect(mocks.apiGetAccountSessionStatus).toHaveBeenCalledTimes(2));
    mocks.firebaseUser = replacement ? makeUser(replacement) : null;
    act(() => mocks.authStateListener?.(mocks.firebaseUser));
    if (replacement) await screen.findByText("Vault content for account-b");
    await act(async () => { admission.resolve(activeSessionResponse("account-owner")); await admission.promise; });
    expect(snapshotValidatedAuthSessionOwner()?.userId ?? null).toBe(replacement);
  });

  it("releases only the stale observer gate after forced verification admits a replacement", async () => {
    renderProvider();
    await screen.findByText("Vault content for account-owner");
    const observer = deferred<Response>();
    mocks.apiGetAccountSessionStatus.mockReturnValueOnce(observer.promise);
    act(() => mocks.authStateListener?.(mocks.firebaseUser));
    await waitFor(() => expect(mocks.apiGetAccountSessionStatus).toHaveBeenCalledTimes(2));
    const ownerId = "acct_" + "5".repeat(32);
    mocks.apiGetAccountSessionStatus.mockResolvedValueOnce(activeSessionResponse("account-owner", ownerId, 1));
    act(() => requestExplicitSessionVerification());
    await waitFor(() => expect(snapshotValidatedAuthSessionOwner()?.userId).toBe(ownerId));
    await act(async () => { observer.resolve(activeSessionResponse()); await observer.promise; });
    await screen.findByText("Vault content for account-owner");
    expect(snapshotValidatedAuthSessionOwner()?.userId).toBe(ownerId);
    expect(screen.queryByText("Checking session")).not.toBeInTheDocument();
  });

  it("rejects a same-UID observer response from before a new interactive admission", async () => {
    render(<AuthProvider><SessionProbe /><InteractiveSettlementProbe /></AuthProvider>);
    await screen.findByText("Vault content for account-owner");
    const oldStatus = deferred<Response>();
    mocks.apiGetAccountSessionStatus.mockReturnValueOnce(oldStatus.promise);
    act(() => mocks.authStateListener?.(mocks.firebaseUser));
    await waitFor(() => expect(mocks.apiGetAccountSessionStatus).toHaveBeenCalledTimes(2));
    const ownerId = "acct_" + "2".repeat(32);
    mocks.apiGetAccountSessionStatus.mockResolvedValueOnce(activeSessionResponse("account-owner", ownerId, 1));
    fireEvent.click(screen.getByRole("button", { name: "Complete interactive sign-in" }));
    await waitFor(() => expect(snapshotValidatedAuthSessionOwner()?.userId).toBe(ownerId));
    await act(async () => { oldStatus.resolve(activeSessionResponse()); await oldStatus.promise; });
    expect(snapshotValidatedAuthSessionOwner()?.userId).toBe(ownerId);
    expect(screen.queryByText("Checking session")).not.toBeInTheDocument();
  });

  it("does not restart a confirmed-missing phone lookup when returning to an active OTP attempt", async () => {
    mocks.firebaseUser = makeUser("account-owner", "");
    const identity = { user_id: "account-owner", phone_verified: false };
    mocks.identityPeek.mockReturnValue({ data: identity, isStale: false });
    render(<AuthProvider><SessionProbe /><VerifiedPhoneProbe /></AuthProvider>);
    await screen.findByText("Vault content for account-owner");
    expect(screen.getByTestId("phone-status")).toHaveTextContent("missing");
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Send phone OTP" })); });
    act(() => {
      emitLifecycle("background");
      emitLifecycle("active");
      window.dispatchEvent(new Event("focus"));
      window.dispatchEvent(new Event("online"));
      mocks.authStateListener?.(mocks.firebaseUser);
    });
    await act(async () => { await Promise.resolve(); });
    expect(mocks.identityRefresh).not.toHaveBeenCalled();
    expect(screen.getByTestId("phone-status")).toHaveTextContent("missing");
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Confirm phone OTP" })); });
    expect(mocks.phoneClaimToken).toHaveBeenCalledTimes(1);
  });

  it("bounds automatic retries and stops them while offline or unmounted", async () => {
    mocks.firebaseUser = makeUser("account-owner", "");
    const view = render(<AuthProvider><SessionProbe /><VerifiedPhoneProbe /></AuthProvider>);
    await screen.findByText("Vault content for account-owner");
    await waitFor(() => expect(screen.getByTestId("phone-status")).toHaveTextContent("unavailable"));
    vi.useFakeTimers();
    // The first timer was scheduled before switching clocks; restart the
    // episode through the real lifecycle wake so the clock owns its timers.
    await act(async () => { window.dispatchEvent(new Event("focus")); });
    const startCount = mocks.identityRefresh.mock.calls.length;
    Object.defineProperty(navigator, "onLine", { configurable: true, value: false });
    await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
    expect(mocks.identityRefresh).toHaveBeenCalledTimes(startCount);
    Object.defineProperty(navigator, "onLine", { configurable: true, value: true });
    await act(async () => { window.dispatchEvent(new Event("online")); });
    await act(async () => { await vi.advanceTimersByTimeAsync(120_000); });
    const exhaustedCount = mocks.identityRefresh.mock.calls.length;
    expect(exhaustedCount).toBeLessThanOrEqual(startCount + 4);
    expect(exhaustedCount).toBeGreaterThan(startCount + 1);
    await act(async () => { await vi.advanceTimersByTimeAsync(120_000); });
    expect(mocks.identityRefresh).toHaveBeenCalledTimes(exhaustedCount);
    view.unmount();
    await act(async () => {
      window.dispatchEvent(new Event("online"));
      window.dispatchEvent(new Event("focus"));
      emitLifecycle("active");
      await vi.advanceTimersByTimeAsync(120_000);
    });
    expect(mocks.identityRefresh).toHaveBeenCalledTimes(exhaustedCount);
  });

  it.each(["missing", "stale", "bootstrap hint"])("revalidates a restored provider phone against %s canonical evidence", async evidence => {
    const previous = "+14155550100";
    const identity = { user_id: "account-owner", phone_number: "+919000000001", phone_verified: true };
    mocks.firebaseUser = makeUser("account-owner", previous);
    mocks.identityPeek.mockReturnValue(evidence === "missing" ? null : {
      data: { ...identity, phone_number: evidence === "stale" ? previous : null, source: evidence === "stale" ? "firebase_auth" : "vault_bootstrap_hint" },
      isStale: evidence === "stale",
    });
    mocks.identityRefresh.mockImplementationOnce(async () => {
      mocks.identityPeek.mockReturnValue({ data: identity, isStale: false });
      return identity;
    });
    render(<AuthProvider><SessionProbe /><VerifiedPhoneProbe /></AuthProvider>);
    await waitFor(() => expect(screen.getByTestId("verified-phone")).toHaveTextContent(identity.phone_number));
    expect(mocks.identityRefresh).toHaveBeenCalledTimes(1);
    expect(mocks.phoneClaimToken).not.toHaveBeenCalled();
  });

  it("retains the restored number through failed canonical reads, then recovers on foreground", async () => {
    const previous = "+14155550100";
    mocks.firebaseUser = makeUser("account-owner", previous);
    mocks.identityRefresh.mockRejectedValueOnce(new Error("Temporary outage"));
    render(<AuthProvider><SessionProbe /><VerifiedPhoneProbe /></AuthProvider>);
    await screen.findByText("Vault content for account-owner");
    await waitFor(() => expect(mocks.identityRefresh).toHaveBeenCalledTimes(1));
    expect(screen.getByTestId("verified-phone")).toHaveTextContent(previous);
    expect(screen.getByTestId("phone-status")).toHaveTextContent("verified");
    const identity = { user_id: "account-owner", phone_number: "+919000000001", phone_verified: true };
    mocks.identityRefresh.mockImplementationOnce(async () => {
      mocks.identityPeek.mockReturnValue({ data: identity, isStale: false });
      return identity;
    });
    act(() => window.dispatchEvent(new Event("focus")));
    await waitFor(() => expect(screen.getByTestId("verified-phone")).toHaveTextContent(identity.phone_number));
  });

  it.each(["empty response", "network failure"])("recovers the saved phone after an initial %s without another OTP", async (failure) => {
    mocks.firebaseUser = makeUser("account-owner", "");
    mocks.identityRefresh.mockReset();
    if (failure === "network failure") mocks.identityRefresh.mockRejectedValueOnce(new Error("temporary outage"));
    else mocks.identityRefresh.mockResolvedValueOnce(null);
    render(<AuthProvider><SessionProbe /><VerifiedPhoneProbe /></AuthProvider>);
    await screen.findByText("Vault content for account-owner");
    await waitFor(() => expect(mocks.identityRefresh).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.getByTestId("phone-status")).toHaveTextContent("unavailable"));
    const identity = { user_id: "account-owner", phone_number: "+12025550101", phone_verified: true };
    mocks.identityPeek.mockReturnValue({ data: identity, isStale: false });
    mocks.identityRefresh.mockResolvedValue(identity);
    act(() => {
      window.dispatchEvent(new Event("online"));
      window.dispatchEvent(new Event("focus"));
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await waitFor(() => expect(screen.getByTestId("verified-phone")).toHaveTextContent(identity.phone_number));
    expect(mocks.phoneClaimToken).not.toHaveBeenCalled();
    expect(mocks.identityClaim).not.toHaveBeenCalled();
  });

  it("publishes later verified same-owner cache updates without a reload", async () => {
    mocks.firebaseUser = makeUser("account-owner", "");
    render(<AuthProvider><SessionProbe /><VerifiedPhoneProbe /></AuthProvider>);
    await screen.findByText("Vault content for account-owner");
    await waitFor(() => expect(mocks.identityRefresh).toHaveBeenCalled());
    const identity = { user_id: "account-owner", phone_number: "+12025550101", phone_verified: true };
    mocks.identityPeek.mockReturnValue({ data: identity, isStale: false });
    act(() => CacheService.getInstance().set(CACHE_KEYS.ACCOUNT_IDENTITY("account-owner"), identity));
    await waitFor(() => expect(screen.getByTestId("verified-phone")).toHaveTextContent(identity.phone_number));
  });

  it.each([
    { restored: false, removed: false },
    { restored: true, removed: false },
    { restored: false, removed: true },
    { restored: true, removed: true },
  ])("keeps newer committed phone evidence after a read returns (restored: $restored, removed: $removed)", async ({ restored, removed }) => {
    mocks.firebaseUser = makeUser("account-owner", restored ? "+14155550100" : "");
    const previous = { user_id: "account-owner", phone_number: "+14155550101", phone_verified: true };
    const latest = { user_id: "account-owner", phone_number: removed ? null : "+919000000001", phone_verified: !removed };
    const publish = (identity: typeof latest) => {
      mocks.identityPeek.mockReturnValue({ data: identity, isStale: false });
      CacheService.getInstance().set(CACHE_KEYS.ACCOUNT_IDENTITY("account-owner"), identity);
    };
    mocks.identityRefresh.mockImplementationOnce(async () => {
      publish(previous);
      // The read is already accepted by the service. A later claim publishes
      // before its awaiting AuthProvider consumer resumes.
      queueMicrotask(() => publish(latest));
      return previous;
    });
    render(<AuthProvider><SessionProbe /><VerifiedPhoneProbe /></AuthProvider>);
    await screen.findByText("Vault content for account-owner");
    await act(async () => { await Promise.resolve(); });
    expect(mocks.identityRefresh).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId("verified-phone")).toHaveTextContent(latest.phone_number ?? "missing");
    expect(screen.getByTestId("phone-status")).toHaveTextContent(removed ? "missing" : "verified");
    expect(mocks.phoneClaimToken).not.toHaveBeenCalled();
  });

  it.each(["foreign", "stale", "unverified", "bootstrap hint"])("ignores %s phone evidence in cache notifications", async (kind) => {
    mocks.firebaseUser = makeUser("account-owner", "");
    render(<AuthProvider><SessionProbe /><VerifiedPhoneProbe /></AuthProvider>);
    await screen.findByText("Vault content for account-owner");
    await waitFor(() => expect(screen.getByTestId("phone-status")).toHaveTextContent("unavailable"));
    const identity = {
      user_id: kind === "foreign" ? "another-owner" : "account-owner",
      phone_number: "+12025550101",
      phone_verified: kind !== "unverified",
      source: kind === "bootstrap hint" ? "vault_bootstrap_hint" : "firebase",
    };
    mocks.identityPeek.mockReturnValue({ data: identity, isStale: kind === "stale" });
    act(() => CacheService.getInstance().set(CACHE_KEYS.ACCOUNT_IDENTITY("account-owner"), identity));
    expect(screen.getByTestId("verified-phone")).toHaveTextContent("missing");
  });

  it("resolves a later full negative cache claim without leaving profile recovery stuck", async () => {
    mocks.firebaseUser = makeUser("account-owner", "");
    render(<AuthProvider><SessionProbe /><VerifiedPhoneProbe /></AuthProvider>);
    await screen.findByText("Vault content for account-owner");
    await waitFor(() => expect(screen.getByTestId("phone-status")).toHaveTextContent("unavailable"));
    const identity = { user_id: "account-owner", phone_verified: false };
    mocks.identityPeek.mockReturnValue({ data: identity, isStale: false });
    act(() => CacheService.getInstance().set(CACHE_KEYS.ACCOUNT_IDENTITY("account-owner"), identity));
    expect(screen.getByTestId("phone-status")).toHaveTextContent("missing");
    const count = mocks.identityRefresh.mock.calls.length;
    act(() => window.dispatchEvent(new Event("focus")));
    expect(mocks.identityRefresh).toHaveBeenCalledTimes(count);
  });

  it("honors a real phone binding removal without resurrecting the old provider phone after cache expiry", async () => {
    mocks.firebaseUser = makeUser("account-owner", "+12025550101");
    render(<AuthProvider><SessionProbe /><VerifiedPhoneProbe /></AuthProvider>);
    await waitFor(() => expect(mocks.identityRefresh).toHaveBeenCalledTimes(1));
    expect(screen.getByTestId("verified-phone")).toHaveTextContent("+12025550101");
    const identity = { user_id: "account-owner", phone_number: null, phone_verified: false, source: "firebase_phone_claim" };
    mocks.identityPeek.mockReturnValue({ data: identity, isStale: false });
    act(() => CacheService.getInstance().set(CACHE_KEYS.ACCOUNT_IDENTITY("account-owner"), identity));
    expect(screen.getByTestId("verified-phone")).toHaveTextContent("missing");
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Resolve saved phone" })); });
    expect(screen.getByTestId("resolved-phone")).toHaveTextContent("missing");
    mocks.identityPeek.mockReturnValue({ data: identity, isStale: true });
    await act(async () => {
      mocks.authStateListener?.(mocks.firebaseUser);
      fireEvent.click(screen.getByRole("button", { name: "Resolve saved phone" }));
    });
    expect(screen.getByTestId("phone-status")).toHaveTextContent("missing");
    expect(screen.getByTestId("verified-phone")).toHaveTextContent("missing");
    expect(screen.getByTestId("resolved-phone")).toHaveTextContent("missing");
  });

  it("preserves a known phone across a degraded legacy identity projection", async () => {
    render(<AuthProvider><SessionProbe /><VerifiedPhoneProbe /></AuthProvider>);
    await screen.findByText("Vault content for account-owner");
    const knownPhone = screen.getByTestId("verified-phone").textContent;
    const identity = { user_id: "account-owner", phone_number: null, phone_verified: false, source: "legacy_fallback" };
    mocks.identityPeek.mockReturnValue({ data: identity, isStale: false });
    await act(async () => {
      CacheService.getInstance().set(CACHE_KEYS.ACCOUNT_IDENTITY("account-owner"), identity);
      mocks.authStateListener?.(mocks.firebaseUser);
    });
    expect(screen.getByTestId("verified-phone")).toHaveTextContent(knownPhone!);
    expect(screen.getByTestId("phone-status")).toHaveTextContent("verified");
  });

  it("revalidates expired absence on foreground and discovers a phone saved on another device", async () => {
    mocks.firebaseUser = makeUser("account-owner", "");
    const missing = { user_id: "account-owner", phone_verified: false };
    mocks.identityPeek.mockReturnValue({ data: missing, isStale: false });
    render(<AuthProvider><SessionProbe /><VerifiedPhoneProbe /></AuthProvider>);
    await screen.findByText("Vault content for account-owner");
    expect(screen.getByTestId("phone-status")).toHaveTextContent("missing");
    mocks.identityPeek.mockReturnValue({ data: missing, isStale: true });
    const verified = { user_id: "account-owner", phone_verified: true, phone_number: "+12025550102" };
    mocks.identityRefresh.mockResolvedValue(verified);
    await act(async () => { window.dispatchEvent(new Event("focus")); });
    await waitFor(() => expect(screen.getByTestId("verified-phone")).toHaveTextContent(verified.phone_number));
    expect(mocks.phoneClaimToken).not.toHaveBeenCalled();
  });

  it("does not overwrite a later confirmed absence when an older lookup returns empty", async () => {
    mocks.firebaseUser = makeUser("account-owner", "");
    let finish!: (identity: null) => void;
    mocks.identityRefresh.mockReturnValueOnce(new Promise((resolve) => { finish = resolve; }));
    render(<AuthProvider><SessionProbe /><VerifiedPhoneProbe /></AuthProvider>);
    await screen.findByText("Vault content for account-owner");
    await waitFor(() => expect(mocks.identityRefresh).toHaveBeenCalledTimes(1));
    const identity = { user_id: "account-owner", phone_verified: false };
    mocks.identityPeek.mockReturnValue({ data: identity, isStale: false });
    await act(async () => {
      CacheService.getInstance().set(CACHE_KEYS.ACCOUNT_IDENTITY("account-owner"), identity);
      finish(null);
    });
    expect(screen.getByTestId("phone-status")).toHaveTextContent("missing");
  });

  it("retains the verified phone when the same Firebase user is republished after cache expiry", async () => {
    mocks.firebaseUser = makeUser("account-owner", "");
    const identity = { user_id: "account-owner", phone_number: "+12025550101", phone_verified: true };
    mocks.identityPeek.mockReturnValue({ data: identity, isStale: false });
    render(<AuthProvider><SessionProbe /><VerifiedPhoneProbe /></AuthProvider>);
    await screen.findByText("Vault content for account-owner");
    mocks.identityPeek.mockReturnValue({ data: identity, isStale: true });
    act(() => mocks.authStateListener?.(mocks.firebaseUser));
    await act(async () => { await Promise.resolve(); });
    expect(screen.getByTestId("verified-phone")).toHaveTextContent(identity.phone_number);
  });

  it("prefers the committed app phone over an older primary provider phone, including after cache expiry", async () => {
    mocks.firebaseUser = makeUser("account-owner", "+12025550100");
    const identity = { user_id: "account-owner", phone_number: "+12025550101", phone_verified: true };
    mocks.identityPeek.mockReturnValue({ data: identity, isStale: false });
    render(<AuthProvider><SessionProbe /><VerifiedPhoneProbe /></AuthProvider>);
    await screen.findByText("Vault content for account-owner");
    expect(screen.getByTestId("verified-phone")).toHaveTextContent(identity.phone_number);
    mocks.identityPeek.mockReturnValue({ data: identity, isStale: true });
    await act(async () => { mocks.authStateListener?.(mocks.firebaseUser); });
    expect(screen.getByTestId("verified-phone")).toHaveTextContent(identity.phone_number);
  });

  it("publishes the committed backend phone after web OTP even when Firebase republishes the same phone-less user", async () => {
    mocks.firebaseUser = makeUser("account-owner", "");
    let snapshot: object | null = null;
    mocks.identityPeek.mockImplementation((uid: string) => uid === "account-owner" ? snapshot : null);
    mocks.identityClaim.mockImplementation(async () => {
      const identity = { user_id: "account-owner", phone_number: "+12025550101", phone_verified: true };
      snapshot = { data: identity, isStale: false };
      return identity;
    });
    render(<AuthProvider><SessionProbe /><VerifiedPhoneProbe /></AuthProvider>);
    await screen.findByText("Vault content for account-owner");
    await waitFor(() => expect(mocks.identityRefresh).toHaveBeenCalled());
    expect(screen.getByTestId("verified-phone")).toHaveTextContent("missing");
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Send phone OTP" })); });
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Confirm phone OTP" })); });
    await waitFor(() => expect(screen.getByTestId("verified-phone")).toHaveTextContent("+12025550101"));
    expect(mocks.identityClaim).toHaveBeenCalledWith(mocks.firebaseUser, "phone-id-token");
    act(() => mocks.authStateListener?.(mocks.firebaseUser));
    expect(screen.getByTestId("verified-phone")).toHaveTextContent("+12025550101");
    const otherUser = makeUser("other-owner", "");
    act(() => mocks.authStateListener?.(otherUser));
    await waitFor(() => expect(screen.getByTestId("verified-phone")).toHaveTextContent("missing"));
  });

  it.each([true, false])("requires backend persistence for a web phone replacement (available: %s)", async available => {
    mocks.firebaseUser = makeUser("account-owner", "+919000000001");
    mocks.identityClaim.mockResolvedValue({ user_id: "account-owner", phone_number: "+12025550101", phone_verified: true });
    if (!available) mocks.identityClaim.mockRejectedValue(new Error("Phone verification could not be saved"));
    render(<AuthProvider><SessionProbe /><RetainedPhoneProbe replacement /></AuthProvider>);
    await screen.findByText("Vault content for account-owner");
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Start retained phone" })); });
    fireEvent.click(screen.getByRole("button", { name: "Confirm current phone" }));
    await waitFor(() => expect(mocks.identityClaim).toHaveBeenCalledWith(mocks.firebaseUser, "phone-id-token"));
    await waitFor(() => expect(screen.getByTestId("retained-phone-error")).toHaveTextContent(available ? "Saved" : "could not be saved"));
    expect(mocks.phoneReplacementConfirm).not.toHaveBeenCalled();
    expect(mocks.phoneFinalize).not.toHaveBeenCalled();
    expect(mocks.firebaseUser?.phoneNumber).toBe("+919000000001");
  });

  it("repairs a provider-linked replacement after a backend outage without sending another OTP", async () => {
    mocks.firebaseUser = makeUser("account-owner", "+12025550101");
    mocks.identityPeek.mockReturnValue({ data: { user_id: "account-owner", phone_number: "+919000000001", phone_verified: true }, isStale: false });
    render(<AuthProvider><SessionProbe /><RetainedPhoneProbe replacement /></AuthProvider>);
    await screen.findByText("Vault content for account-owner");
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Start retained phone" })); });
    expect(mocks.phoneFinalize).toHaveBeenCalledWith(mocks.firebaseUser, "+12025550101");
    expect(mocks.phoneReplacementStart).not.toHaveBeenCalled();
  });

  it.each([
    { stale: true, verified: true },
    { stale: false, verified: false },
  ])("does not publish stale or unverified cached phone evidence: %j", async ({ stale, verified }) => {
    mocks.firebaseUser = makeUser("account-owner", "");
    mocks.identityPeek.mockReturnValue({ data: { user_id: "account-owner", phone_number: "+12025550101", phone_verified: verified }, isStale: stale });
    render(<AuthProvider><SessionProbe /><VerifiedPhoneProbe /></AuthProvider>);
    await screen.findByText("Vault content for account-owner");
    expect(screen.getByTestId("verified-phone")).toHaveTextContent("missing");
  });

  it.each(["account switch", "same-user resend"])("does not submit an old OTP after %s while phone proof is pending", async (change) => {
    mocks.firebaseUser = makeUser("account-owner", "");
    const token = deferred<string>();
    mocks.phoneClaimToken.mockReturnValueOnce(token.promise);
    render(<AuthProvider><SessionProbe /><VerifiedPhoneProbe /></AuthProvider>);
    await screen.findByText("Vault content for account-owner");
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Send phone OTP" })); });
    fireEvent.click(screen.getByRole("button", { name: "Confirm phone OTP" }));
    await waitFor(() => expect(mocks.phoneClaimToken).toHaveBeenCalled());
    if (change === "account switch") {
      mocks.firebaseUser = makeUser("other-owner", "");
      act(() => mocks.authStateListener?.(mocks.firebaseUser));
    } else {
      await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Send phone OTP" })); });
    }
    await act(async () => { token.resolve("old-phone-proof"); });
    await waitFor(() => expect(screen.getByTestId("phone-error")).toHaveTextContent("account changed"));
    expect(mocks.identityClaim).not.toHaveBeenCalled();
  });

  it.each([
    { replacement: false, switchAccount: true },
    { replacement: false, switchAccount: false },
    { replacement: true, switchAccount: true },
    { replacement: true, switchAccount: false },
  ])("rejects retained confirmation after another challenge starts: %j", async ({ replacement, switchAccount }) => {
    render(<AuthProvider><SessionProbe /><RetainedPhoneProbe replacement={replacement} /></AuthProvider>);
    await screen.findByText("Vault content for account-owner");
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Start retained phone" })); });
    fireEvent.click(screen.getByRole("button", { name: "Retain confirmation" }));
    if (switchAccount) {
      mocks.firebaseUser = makeUser("other-owner", "");
      act(() => mocks.authStateListener?.(mocks.firebaseUser));
      await screen.findByText("Vault content for other-owner");
    }
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Start retained phone" })); });
    fireEvent.click(screen.getByRole("button", { name: "Invoke retained confirmation" }));
    await waitFor(() => expect(screen.getByTestId("retained-phone-error")).toHaveTextContent("account changed"));
    expect(mocks.phoneClaimToken).not.toHaveBeenCalled();
    expect(mocks.phoneReplacementConfirm).not.toHaveBeenCalled();
    expect(mocks.identityClaim).not.toHaveBeenCalled();
  });

  it("withdraws the live identity immediately and leaves profile when push cleanup stalls", async () => {
    renderProvider();
    await screen.findByText("Vault content for account-owner");
    vi.useFakeTimers();
    const cleanup = deferred<void>();
    mocks.deleteFCMToken.mockReturnValueOnce(cleanup.promise);

    fireEvent.click(screen.getByRole("button", { name: "Sign out", exact: true }));
    await act(async () => { await Promise.resolve(); });
    expect(snapshotValidatedAuthSessionOwner()).toBeNull();
    await act(async () => { await vi.advanceTimersByTimeAsync(2_000); });

    expect(mocks.authServiceSignOut).toHaveBeenCalledOnce();
    expect(mocks.apiDeleteSession).toHaveBeenCalledOnce();
    expect(mocks.replaceDocument).toHaveBeenCalledWith("/");
    expect(mocks.routerReplace).not.toHaveBeenCalled();
    const signal = mocks.deleteFCMToken.mock.calls[0]?.[2]?.signal as AbortSignal;
    expect(signal.aborted).toBe(true);
    cleanup.resolve();
  });

  it("finishes ordinary sign-out when the optional notification token never resolves", async () => {
    renderProvider();
    await screen.findByText("Vault content for account-owner");
    const token = deferred<string>();
    vi.mocked((mocks.firebaseUser as User).getIdToken).mockReturnValue(token.promise);
    vi.useFakeTimers();

    fireEvent.click(screen.getByRole("button", { name: "Sign out", exact: true }));
    await act(async () => { await vi.advanceTimersByTimeAsync(2_000); });
    expect(mocks.authServiceSignOut).toHaveBeenCalledOnce();
    expect(mocks.replaceDocument).toHaveBeenCalledWith("/");
    await act(async () => { token.resolve("late-token"); await token.promise; });
    expect(mocks.deleteFCMToken).not.toHaveBeenCalled();
  });

  it("allows verification after interactive sign-in overlaps an auth snapshot", async () => {
    render(<AuthProvider><SessionProbe /><InteractiveSettlementProbe /></AuthProvider>);
    await screen.findByText("Vault content for account-owner");
    const validation = deferred<Response>();
    mocks.apiGetAccountSessionStatus.mockReturnValueOnce(validation.promise);
    act(() => mocks.authStateListener?.(mocks.firebaseUser));
    await waitFor(() => expect(screen.getByText("Checking session")).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "Complete interactive sign-in" }));
    await act(async () => {
      validation.resolve(activeSessionResponse());
      await validation.promise;
    });
    act(() => requestExplicitSessionVerification());
    await screen.findByText("Vault content for account-owner");
    expect(screen.queryByText("Checking session")).not.toBeInTheDocument();
  });

  it("does not republish a pre-sign-out auth snapshot after its validation finishes", async () => {
    render(<AuthProvider><SessionProbe /><OrdinarySignOutProbe /></AuthProvider>);
    await screen.findByText("Vault content for account-owner");
    const validation = deferred<Response>();
    mocks.apiGetAccountSessionStatus.mockReturnValueOnce(validation.promise);
    act(() => mocks.authStateListener?.(mocks.firebaseUser));
    fireEvent.click(screen.getByRole("button", { name: "Leave profile" }));
    await waitFor(() => expect(mocks.replaceDocument).toHaveBeenCalledWith("/"));
    await act(async () => {
      validation.resolve(activeSessionResponse());
      await validation.promise;
    });
    expect(snapshotValidatedAuthSessionOwner()).toBeNull();
    expect(screen.queryByText("Vault content for account-owner")).not.toBeInTheDocument();
  });

  it("does not refresh the identity shadow during automated reviewer bootstrap", async () => {
    window.__HUSHH_NATIVE_TEST__ = {
      enabled: true,
      autoReviewerLogin: true,
    };
    mocks.firebaseUser = makeUser("account-owner", null);

    renderProvider();

    await screen.findByText("Vault content for account-owner");
    await act(async () => Promise.resolve());

    expect(mocks.identityRefresh).not.toHaveBeenCalled();
  });

  it("can leave recovery without waiting on token-dependent notification cleanup", async () => {
    renderProvider();
    await screen.findByText("Vault content for account-owner");
    const currentUser = mocks.firebaseUser as User;
    const stalledToken = deferred<string>();
    vi.mocked(currentUser.getIdToken)
      .mockClear()
      .mockReturnValue(stalledToken.promise);

    fireEvent.click(screen.getByRole("button", { name: "Finish account-A deletion" }));

    await waitFor(() => expect(mocks.replaceDocument).toHaveBeenCalledWith("/"));
    // The loading gate stays held until the document unloads; releasing it
    // lets route guards race a client-side /login replace against this one.
    expect(screen.getByText("Checking session")).toBeInTheDocument();
    expect(screen.queryByText("Signed out")).not.toBeInTheDocument();
    expect(currentUser.getIdToken).not.toHaveBeenCalled();
    expect(mocks.authServiceSignOut).toHaveBeenCalledTimes(1);
    expect(mocks.apiDeleteSession).toHaveBeenCalledTimes(1);
    expect(mocks.clearForUser).toHaveBeenCalledWith("account-owner");
    expect(mocks.replaceDocument).toHaveBeenCalledWith("/");
  });

  it.each(["fresh", "missing"])("preserves an already-published session on foreground with %s phone evidence", async (evidence) => {
    if (evidence === "fresh") {
      mocks.identityPeek.mockReturnValue({ data: {
        user_id: "account-owner", phone_number: "+14155550100", phone_verified: true,
      }, isStale: false });
    }
    render(<AuthProvider><SessionProbe /><VerifiedPhoneProbe /></AuthProvider>);

    await screen.findByText("Vault content for account-owner");
    await act(async () => Promise.resolve());
    const currentUser = mocks.firebaseUser as User;
    vi.mocked(currentUser.getIdToken).mockClear();
    mocks.apiGetAccountSessionStatus.mockClear();
    mocks.identityRefresh.mockClear();

    act(() => {
      emitLifecycle("background");
      emitLifecycle("active");
    });

    await act(async () => Promise.resolve());
    expect(currentUser.getIdToken).not.toHaveBeenCalled();
    expect(mocks.apiGetAccountSessionStatus).not.toHaveBeenCalled();
    expect(mocks.identityRefresh).toHaveBeenCalledTimes(evidence === "fresh" ? 0 : 1);
    expect(screen.getByTestId("verified-phone")).toHaveTextContent("+14155550100");
    expect(screen.getByTestId("phone-status")).toHaveTextContent("verified");
    expect(screen.queryByText("Checking session")).not.toBeInTheDocument();
    expect(
      screen.getByText("Vault content for account-owner"),
    ).toBeInTheDocument();
  });

  it("does not remount protected UI for duplicate focus events", async () => {
    renderProvider();

    await screen.findByText("Vault content for account-owner");
    mocks.apiGetAccountSessionStatus.mockClear();

    act(() => {
      window.dispatchEvent(new Event("focus"));
    });

    await act(async () => Promise.resolve());
    expect(mocks.apiGetAccountSessionStatus).not.toHaveBeenCalled();
    expect(screen.queryByText("Checking session")).not.toBeInTheDocument();

    act(() => {
      window.dispatchEvent(new Event("pageshow"));
    });
    await act(async () => Promise.resolve());

    expect(mocks.apiGetAccountSessionStatus).not.toHaveBeenCalled();
    expect(screen.queryByText("Checking session")).not.toBeInTheDocument();
    expect(screen.getByText("Vault content for account-owner")).toBeInTheDocument();
  });

  it("coalesces account-not-found invalidation into one sign-out and login redirect", async () => {
    const signOut = deferred<void>();
    renderProvider();

    await screen.findByText("Vault content for account-owner");
    mocks.apiGetAccountSessionStatus.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          detail: {
            code: "AUTH_ACCOUNT_NOT_FOUND",
            message: "Account not found",
          },
        }),
        { status: 401 },
      ),
    );
    mocks.authServiceSignOut.mockReturnValueOnce(signOut.promise);

    act(() => requestExplicitSessionVerification());

    await waitFor(() => {
      expect(mocks.authServiceSignOut).toHaveBeenCalledTimes(1);
    });
    expect(screen.getByText("Checking session")).toBeInTheDocument();

    act(() => dispatchAccountNotFoundInvalidation());
    expect(mocks.authServiceSignOut).toHaveBeenCalledTimes(1);

    await act(async () => {
      signOut.resolve();
      await signOut.promise;
    });

    await waitFor(() => {
      expect(mocks.replaceDocument).toHaveBeenCalledTimes(1);
    });
    expect(mocks.replaceDocument).toHaveBeenCalledWith(
      "/login?auth_notice=account_not_found",
    );
    expect(mocks.cacheSignedOut).toHaveBeenCalledWith("account-owner");
  });

  it.each(["commit", "rollback"] as const)("settles an in-flight deletion as %s after foreground validation", async (outcome) => {
    renderProvider();
    await screen.findByText("Vault content for account-owner");
    mocks.apiGetAccountCleanupStatus.mockResolvedValueOnce(outcome === "commit" ? cleanupStatusResponse("complete") : new Response(null, { status: 404 }));
    mocks.apiGetAccountSessionStatus
      .mockResolvedValueOnce(deletionInProgressResponse())
      .mockResolvedValueOnce(outcome === "commit"
        ? Response.json({ detail: { code: "AUTH_ACCOUNT_NOT_FOUND" } }, { status: 401 })
        : activeSessionResponse());
    act(() => requestExplicitSessionVerification());
    expect(screen.getByText("Checking session")).toBeInTheDocument();
    expect(screen.queryByText("Vault content for account-owner")).not.toBeInTheDocument();
    if (outcome === "commit") {
      await waitFor(() => expect(mocks.authServiceSignOut).toHaveBeenCalledTimes(1));
      expect(mocks.replaceDocument).toHaveBeenCalledWith("/login?auth_notice=account_deletion_identity_retained");
      // Deletion settles after a 202 handoff, so delete-account.ts never purges;
      // the confirmed erasure must still take the device's durable copies.
      expect(mocks.clearForUser).toHaveBeenCalledWith("account-owner", { deleteDurableReceipts: true });
    } else {
      expect(await screen.findByText("Vault content for account-owner")).toBeInTheDocument();
      expect(mocks.authServiceSignOut).not.toHaveBeenCalled();
      expect(mocks.replaceDocument).not.toHaveBeenCalled();
      expect(mocks.clearForUser).not.toHaveBeenCalledWith("account-owner", { deleteDurableReceipts: true });
    }
  });

  it("@feature_account_deletion @trace_loop seals the session while deletion remains pending, then observes rollback", async () => {
    renderProvider();
    await screen.findByText("Vault content for account-owner");
    mocks.apiGetAccountSessionStatus
      .mockResolvedValueOnce(deletionInProgressResponse())
      .mockResolvedValueOnce(deletionInProgressResponse())
      .mockResolvedValueOnce(activeSessionResponse());

    act(() => requestExplicitSessionVerification());

    expect(screen.getByText("Checking session")).toBeInTheDocument();
    await waitFor(() => {
      expect(mocks.apiGetAccountSessionStatus).toHaveBeenCalledTimes(3);
    });
    expect(mocks.authServiceSignOut).not.toHaveBeenCalled();
    expect(mocks.replaceDocument).not.toHaveBeenCalled();
    expect(isAccountDeletionActive("account-owner")).toBe(true);
    expect(await screen.findByText("Vault content for account-owner", {}, { timeout: 5_000 })).toBeInTheDocument();
    expect(isAccountDeletionActive("account-owner")).toBe(false);
  });

  it("preserves identity behind recovery while durable deletion progress is unavailable", async () => {
    renderProvider();
    await screen.findByText("Vault content for account-owner");
    const deletionInProgress = () =>
      new Response(
        JSON.stringify({
          detail: { code: "AUTH_ACCOUNT_DELETION_IN_PROGRESS" },
        }),
        { status: 423, headers: { "Retry-After": "0" } },
      );
    mocks.apiGetAccountSessionStatus
      .mockResolvedValueOnce(deletionInProgress())
      .mockResolvedValueOnce(deletionInProgress());

    act(() => requestExplicitSessionVerification());

    expect(screen.getByText("Checking session")).toBeInTheDocument();
    await screen.findByText("Verification required");
    expect(mocks.authServiceSignOut).not.toHaveBeenCalled();
    expect(mocks.replaceDocument).not.toHaveBeenCalled();
    expect(mocks.apiGetAccountCleanupStatus).toHaveBeenCalledTimes(1);
    expect(
      screen.queryByText("Vault content for account-owner"),
    ).not.toBeInTheDocument();

    // Rechecking the same sealed recovery must not replace it with startup
    // loading (and reopen a URL-requested Profile between every poll).
    const recheck = deferred<Response>();
    mocks.apiGetAccountSessionStatus.mockReturnValueOnce(recheck.promise);
    fireEvent.click(screen.getByRole("button", { name: "Retry verification" }));
    expect(screen.getByText("Verification required")).toBeInTheDocument();
    expect(screen.queryByText("Checking session")).not.toBeInTheDocument();
    expect(screen.queryByText("Vault content for account-owner")).not.toBeInTheDocument();
    await act(async () => {
      recheck.resolve(activeSessionResponse());
      await recheck.promise;
    });
    expect(await screen.findByText("Vault content for account-owner")).toBeInTheDocument();
    expect(mocks.authServiceSignOut).not.toHaveBeenCalled();
  });

  it("clears a pending deletion handoff when rollback precedes the first owner re-probe", async () => {
    renderProvider();
    await screen.findByText("Vault content for account-owner");
    markAccountDeletionActive("account-owner");
    const owner = snapshotValidatedAuthSessionOwner();
    act(() => window.dispatchEvent(new CustomEvent(AUTH_SESSION_VERIFICATION_REQUIRED_EVENT, {
      detail: { ...owner, reason: "account_deletion_in_progress" },
    })));
    await waitFor(() => expect(isAccountDeletionActive("account-owner")).toBe(false));
    expect(await screen.findByText("Vault content for account-owner")).toBeInTheDocument();
    expect(mocks.authServiceSignOut).not.toHaveBeenCalled();
  });

  it("clears pending deletion after the auth observer withdraws its principal and observes rollback", async () => {
    renderProvider();
    await screen.findByText("Vault content for account-owner");
    mocks.apiGetAccountSessionStatus
      .mockResolvedValueOnce(deletionInProgressResponse())
      .mockResolvedValueOnce(deletionInProgressResponse());
    act(() => mocks.authStateListener?.(mocks.firebaseUser));
    await screen.findByText("Verification required");
    expect(isAccountDeletionActive("account-owner")).toBe(true);
    fireEvent.click(screen.getByText("Retry verification"));
    expect(await screen.findByText("Vault content for account-owner")).toBeInTheDocument();
    expect(isAccountDeletionActive("account-owner")).toBe(false);
    expect(mocks.authServiceSignOut).not.toHaveBeenCalled();
  });

  it.each([false,true])("confirms only the reviewed cleanup while preserving the current owner (switch: %s)", async switchOwner => {
    mocks.apiGetAccountSessionStatus.mockResolvedValueOnce(Response.json(
      { detail: { code: "AUTH_ACCOUNT_DELETION_IN_PROGRESS" } }, { status: 423 },
    ));
    mocks.apiGetAccountCleanupStatus.mockResolvedValueOnce(cleanupStatusResponse("action_required",true));
    render(<AuthProvider><CleanupInterfaceProbe /></AuthProvider>);
    const confirm = await screen.findByRole("button", { name: "Permanently delete account" });
    expect(confirm).toBeDisabled();
    fireEvent.click(screen.getByRole("checkbox", { name: "I agree to finish deleting this account." }));
    const token=deferred<string>();
    vi.mocked((mocks.firebaseUser as User).getIdToken).mockReturnValueOnce(token.promise);
    fireEvent.click(confirm);
    expect(screen.getByText("Confirming…")).toBeDisabled();
    if(switchOwner){
      const nextOwner=makeUser("account-b");
      mocks.firebaseUser=nextOwner;
      act(() => mocks.authStateListener?.(nextOwner));
      await screen.findByText("Vault content for account-b");
    }
    await act(async () => {token.resolve("cleanup-proof");await token.promise;});
    if(switchOwner){
      expect(mocks.apiContinueAccountCleanup).not.toHaveBeenCalled();
      expect(screen.getByText("Vault content for account-b")).toBeInTheDocument();
      expect(mocks.authServiceSignOut).not.toHaveBeenCalled();
    } else {
      await waitFor(() => expect(mocks.apiContinueAccountCleanup).toHaveBeenCalledTimes(1));
      expect(mocks.apiContinueAccountCleanup).toHaveBeenCalledWith(
        "cleanup-proof",expect.objectContaining({inventory_sha256:"a".repeat(64)}),true,expect.any(Function),
      );
      await waitFor(() => expect(mocks.authServiceSignOut).toHaveBeenCalledTimes(1));
      expect(mocks.replaceDocument).toHaveBeenCalledWith("/login?auth_notice=account_deletion_requested");
    }
  });

  it.each(["id", "inventory_sha256"])("requires fresh deletion consent when the cleanup %s changes", async changedField => {
    const operation = {
      id: "b99efb85-c1f2-4714-8a63-614d774a25a3", state: "action_required",
      credential_count: 1, local_erasure_confirmation_required: true,
      external_validity_unconfirmed_count: 1, inventory_sha256: "a".repeat(64),
      retry_after_seconds: null,
    };
    mocks.apiGetAccountSessionStatus.mockImplementation(async () => deletionInProgressResponse());
    mocks.apiGetAccountCleanupStatus.mockImplementation(async () => Response.json({ operation }));
    render(<AuthProvider><CleanupInterfaceProbe /></AuthProvider>);
    const confirm = await screen.findByRole("button", { name: "Permanently delete account" });
    const checkbox = screen.getByRole("checkbox", { name: "I agree to finish deleting this account." });
    fireEvent.click(checkbox);
    expect(confirm).toBeEnabled();

    if (changedField === "id") operation.id = "86f55df8-4527-49e4-81f7-62d9ac3dde7a";
    else operation.inventory_sha256 = "b".repeat(64);
    fireEvent.click(screen.getByRole("button", { name: "Refresh status" }));
    await waitFor(() => expect(checkbox).not.toBeChecked());
    expect(confirm).toBeDisabled();
    fireEvent.click(confirm);
    expect(mocks.apiContinueAccountCleanup).not.toHaveBeenCalled();
    fireEvent.click(checkbox);
    expect(confirm).toBeEnabled();
  });

  it("rejects consent from a previous auth generation before the recovery screen rerenders", async () => {
    mocks.apiGetAccountSessionStatus.mockResolvedValueOnce(deletionInProgressResponse());
    mocks.apiGetAccountCleanupStatus.mockResolvedValueOnce(cleanupStatusResponse("action_required", true));
    render(<AuthProvider><CleanupInterfaceProbe /></AuthProvider>);
    const confirm = await screen.findByRole("button", { name: "Permanently delete account" });
    fireEvent.click(screen.getByRole("checkbox", { name: "I agree to finish deleting this account." }));
    expect(confirm).toBeEnabled();
    const before = snapshotAuthSessionGeneration()?.generation;
    publishPendingAuthSessionIdentity("account-owner", true);
    expect(snapshotAuthSessionGeneration()?.generation).toBeGreaterThan(before ?? -1);
    fireEvent.click(confirm);
    expect(mocks.apiContinueAccountCleanup).not.toHaveBeenCalled();
  });

  it("retries only action-required cleanup through the existing guarded continuation", async () => {
    mocks.apiGetAccountSessionStatus.mockResolvedValueOnce(deletionInProgressResponse());
    mocks.apiGetAccountCleanupStatus.mockResolvedValueOnce(cleanupStatusResponse("action_required"));
    render(<AuthProvider><CleanupInterfaceProbe /></AuthProvider>);
    const retry = await screen.findByRole("button", { name: "Retry cleanup" });
    expect(screen.queryByRole("button", { name: "Permanently delete account" })).toBeNull();
    fireEvent.click(retry);
    await waitFor(() => expect(mocks.apiContinueAccountCleanup).toHaveBeenCalledWith(
      "persisted-token",
      expect.objectContaining({ inventory_sha256: "a".repeat(64), state: "action_required" }),
      false,
      expect.any(Function),
    ));
    expect(mocks.authServiceSignOut).not.toHaveBeenCalled();
  });

  it("keeps older deletion consent on screen when the exact cleanup review is rejected", async () => {
    mocks.apiGetAccountSessionStatus.mockResolvedValueOnce(deletionInProgressResponse());
    mocks.apiGetAccountCleanupStatus.mockResolvedValueOnce(cleanupStatusResponse("action_required", true));
    mocks.apiContinueAccountCleanup.mockResolvedValueOnce(new Response(null, { status: 409 }));
    render(<AuthProvider><CleanupInterfaceProbe /></AuthProvider>);
    const confirm = await screen.findByRole("button", { name: "Permanently delete account" });
    fireEvent.click(screen.getByRole("checkbox", { name: "I agree to finish deleting this account." }));
    fireEvent.click(confirm);
    expect(await screen.findByRole("status")).toHaveTextContent("Refresh status; contact support if it stays paused.");
    expect(confirm).toBeEnabled();
    expect(mocks.authServiceSignOut).not.toHaveBeenCalled();
  });

  it("keeps provider review blocked when the backend refuses a cleanup retry", async () => {
    mocks.apiGetAccountSessionStatus.mockResolvedValueOnce(deletionInProgressResponse());
    mocks.apiGetAccountCleanupStatus.mockResolvedValueOnce(cleanupStatusResponse("action_required"));
    mocks.apiContinueAccountCleanup.mockResolvedValueOnce(new Response(null, { status: 409 }));
    render(<AuthProvider><CleanupInterfaceProbe /></AuthProvider>);
    fireEvent.click(await screen.findByRole("button", { name: "Retry cleanup" }));
    expect(await screen.findByRole("status")).toHaveTextContent("Refresh status; contact support if it stays paused.");
    expect(screen.getByRole("button", { name: "Retry cleanup" })).toBeEnabled();
    expect(mocks.authServiceSignOut).not.toHaveBeenCalled();
  });

  it("confirms a lost deletion response through real transport before the provider clears the session", async () => {
    const { ApiService } = await vi.importActual<typeof import("@/lib/services/api-service")>("@/lib/services/api-service");
    const { AccountService } = await import("@/lib/services/account-service");
    const { executeVerifiedAccountDeletion } = await import("@/lib/flows/delete-account");
    const lostResponse = vi.spyOn(AccountService, "deleteAccount").mockRejectedValueOnce(new TypeError("synthetic lost response"));
    mocks.apiGetAccountDeletionStatus.mockImplementationOnce(ApiService.getAccountDeletionStatus);
    vi.mocked(global.fetch).mockResolvedValueOnce(Response.json({ detail: {
      code: "AUTH_ACCOUNT_NOT_FOUND", account_lifecycle: "deleted",
    } }, { status: 401 }));
    render(<AuthProvider><SessionProbe /></AuthProvider>);
    await screen.findByText("Vault content for account-owner");
    try {
      await act(async () => executeVerifiedAccountDeletion({
        userId: "account-owner", sessionUser: mocks.firebaseUser as User, vaultOwnerToken: "synthetic-vault-token",
      }));
      expect(mocks.apiGetAccountDeletionStatus).toHaveBeenCalledTimes(1);
      expect(mocks.clearForUser).toHaveBeenCalledWith("account-owner", { deleteDurableReceipts: true });
      await waitFor(() => expect(mocks.authServiceSignOut).toHaveBeenCalledTimes(1));
      expect(mocks.replaceDocument).not.toHaveBeenCalledWith("/login?auth_notice=account_deletion_uncertain");
      expect(lostResponse).toHaveBeenCalledTimes(1);
    } finally {
      lostResponse.mockRestore();
    }
  });

  it("retains the deleted notice through real apiFetch before the provider sign-out latch", async () => {
    const { ApiService } = await vi.importActual<typeof import("@/lib/services/api-service")>("@/lib/services/api-service");
    vi.mocked(global.fetch).mockResolvedValueOnce(Response.json({ detail: {
      code: "AUTH_ACCOUNT_NOT_FOUND", account_lifecycle: "deleted",
    } }, { status: 401 }));
    const token = [btoa("{}"), btoa(JSON.stringify({ sub: "account-owner", user_id: "account-owner" })), "synthetic"].join(".");
    vi.mocked((mocks.firebaseUser as User).getIdToken).mockResolvedValue(token);
    mocks.apiGetAccountSessionStatus.mockImplementationOnce(ApiService.getAccountSessionStatus);
    render(<AuthProvider><SessionProbe /></AuthProvider>);
    await waitFor(() => expect(mocks.replaceDocument).toHaveBeenCalledWith("/login?auth_notice=account_deleted"));
    expect(mocks.authServiceSignOut).toHaveBeenCalledTimes(1);
    expect(mocks.replaceDocument).not.toHaveBeenCalledWith("/login?auth_notice=account_not_found");
  });

  it.each(["account_deleted", "account_deletion_identity_retained"] as const)("does not let delayed cleanup replace terminal navigation: %s", async code => {
    render(
      <AuthProvider>
        <ScopedSignOutRaceProbe />
      </AuthProvider>,
    );
    await waitFor(() => {
      expect(mocks.apiGetAccountSessionStatus).toHaveBeenCalledTimes(1);
    });

    act(() => {
      window.dispatchEvent(
        new CustomEvent<AuthSessionInvalidationDetail>(
          AUTH_SESSION_INVALIDATED_EVENT,
          {
            detail: {
              code,
              path: "account_delete_confirmed",
              userId: "account-owner",
            },
          },
        ),
      );
    });
    await waitFor(() => {
      expect(mocks.replaceDocument).toHaveBeenCalledWith(
        `/login?auth_notice=${code}`,
      );
    });

    fireEvent.click(
      screen.getByRole("button", {
        name: "Complete delayed deletion cleanup",
      }),
    );
    await act(async () => Promise.resolve());

    expect(mocks.authServiceSignOut).toHaveBeenCalledTimes(1);
    expect(mocks.apiDeleteSession).toHaveBeenCalledTimes(1);
    expect(mocks.replaceDocument).toHaveBeenCalledTimes(1);
  });

  it("rejects a late terminal event after sign-out until a new UID is established", async () => {
    renderProvider();
    await screen.findByText("Vault content for account-owner");

    act(() => dispatchAccountNotFoundInvalidation());
    await waitFor(() => {
      expect(mocks.replaceDocument).toHaveBeenCalledTimes(1);
    });

    act(() => dispatchAccountNotFoundInvalidation());
    await act(async () => Promise.resolve());
    expect(mocks.authServiceSignOut).toHaveBeenCalledTimes(1);
    expect(mocks.replaceDocument).toHaveBeenCalledTimes(1);

    const nextUser = makeUser("next-account-owner");
    mocks.firebaseUser = nextUser;
    act(() => mocks.authStateListener?.(nextUser));
    expect(
      await screen.findByText("Vault content for next-account-owner"),
    ).toBeInTheDocument();

    act(() => dispatchAccountNotFoundInvalidation());
    await waitFor(() => {
      expect(mocks.authServiceSignOut).toHaveBeenCalledTimes(2);
      expect(mocks.replaceDocument).toHaveBeenCalledTimes(2);
    });
  });

  it("consumes a UID-scoped account-deletion signal from a sibling tab", async () => {
    renderProvider();
    await screen.findByText("Vault content for account-owner");
    const storagePrototype = Object.getPrototypeOf(
      window.localStorage,
    ) as Storage;
    const setItem = vi.spyOn(storagePrototype, "setItem");

    try {
      expect(publishAccountDeletionToSiblingTabs("previous-account")).toBe(
        true,
      );
      const [, stalePayload] = setItem.mock.calls[0]!;
      act(() => {
        window.dispatchEvent(
          new StorageEvent("storage", {
            key: AUTH_SESSION_SIBLING_TAB_STORAGE_KEY,
            newValue: stalePayload,
          }),
        );
      });
      await act(async () => Promise.resolve());
      expect(mocks.authServiceSignOut).not.toHaveBeenCalled();
      expect(mocks.clearDeviceSecretsForDeletedAccount).not.toHaveBeenCalled();

      expect(publishAccountDeletionToSiblingTabs("account-owner")).toBe(true);
      const [, payload] = setItem.mock.calls[1]!;

      act(() => {
        window.dispatchEvent(
          new StorageEvent("storage", {
            key: AUTH_SESSION_SIBLING_TAB_STORAGE_KEY,
            newValue: payload,
          }),
        );
      });

      await waitFor(() => {
        expect(mocks.authServiceSignOut).toHaveBeenCalledTimes(1);
        expect(mocks.replaceDocument).toHaveBeenCalledWith(
          "/login?auth_notice=account_not_found",
        );
      });
      expect(mocks.clearDeviceSecretsForDeletedAccount).toHaveBeenCalledWith(
        "account-owner",
      );
      // account_not_found is broader than a backend-confirmed erasure.
      expect(mocks.clearForUser).not.toHaveBeenCalledWith("account-owner", { deleteDurableReceipts: true });
    } finally {
      setItem.mockRestore();
    }
  });

  it("keeps device key material when the account is not confirmed deleted", async () => {
    renderProvider();
    await screen.findByText("Vault content for account-owner");

    act(() =>
      dispatchInvalidation({
        code: "account_deletion_uncertain",
        path: "test_uncertain",
        userId: "account-owner",
      }),
    );
    act(() =>
      dispatchInvalidation({
        code: "session_invalid",
        path: "test_disabled",
        userId: "account-owner",
      }),
    );
    await act(async () => Promise.resolve());

    expect(mocks.clearDeviceSecretsForDeletedAccount).not.toHaveBeenCalled();
    expect(mocks.clearForUser).not.toHaveBeenCalledWith("account-owner", { deleteDurableReceipts: true });
  });

  it.each(["account_deleted", "account_deletion_identity_retained"] as const)("clears device secrets for confirmed erasure after teardown: %s", async code => {
    renderProvider();
    await screen.findByText("Vault content for account-owner");

    act(() =>
      dispatchInvalidation({
        code: "session_invalid",
        path: "test_first",
        userId: "account-owner",
      }),
    );
    act(() =>
      dispatchInvalidation({
        code,
        path: "account_delete_confirmed",
        userId: "account-owner",
      }),
    );

    expect(mocks.clearDeviceSecretsForDeletedAccount).toHaveBeenCalledTimes(1);
    expect(mocks.clearDeviceSecretsForDeletedAccount).toHaveBeenCalledWith(
      "account-owner",
    );
  });

  it("does not let the initial auth watchdog interrupt a later web validation", async () => {
    vi.useFakeTimers();
    const refresh = deferred<string | null>();
    renderProvider();

    await act(async () => Promise.resolve());
    expect(
      screen.getByText("Vault content for account-owner"),
    ).toBeInTheDocument();
    const currentUser = mocks.firebaseUser as User;
    vi.mocked(currentUser.getIdToken).mockImplementation((forceRefresh) =>
      forceRefresh ? refresh.promise : Promise.resolve("persisted-token"),
    );
    mocks.apiGetAccountSessionStatus.mockResolvedValueOnce(
      new Response(JSON.stringify({ detail: "Invalid Firebase ID token" }), {
        status: 401,
      }),
    );

    act(() => requestExplicitSessionVerification());
    expect(screen.getByText("Checking session")).toBeInTheDocument();

    act(() => vi.advanceTimersByTime(10_001));
    expect(screen.getByText("Checking session")).toBeInTheDocument();

    await act(async () => {
      refresh.resolve("fresh-token");
      await refresh.promise;
    });
    expect(
      screen.getByText("Vault content for account-owner"),
    ).toBeInTheDocument();
  });

  it("preserves the identity but blocks protected UI when foreground validation has a network failure", async () => {
    renderProvider();

    await screen.findByText("Vault content for account-owner");
    mocks.apiGetAccountSessionStatus.mockRejectedValueOnce(
      new TypeError("Failed to fetch"),
    );
    const currentUser = mocks.firebaseUser as User;
    vi.mocked(currentUser.getIdToken).mockImplementation((forceRefresh) =>
      forceRefresh
        ? Promise.reject({
            code: "auth/network-request-failed",
            message: "The network is unavailable.",
          })
        : Promise.resolve("persisted-token"),
    );

    act(() => requestExplicitSessionVerification());

    expect(
      await screen.findByText("Verification required"),
    ).toBeInTheDocument();
    expect(
      screen.queryByText("Vault content for account-owner"),
    ).not.toBeInTheDocument();
    expect(mocks.authServiceSignOut).not.toHaveBeenCalled();
    expect(mocks.replaceDocument).not.toHaveBeenCalled();

    vi.mocked(currentUser.getIdToken).mockResolvedValue("persisted-token");
    fireEvent.click(screen.getByRole("button", { name: "Retry verification" }));
    expect(
      await screen.findByText("Vault content for account-owner"),
    ).toBeInTheDocument();
  });

  it("automatically recovers a fail-closed session after a transient outage", async () => {
    renderProvider();
    await screen.findByText("Vault content for account-owner");
    vi.useFakeTimers();
    mocks.apiGetAccountSessionStatus.mockRejectedValueOnce(
      new TypeError("Failed to fetch"),
    );

    act(() => requestExplicitSessionVerification());
    await act(async () => Promise.resolve());

    expect(screen.getByText("Verification required")).toBeInTheDocument();
    expect(
      screen.queryByText("Vault content for account-owner"),
    ).not.toBeInTheDocument();

    const recheck = deferred<Response>();
    mocks.apiGetAccountSessionStatus.mockReturnValueOnce(recheck.promise);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_000);
    });
    expect(screen.getByText("Verification required")).toBeInTheDocument();
    expect(screen.queryByText("Checking session")).not.toBeInTheDocument();
    await act(async () => { await vi.advanceTimersByTimeAsync(10_001); });
    expect(screen.getByText("Verification required")).toBeInTheDocument();
    expect(screen.queryByText("Checking session")).not.toBeInTheDocument();
    await act(async () => { recheck.resolve(activeSessionResponse()); await recheck.promise; });

    expect(
      screen.getByText("Vault content for account-owner"),
    ).toBeInTheDocument();
    expect(mocks.apiGetAccountSessionStatus).toHaveBeenCalledTimes(3);
    expect(mocks.authServiceSignOut).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: "HTML with a 200 status",
      response: () =>
        new Response("<html>not the account API</html>", {
          status: 200,
          headers: { "Content-Type": "text/html" },
        }),
    },
    {
      name: "an empty JSON object",
      response: () => Response.json({}, { status: 200 }),
    },
    {
      name: "an empty 204 response",
      response: () => new Response(null, { status: 204 }),
    },
    {
      name: "malformed JSON",
      response: () =>
        new Response("{", {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    },
    {
      name: "an oversized JSON body",
      response: () =>
        Response.json(
          { active: true, padding: "x".repeat(4_096) },
          { status: 200 },
        ),
    },
    {
      name: "a missing backend route",
      response: () => Response.json({ detail: "Not Found" }, { status: 404 }),
    },
  ])("keeps protected UI sealed for $name", async ({ response }) => {
    renderProvider();
    await screen.findByText("Vault content for account-owner");
    mocks.apiGetAccountSessionStatus.mockResolvedValueOnce(response());

    act(() => requestExplicitSessionVerification());

    expect(
      await screen.findByText("Verification required"),
    ).toBeInTheDocument();
    expect(
      screen.queryByText("Vault content for account-owner"),
    ).not.toBeInTheDocument();
    expect(mocks.apiGetAccountSessionStatus).toHaveBeenCalledTimes(2);
    expect(mocks.authServiceSignOut).not.toHaveBeenCalled();
  });

  it("keeps account B when a delayed account-A status response becomes terminal", async () => {
    const accountAStatus = deferred<Response>();
    renderProvider();
    await screen.findByText("Vault content for account-owner");

    mocks.apiGetAccountSessionStatus
      .mockReturnValueOnce(accountAStatus.promise)
      .mockResolvedValueOnce(
        activeSessionResponse("account-b"),
      );
    act(() => requestExplicitSessionVerification());
    await waitFor(() => {
      expect(mocks.apiGetAccountSessionStatus).toHaveBeenCalledTimes(2);
    });

    const accountB = makeUser("account-b");
    mocks.firebaseUser = accountB;
    act(() => mocks.authStateListener?.(accountB));
    expect(
      await screen.findByText("Vault content for account-b"),
    ).toBeInTheDocument();

    await act(async () => {
      accountAStatus.resolve(
        new Response(
          JSON.stringify({
            detail: { code: "AUTH_ACCOUNT_NOT_FOUND" },
          }),
          { status: 401 },
        ),
      );
      await accountAStatus.promise;
    });

    expect(screen.getByText("Vault content for account-b")).toBeInTheDocument();
    expect(mocks.authServiceSignOut).not.toHaveBeenCalled();
    expect(mocks.replaceDocument).not.toHaveBeenCalled();
  });

  it("keeps the auth gate closed while account B validation overlaps account A foreground validation", async () => {
    const accountAStatus = deferred<Response>();
    const accountBStatus = deferred<Response>();
    renderProvider();
    await screen.findByText("Vault content for account-owner");

    mocks.apiGetAccountSessionStatus
      .mockReturnValueOnce(accountAStatus.promise)
      .mockReturnValueOnce(accountBStatus.promise);
    act(() => requestExplicitSessionVerification());
    await waitFor(() => {
      expect(mocks.apiGetAccountSessionStatus).toHaveBeenCalledTimes(2);
    });

    const accountB = makeUser("account-b");
    mocks.firebaseUser = accountB;
    act(() => mocks.authStateListener?.(accountB));
    await waitFor(() => {
      expect(mocks.apiGetAccountSessionStatus).toHaveBeenCalledTimes(3);
    });
    expect(screen.getByText("Checking session")).toBeInTheDocument();

    await act(async () => {
      accountAStatus.resolve(
        new Response(
          JSON.stringify({
            detail: { code: "AUTH_ACCOUNT_NOT_FOUND" },
          }),
          { status: 401 },
        ),
      );
      await accountAStatus.promise;
    });

    // Account A's older validation does not own the gate. Releasing it here
    // would briefly reveal A's in-memory Vault while B is still unverified.
    expect(screen.getByText("Checking session")).toBeInTheDocument();
    expect(
      screen.queryByText("Vault content for account-owner"),
    ).not.toBeInTheDocument();
    expect(mocks.authServiceSignOut).not.toHaveBeenCalled();

    await act(async () => {
      accountBStatus.resolve(
        activeSessionResponse(),
      );
      await accountBStatus.promise;
    });

    expect(
      await screen.findByText("Vault content for account-b"),
    ).toBeInTheDocument();
  });

  it("does not let a delayed account-A deletion callback sign out account B", async () => {
    renderProvider();
    await screen.findByText("Vault content for account-owner");

    const accountB = makeUser("account-b");
    mocks.firebaseUser = accountB;
    act(() => mocks.authStateListener?.(accountB));
    await screen.findByText("Vault content for account-b");

    fireEvent.click(
      screen.getByRole("button", {
        name: "Finish account-A deletion",
      }),
    );
    await act(async () => Promise.resolve());

    expect(mocks.authServiceSignOut).not.toHaveBeenCalled();
    expect(mocks.apiDeleteSession).not.toHaveBeenCalled();
    expect(screen.getByText("Vault content for account-b")).toBeInTheDocument();
    expect(mocks.replaceDocument).not.toHaveBeenCalled();
  });

  it("does not republish a latched UID or reopen its vault while sign-out is pending", async () => {
    const signOut = deferred<void>();
    renderProvider();
    await screen.findByText("Vault content for account-owner");
    mocks.authServiceSignOut.mockReturnValueOnce(signOut.promise);

    act(() => dispatchAccountNotFoundInvalidation());
    await waitFor(() => {
      expect(mocks.authServiceSignOut).toHaveBeenCalledTimes(1);
    });
    expect(screen.getByText("Checking session")).toBeInTheDocument();

    act(() => mocks.authStateListener?.(makeUser("account-owner")));
    await act(async () => Promise.resolve());
    expect(screen.getByText("Checking session")).toBeInTheDocument();
    expect(
      screen.queryByText("Vault content for account-owner"),
    ).not.toBeInTheDocument();

    await act(async () => {
      signOut.resolve();
      await signOut.promise;
    });
  });

  it("blocks protected UI for a generic cached-token 401 plus network refresh failure", async () => {
    renderProvider();
    await screen.findByText("Vault content for account-owner");
    mocks.apiGetAccountSessionStatus.mockResolvedValueOnce(
      new Response(JSON.stringify({ detail: "Invalid Firebase ID token" }), {
        status: 401,
      }),
    );
    const currentUser = mocks.firebaseUser as User;
    vi.mocked(currentUser.getIdToken).mockImplementation((forceRefresh) =>
      forceRefresh
        ? Promise.reject({
            code: "auth/network-request-failed",
            message: "offline",
          })
        : Promise.resolve("persisted-token"),
    );

    act(() => requestExplicitSessionVerification());

    expect(
      await screen.findByText("Verification required"),
    ).toBeInTheDocument();
    expect(mocks.authServiceSignOut).not.toHaveBeenCalled();
    expect(mocks.replaceDocument).not.toHaveBeenCalled();
  });

  it("refreshes the candidate user instead of accepting a different global Firebase identity", async () => {
    const accountB = makeUser("account-b");
    vi.mocked(accountB.getIdToken).mockImplementation((forceRefresh) =>
      forceRefresh
        ? Promise.reject({
            code: "auth/user-not-found",
            message: "Account B was deleted.",
          })
        : Promise.resolve("account-b-cached-token"),
    );
    mocks.firebaseUser = accountB;
    mocks.authServiceGetCurrentUser.mockReturnValue(accountB);
    mocks.apiGetAccountSessionStatus.mockResolvedValueOnce(
      new Response(JSON.stringify({ detail: "Invalid Firebase ID token" }), {
        status: 401,
      }),
    );

    renderProvider();

    await waitFor(() => {
      expect(mocks.authServiceSignOut).toHaveBeenCalledTimes(1);
    });
    expect(accountB.getIdToken).toHaveBeenCalledWith(false);
    expect(accountB.getIdToken).toHaveBeenCalledWith(true);
    expect(mocks.authServiceGetIdToken).not.toHaveBeenCalled();
    expect(mocks.clearForUser).toHaveBeenCalledWith("account-b");
    expect(mocks.replaceDocument).toHaveBeenCalledWith(
      "/login?auth_notice=account_not_found",
    );
  });

  it("clears local state for a terminal native restore UID that was never published", async () => {
    mocks.firebaseUser = null;
    mocks.authServiceGetCurrentUser.mockReturnValue(null);
    renderProvider();
    await screen.findByText("Signed out");

    act(() => {
      window.dispatchEvent(
        new CustomEvent<AuthSessionInvalidationDetail>(
          AUTH_SESSION_INVALIDATED_EVENT,
          {
            detail: {
              code: "account_not_found",
              path: "native_restore",
              userId: "cold-restored-deleted-user",
            },
          },
        ),
      );
    });

    await waitFor(() => {
      expect(mocks.clearForUser).toHaveBeenCalledWith(
        "cold-restored-deleted-user",
      );
    });
    expect(mocks.cacheSignedOut).toHaveBeenCalledWith(
      "cold-restored-deleted-user",
    );
    expect(mocks.replaceDocument).toHaveBeenCalledWith(
      "/login?auth_notice=account_not_found",
    );
  });

  it("ignores a UID-scoped sibling deletion signal while anonymous", async () => {
    mocks.firebaseUser = null;
    renderProvider();
    await screen.findByText("Signed out");
    const storagePrototype = Object.getPrototypeOf(
      window.localStorage,
    ) as Storage;
    const setItem = vi.spyOn(storagePrototype, "setItem");

    try {
      expect(publishAccountDeletionToSiblingTabs("account-a")).toBe(true);
      const [, payload] = setItem.mock.calls[0]!;
      act(() => {
        window.dispatchEvent(
          new StorageEvent("storage", {
            key: AUTH_SESSION_SIBLING_TAB_STORAGE_KEY,
            newValue: payload,
          }),
        );
      });
      await act(async () => Promise.resolve());
      expect(mocks.authServiceSignOut).not.toHaveBeenCalled();

      const accountB = makeUser("account-b");
      mocks.firebaseUser = accountB;
      act(() => mocks.authStateListener?.(accountB));
      expect(
        await screen.findByText("Vault content for account-b"),
      ).toBeInTheDocument();
      expect(mocks.authServiceSignOut).not.toHaveBeenCalled();
    } finally {
      setItem.mockRestore();
    }
  });

  it("does not enter recovery for a hung status request that lifecycle cannot start", async () => {
    renderProvider();
    await screen.findByText("Vault content for account-owner");
    vi.useFakeTimers();
    mocks.apiGetAccountSessionStatus.mockClear();
    mocks.apiGetAccountSessionStatus.mockReturnValueOnce(
      new Promise<Response>(() => undefined),
    );

    act(() => {
      emitLifecycle("background");
      emitLifecycle("active");
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(ACCOUNT_SESSION_VALIDATION_BUDGET_MS + 1);
    });
    expect(mocks.apiGetAccountSessionStatus).not.toHaveBeenCalled();
    expect(screen.getByText("Vault content for account-owner")).toBeInTheDocument();
    expect(mocks.authServiceSignOut).not.toHaveBeenCalled();
  });
});
