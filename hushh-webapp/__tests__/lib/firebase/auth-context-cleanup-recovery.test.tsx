import { mocks, deferred, makeUser, cleanupStatusResponse,
  renderProvider, resetWebAuthMocks, cleanupWebAuthMocks } from "./fixtures/auth-context-web-harness";
import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
describe("own cleanup receipt recovery", () => {
  beforeEach(resetWebAuthMocks); afterEach(cleanupWebAuthMocks);
  it("rediscovers durable cleanup after refresh and retains it during a provider outage", async () => {
    const { parseAccountCleanupOperation } = await import("@/lib/auth/account-cleanup-operation");
    expect(parseAccountCleanupOperation((await cleanupStatusResponse().json()).operation)).not.toBeNull();
    mocks.apiGetAccountSessionStatus.mockImplementation(async () => Response.json(
      { detail: { code: "AUTH_ACCOUNT_DELETION_IN_PROGRESS" } }, { status: 423 },
    ));
    mocks.apiGetAccountCleanupStatus.mockResolvedValueOnce(cleanupStatusResponse());
    renderProvider();
    await screen.findByText("Verification required");
    expect(mocks.apiGetAccountCleanupStatus).toHaveBeenCalledTimes(1);
    await screen.findByText("Cleanup: cleaning_up");
    expect(screen.queryByText("Vault content for account-owner")).not.toBeInTheDocument();
    expect(mocks.authServiceSignOut).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText("Retry verification"));
    await screen.findByText("Cleanup: cleaning_up");
    expect(mocks.authServiceSignOut).not.toHaveBeenCalled();
    expect(mocks.clearDeviceSecretsForDeletedAccount).not.toHaveBeenCalled();
  });

  it("refuses a late cleanup response after switching to another owner", async () => {
    const pending = deferred<Response>();
    mocks.apiGetAccountSessionStatus.mockResolvedValueOnce(Response.json(
      { detail: { code: "AUTH_ACCOUNT_DELETION_IN_PROGRESS" } }, { status: 423 },
    ));
    mocks.apiGetAccountCleanupStatus.mockReturnValueOnce(pending.promise);
    renderProvider();
    await waitFor(() => expect(mocks.apiGetAccountCleanupStatus).toHaveBeenCalledTimes(1));
    const nextOwner=makeUser("account-b");
    mocks.firebaseUser=nextOwner;
    act(() => mocks.authStateListener?.(nextOwner));
    await screen.findByText("Vault content for account-b");
    await act(async () => { pending.resolve(cleanupStatusResponse()); await pending.promise; });
    expect(screen.getByText("Vault content for account-b")).toBeInTheDocument();
    expect(screen.queryByText("Cleanup: cleaning_up")).not.toBeInTheDocument();
    expect(mocks.authServiceSignOut).not.toHaveBeenCalled();
  });


  it.each(["complete", "missing", "malformed"] as const)("projects only an authoritative complete receipt after reload: %s", async state => {
    mocks.apiGetAccountSessionStatus.mockResolvedValueOnce(Response.json({detail: {code: "AUTH_ACCOUNT_NOT_FOUND"}}, {status: 401}));
    mocks.apiGetAccountCleanupStatus.mockResolvedValueOnce(state === "complete" ? cleanupStatusResponse("complete") : state === "missing"
      ? new Response(null, {status: 404}) : Response.json({operation: {state: "complete"}}));
    renderProvider();
    await waitFor(() => expect(mocks.replaceDocument).toHaveBeenCalledWith(`/login?auth_notice=${state === "complete" ? "account_deleted" : "account_not_found"}`));
    expect(mocks.apiGetAccountCleanupStatus).toHaveBeenCalledOnce();
    expect(mocks.apiContinueAccountCleanup).not.toHaveBeenCalled();
    expect(mocks.apiStartFreshAccount).not.toHaveBeenCalled();
  });
  it("discards terminal cleanup evidence after another owner signs in", async () => {
    const pending = deferred<Response>();
    mocks.apiGetAccountSessionStatus.mockResolvedValueOnce(Response.json({detail: {code: "AUTH_ACCOUNT_NOT_FOUND"}}, {status: 401}));
    mocks.apiGetAccountCleanupStatus.mockReturnValueOnce(pending.promise);
    renderProvider();
    await waitFor(() => expect(mocks.apiGetAccountCleanupStatus).toHaveBeenCalledOnce());
    const next = makeUser("account-b"); mocks.firebaseUser = next;
    act(() => mocks.authStateListener?.(next)); await screen.findByText("Vault content for account-b");
    await act(async () => {pending.resolve(cleanupStatusResponse("complete")); await pending.promise;});
    expect(screen.getByText("Vault content for account-b")).toBeInTheDocument();
    expect(mocks.authServiceSignOut).not.toHaveBeenCalled(); expect(mocks.replaceDocument).not.toHaveBeenCalled();
  });
});
