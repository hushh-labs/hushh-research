// Register the shared provider mocks before importing the provider itself.
import {
  mocks, deferred, makeUser, NativePhoneProbe,
  SessionProbe, activeSessionResponse, resetNativeAuthMocks, cleanupNativeAuthMocks,
} from "./fixtures/auth-context-native-harness";
import { AuthProvider, useAuth } from "@/lib/firebase/auth-context";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PhoneRecoveryService } from "@/lib/services/phone-recovery-service";
import { AccountIdentityService } from "@/lib/services/account-identity-service";
import { snapshotValidatedAuthSessionOwner } from "@/lib/auth/session-owner";
import { useState } from "react";
import { ApiError, apiErrorCode } from "@/lib/services/api-client";

function FinishRecovery({ action }: { action: "transfer" | "delete" }) {
  const { confirmPhoneTransfer, confirmPhoneLinkedDeletion } = useAuth();
  const [outcome, setOutcome] = useState("");
  const finish = async (recheck = false) => {
    try {
      await (action === "transfer" ? confirmPhoneTransfer() : confirmPhoneLinkedDeletion({ operationId: "approved-op", phoneNumber: "+12025550101", readbackOnly: recheck }, () => true));
      setOutcome("verified");
    } catch (error) { setOutcome(apiErrorCode(error) ?? "unconfirmed"); }
  };
  return <>
    <button onClick={() => void finish()}>Finish recovery</button>
    {action === "delete" && <button onClick={() => void finish(true)}>Check deletion again</button>}
    <output aria-label="Recovery outcome">{outcome}</output>
  </>;
}

describe("@feature_auth_reliability @trace_loop native phone verification recovery", () => {
  beforeEach(resetNativeAuthMocks);
  afterEach(() => { cleanupNativeAuthMocks(); vi.restoreAllMocks(); });

  it.each(["transfer", "delete"] as const)("releases the native challenge after approved %s settles", async action => {
    mocks.restoreNativeSession.mockResolvedValue(makeUser());
    mocks.apiGetAccountSessionStatus.mockResolvedValue(activeSessionResponse());
    mocks.phoneConfirm.mockImplementationOnce(async params => {
      params.onConflictProof("verified-conflict-proof");
      throw Object.assign(new Error("Phone held"), { code: "credential-already-in-use" });
    });
    const transfer = vi.fn().mockResolvedValue({ phone_verified: true });
    Object.assign(AccountIdentityService, {
      transferCurrentUserPhone: transfer,
      claimCurrentUserPhone: vi.fn().mockResolvedValue({ phone_verified: true }),
    });
    const deletion = vi.spyOn(PhoneRecoveryService, "confirmLinkedDeletion").mockResolvedValue({ operation_id: "approved-op", state: "admitted" });
    render(<AuthProvider><SessionProbe /><NativePhoneProbe /><FinishRecovery action={action} /></AuthProvider>);
    await waitFor(() => expect(snapshotValidatedAuthSessionOwner()?.userId).toBe("native-account-owner"));
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Start native phone" })); });
    const signal = mocks.phoneStart.mock.calls[0][1].signal as AbortSignal;
    expect(signal.aborted).toBe(false);
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Confirm native phone" })); });
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Finish recovery" })); });
    expect(signal.aborted).toBe(true);
    if (action === "transfer") { expect(transfer).toHaveBeenCalledOnce(); expect(deletion).not.toHaveBeenCalled(); }
    else {
      expect(deletion).toHaveBeenCalledOnce(); expect(transfer).not.toHaveBeenCalled();
      expect(screen.getByLabelText("Recovery outcome")).toHaveTextContent("PHONE_LINKED_CLAIM_REQUIRED");
      expect(AccountIdentityService.claimCurrentUserPhone).not.toHaveBeenCalled();
      expect(mocks.phoneFinalize).not.toHaveBeenCalled();
    }
    deletion.mockRestore();
  });

  it("does not cancel a newer same-owner challenge when an older deletion settles", async () => {
    mocks.restoreNativeSession.mockResolvedValue(makeUser());
    mocks.apiGetAccountSessionStatus.mockResolvedValue(activeSessionResponse());
    mocks.phoneConfirm.mockImplementationOnce(async params => {
      params.onConflictProof("verified-conflict-proof");
      throw Object.assign(new Error("Phone held"), { code: "credential-already-in-use" });
    }).mockResolvedValueOnce({ ...makeUser(), phoneNumber: "+12025550101" });
    const response = deferred<{ operation_id: string; state: "admitted" }>();
    vi.spyOn(PhoneRecoveryService, "confirmLinkedDeletion").mockReturnValue(response.promise);
    render(<AuthProvider><SessionProbe /><NativePhoneProbe /><FinishRecovery action="delete" /></AuthProvider>);
    await waitFor(() => expect(snapshotValidatedAuthSessionOwner()?.userId).toBe("native-account-owner"));
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Start native phone" })); });
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Confirm native phone" })); });
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Finish recovery" })); });
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Start native phone" })); });
    const currentSignal = mocks.phoneStart.mock.calls[1][1].signal as AbortSignal;
    await act(async () => { response.resolve({ operation_id: "approved-op", state: "admitted" }); });
    expect(screen.getByLabelText("Recovery outcome")).toHaveTextContent("unconfirmed");
    expect(currentSignal.aborted).toBe(false);
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Confirm native phone" })); });
    expect(screen.getByTestId("native-phone-status")).toHaveTextContent("verified");
    expect(currentSignal.aborted).toBe(true);
  });

  it("retains an unconfirmed challenge until observation admits the original deletion", async () => {
    mocks.restoreNativeSession.mockResolvedValue(makeUser());
    mocks.apiGetAccountSessionStatus.mockResolvedValue(activeSessionResponse());
    mocks.phoneConfirm.mockImplementationOnce(async params => {
      params.onConflictProof("verified-conflict-proof");
      throw Object.assign(new Error("Phone held"), { code: "credential-already-in-use" });
    });
    const confirm = vi.spyOn(PhoneRecoveryService, "confirmLinkedDeletion").mockRejectedValue(
      new ApiError("unconfirmed", 409, { code: "PHONE_LINKED_DELETION_SUPPORT_REQUIRED" }));
    const observe = vi.spyOn(PhoneRecoveryService, "linkedDeletionStatus").mockResolvedValue({ operation_id: "approved-op", state: "admitted" });
    render(<AuthProvider><SessionProbe /><NativePhoneProbe /><FinishRecovery action="delete" /></AuthProvider>);
    await waitFor(() => expect(snapshotValidatedAuthSessionOwner()?.userId).toBe("native-account-owner"));
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Start native phone" })); });
    const signal = mocks.phoneStart.mock.calls[0][1].signal as AbortSignal;
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Confirm native phone" })); });
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Finish recovery" })); });
    expect(screen.getByLabelText("Recovery outcome")).toHaveTextContent("PHONE_LINKED_DELETION_SUPPORT_REQUIRED");
    expect(signal.aborted).toBe(false);
    expect(observe).not.toHaveBeenCalled();
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Check deletion again" })); });
    expect(screen.getByLabelText("Recovery outcome")).toHaveTextContent("PHONE_LINKED_CLAIM_REQUIRED");
    expect(signal.aborted).toBe(true);
    expect(confirm).toHaveBeenCalledOnce();
    expect(observe).toHaveBeenCalledOnce();
  });

  it.each([false, true])("@feature_auth_reliability @trace_loop cancels the old owner's native start without cancelling a newer attempt: replacement=%s", async replacement => {
    mocks.restoreNativeSession.mockResolvedValue(makeUser());
    mocks.apiGetAccountSessionStatus.mockResolvedValue(activeSessionResponse());
    const oldStart = deferred<{ autoVerified: boolean; verificationId: string }>();
    mocks.phoneStart.mockReturnValueOnce(oldStart.promise);
    const view = render(<AuthProvider><SessionProbe /><NativePhoneProbe /></AuthProvider>);
    await waitFor(() => expect(snapshotValidatedAuthSessionOwner()?.userId).toBe("native-account-owner"));
    const startLabel = replacement ? "Start native replacement" : "Start native phone";
    fireEvent.click(screen.getByRole("button", { name: startLabel }));
    await waitFor(() => expect(mocks.phoneStart).toHaveBeenCalledTimes(1));
    const oldSignal = mocks.phoneStart.mock.calls[0][1].signal as AbortSignal;
    expect(oldSignal.aborted).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "Start account B settlement" }));
    expect(oldSignal.aborted).toBe(true);
    mocks.restoreNativeSession.mockResolvedValue(makeUser("interactive-account-b"));
    mocks.apiGetAccountSessionStatus.mockResolvedValue(activeSessionResponse("interactive-account-b"));
    fireEvent.click(screen.getByRole("button", { name: "Complete account B settlement" }));
    await waitFor(() => expect(snapshotValidatedAuthSessionOwner()?.userId).toBe("interactive-account-b"));
    fireEvent.click(screen.getByRole("button", { name: startLabel }));
    await waitFor(() => expect(mocks.phoneStart).toHaveBeenCalledTimes(2));
    const currentSignal = mocks.phoneStart.mock.calls[1][1].signal as AbortSignal;
    expect(currentSignal.aborted).toBe(false);
    await act(async () => { oldStart.resolve({ autoVerified: false, verificationId: "old-owner-verification" }); });
    expect(currentSignal.aborted).toBe(false);
    expect(snapshotValidatedAuthSessionOwner()?.userId).toBe("interactive-account-b");
    view.unmount();
    expect(currentSignal.aborted).toBe(true);
  });

});
