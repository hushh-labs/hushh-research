import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { renderPhoneVerificationFlow, reachCodeStep } from "@/__tests__/fixtures/phone-verification-flow";
import { ApiError } from "@/lib/services/api-client";

vi.mock("next/navigation", () => ({ usePathname: () => "/register-phone" }));

function conflict(code: string, phoneProofAvailable = false) {
  return Object.assign(new ApiError("synthetic conflict", 409, { detail: { code } }), { phoneProofAvailable });
}
async function beginOccupiedPhone() {
  const phone = screen.getByRole("textbox", { name: "Phone number" });
  fireEvent.change(phone, { target: { value: "6505550101" } });
  fireEvent.submit(phone.closest("form")!);
  return screen.findByRole("button", { name: "Send a real SMS code" });
}

describe("phone verification explicit transport recovery", () => {
  it("@feature_account_deletion @trace_loop drops the transfer control once this environment refuses moving a number", async () => {
    const transfer = vi.fn().mockRejectedValue(new ApiError("synthetic provider body must stay private", 403,
      { detail: { code: "PHONE_TRANSFER_SHARED_AUTH_UNAVAILABLE" } }));
    const confirm = vi.fn().mockRejectedValue(conflict("PHONE_TRANSFER_CONFIRMATION_REQUIRED", true));
    const flow = renderPhoneVerificationFlow({ confirmVerification: confirm, confirmTransfer: transfer });
    const code = await reachCodeStep(flow.startVerification);
    fireEvent.change(code, { target: { value: "123456" } });
    fireEvent.submit(code.closest("form")!);
    fireEvent.click(await screen.findByRole("button", { name: "Use this number on this account" }));
    fireEvent.click(screen.getByRole("button", { name: "Confirm phone transfer" }));
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("Moving a number isn't available in this environment. Delete your previous account or use a different number."));
    expect(screen.getByRole("alert").textContent).not.toMatch(/retry|SMS|progress|synthetic|recover/i);
    // Back on the choices, only controls that can still change the outcome remain.
    for (const name of ["Use this number on this account", "Confirm phone transfer", "Send a real SMS code", "Check transfer progress"]) {
      expect(screen.queryByRole("button", { name })).toBeNull();
    }
    expect(screen.getByRole("button", { name: "Delete my previous account" })).toBeEnabled();
    expect(transfer).toHaveBeenCalledOnce();
    expect(flow.onCompleted).not.toHaveBeenCalled();
  });

  it.each(["PHONE_TEST_NUMBER_IN_USE", "UAT_PHONE_TEST_INVALID_CODE"])("keeps fixed-code confirmation failure actionable without transfer authority: %s", async errorCode => {
    const start = vi.fn().mockResolvedValue({ autoVerified: false });
    const confirm = vi.fn().mockRejectedValue(new ApiError("synthetic fixed-code failure", errorCode === "PHONE_TEST_NUMBER_IN_USE" ? 409 : 401, { detail: { code: errorCode } }));
    const flow = renderPhoneVerificationFlow({ startVerification: start, confirmVerification: confirm, codePresentation: "onboarding" });
    const phone = screen.getByRole("textbox", { name: "Phone number" });
    fireEvent.change(phone, { target: { value: "6505550101" } });
    fireEvent.submit(phone.closest("form")!);
    const code = await screen.findByRole("textbox", { name: "One-time code" });
    fireEvent.change(code, { target: { value: "123456" } });
    fireEvent.submit(code.closest("form")!);
    if (errorCode === "PHONE_TEST_NUMBER_IN_USE") {
      await screen.findByRole("button", { name: "Send a real SMS code" });
      expect(screen.getByRole("button", { name: "Use this number on this account" })).toBeDisabled();
    } else {
      await screen.findByText("That code isn't right. Check it and try again.");
      expect(code).toHaveValue("123456");
      fireEvent.change(code, { target: { value: "123455" } });
      expect(screen.queryByText("That code isn't right. Check it and try again.")).toBeNull();
    }
    expect(start).toHaveBeenCalledOnce();
    expect(flow.onCompleted).not.toHaveBeenCalled();
  });

  it("requires an explicit fresh SMS after an occupied test number and retains that transport for resend", async () => {
    const start = vi.fn().mockRejectedValueOnce(conflict("PHONE_TEST_NUMBER_IN_USE"))
      .mockResolvedValue({ autoVerified: false });
    const transfer = vi.fn();
    const confirm = vi.fn().mockRejectedValue(conflict("PHONE_TRANSFER_CONFIRMATION_REQUIRED", true));
    renderPhoneVerificationFlow({ startVerification: start, confirmVerification: confirm, confirmTransfer: transfer });
    const freshSms = await beginOccupiedPhone();
    expect(start).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: "Use this number on this account" })).toBeDisabled();
    expect(confirm).not.toHaveBeenCalled();
    fireEvent.click(freshSms);
    const code = await screen.findByRole("textbox", { name: "One-time code" });
    expect(start).toHaveBeenLastCalledWith("+16505550101", { resendCode: false, transport: "sms" });
    expect(transfer).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Resend code" }));
    await waitFor(() => expect(start).toHaveBeenCalledTimes(3));
    expect(start).toHaveBeenLastCalledWith("+16505550101", { resendCode: true, transport: "sms" });
    fireEvent.change(code, { target: { value: "123456" } });
    fireEvent.submit(code.closest("form")!);
    await waitFor(() => expect(screen.getByRole("button", { name: "Use this number on this account" })).toBeEnabled());
    expect(confirm).toHaveBeenCalledOnce();
    expect(transfer).not.toHaveBeenCalled();
  });

  it("keeps transfer disabled when the explicit SMS start fails", async () => {
    const start = vi.fn().mockRejectedValueOnce(conflict("PHONE_TEST_NUMBER_IN_USE"))
      .mockRejectedValue(new ApiError("synthetic provider failure", 503, { detail: { code: "IDENTITY_PROVIDER_UNAVAILABLE" } }));
    const transfer = vi.fn();
    const flow = renderPhoneVerificationFlow({ startVerification: start, confirmTransfer: transfer });
    fireEvent.click(await beginOccupiedPhone());
    await waitFor(() => expect(start).toHaveBeenCalledTimes(2));
    expect(screen.getByRole("button", { name: "Use this number on this account" })).toBeDisabled();
    expect(screen.queryByRole("textbox", { name: "One-time code" })).toBeNull();
    expect(flow.confirmVerification).not.toHaveBeenCalled();
    expect(flow.onCompleted).not.toHaveBeenCalled();
    expect(transfer).not.toHaveBeenCalled();
  });
});

describe("in-place deletion of the account linked to the number", () => {
  const prepared = (transport: "sms" | "configured_test") => vi.fn().mockResolvedValue({
    operation_id: "op-1", state: "prepared", expires_at: "2099-01-01T00:00:00Z", phone_hint: "••01", transport });

  it("keeps the sign-in handoff when the conflict retained no real-SMS proof (test number)", async () => {
    // The server refuses shared test codes for another owner's account, so an in-place review could never succeed.
    const prepare = prepared("sms"); const confirmLinkedDeletion = vi.fn(); const handoff = vi.fn().mockResolvedValue(undefined);
    const flow = renderPhoneVerificationFlow({ startVerification: vi.fn().mockRejectedValue(conflict("PHONE_TEST_NUMBER_IN_USE")),
      prepareLinkedDeletion: prepare, confirmLinkedDeletion, cancelLinkedDeletion: vi.fn(), deletePreviousAccount: handoff });
    await beginOccupiedPhone();
    fireEvent.click(screen.getByRole("button", { name: "Delete my previous account" }));
    await waitFor(() => expect(handoff).toHaveBeenCalledExactlyOnceWith("+16505550101"));
    expect(prepare).not.toHaveBeenCalled(); expect(confirmLinkedDeletion).not.toHaveBeenCalled(); expect(flow.onCompleted).not.toHaveBeenCalled();
  });

  it("cancels from the review, and an unconfirmed deletion offers Check again without trapping Back", async () => {
    const cancel = vi.fn().mockResolvedValue({});
    const confirmLinkedDeletion = vi.fn().mockRejectedValue(new ApiError("unknown outcome", 409, { code: "PHONE_LINKED_DELETION_SUPPORT_REQUIRED" }));
    const flow = renderPhoneVerificationFlow({ confirmVerification: vi.fn().mockRejectedValue(conflict("PHONE_TRANSFER_CONFIRMATION_REQUIRED", true)),
      prepareLinkedDeletion: prepared("sms"), confirmLinkedDeletion, cancelLinkedDeletion: cancel });
    const code = await reachCodeStep(flow.startVerification);
    fireEvent.change(code, { target: { value: "123456" } });
    fireEvent.submit(code.closest("form")!);
    fireEvent.click(await screen.findByRole("button", { name: "Delete my previous account" }));
    await screen.findByRole("heading", { name: "Delete the account linked to ••01?" });
    expect(screen.queryByRole("textbox", { name: "Verification code" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await screen.findByRole("heading", { name: "This number is linked to another account" });
    expect(cancel).toHaveBeenCalledExactlyOnceWith("op-1");
    fireEvent.click(screen.getByRole("button", { name: "Delete my previous account" }));
    fireEvent.click(await screen.findByRole("checkbox", { name: "I understand this can’t be undone." }));
    fireEvent.click(screen.getByRole("button", { name: "Delete and continue" }));
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("We couldn’t confirm the deletion. Check again, or contact one@hushh.ai."));
    fireEvent.click(screen.getByRole("button", { name: "Check again" }));
    await waitFor(() => expect(confirmLinkedDeletion).toHaveBeenCalledTimes(2));
    // Re-reading the same operation is safe: the server never dispatches it twice.
    expect(confirmLinkedDeletion).toHaveBeenLastCalledWith({ operationId: "op-1", phoneNumber: "+16505550101", testCode: undefined });
    // A sent confirmation cannot be cancelled: the exit is a new verification, never the spent choices.
    expect(screen.queryByRole("button", { name: "Cancel" })).toBeNull();
    fireEvent.click(await screen.findByRole("button", { name: "Verify this number again" }));
    expect(await screen.findByRole("textbox", { name: "Phone number" })).toBeVisible();
    expect(screen.queryByRole("button", { name: "Delete my previous account" })).toBeNull();
    expect(flow.onCompleted).not.toHaveBeenCalled();
  });

  it.each([
    ["requested", new ApiError("Deletion requested.", 409, { code: "PHONE_LINKED_CLAIM_REQUIRED" }), "Deletion requested"],
    ["unconfirmed", new ApiError("unknown outcome", 409, { code: "PHONE_LINKED_DELETION_SUPPORT_REQUIRED" }), null],
  ])("route Back after a %s confirmation leads to number entry instead of the choices", async (_label, outcome, heading) => {
    const back: { current: (() => boolean) | null } = { current: null };
    const confirmLinkedDeletion = vi.fn().mockRejectedValue(outcome);
    const flow = renderPhoneVerificationFlow({ confirmVerification: vi.fn().mockRejectedValue(conflict("PHONE_TRANSFER_CONFIRMATION_REQUIRED", true)),
      prepareLinkedDeletion: prepared("sms"), confirmLinkedDeletion, cancelLinkedDeletion: vi.fn().mockResolvedValue({}),
      onBackStepChange: handler => { back.current = handler; } });
    const code = await reachCodeStep(flow.startVerification);
    fireEvent.change(code, { target: { value: "123456" } });
    fireEvent.submit(code.closest("form")!);
    fireEvent.click(await screen.findByRole("button", { name: "Delete my previous account" }));
    fireEvent.click(await screen.findByRole("checkbox", { name: "I understand this can’t be undone." }));
    fireEvent.click(screen.getByRole("button", { name: "Delete and continue" }));
    if (heading) await screen.findByRole("heading", { name: heading });
    else await screen.findByRole("button", { name: "Check again" });
    expect(screen.queryByRole("button", { name: "Cancel" })).toBeNull();
    act(() => { expect(back.current?.()).toBe(true); });
    expect(await screen.findByRole("textbox", { name: "Phone number" })).toBeVisible();
    expect(screen.queryByRole("button", { name: "Delete my previous account" })).toBeNull();
    expect(confirmLinkedDeletion).toHaveBeenCalledOnce(); expect(flow.onCompleted).not.toHaveBeenCalled();
  });

  it.each(["PHONE_LINKED_PROOF_REQUIRED", "ACCOUNT_DELETION_PAUSED", "PHONE_LINKED_CLAIM_REQUIRED"])("sends a spent operation (%s) back to number verification instead of retrying it", async refusal => {
    const confirmLinkedDeletion = vi.fn().mockRejectedValue(new ApiError("spent", 409, { code: refusal }));
    const flow = renderPhoneVerificationFlow({ confirmVerification: vi.fn().mockRejectedValue(conflict("PHONE_TRANSFER_CONFIRMATION_REQUIRED", true)),
      prepareLinkedDeletion: prepared("sms"), confirmLinkedDeletion, cancelLinkedDeletion: vi.fn() });
    const code = await reachCodeStep(flow.startVerification);
    fireEvent.change(code, { target: { value: "123456" } });
    fireEvent.submit(code.closest("form")!);
    fireEvent.click(await screen.findByRole("button", { name: "Delete my previous account" }));
    fireEvent.click(await screen.findByRole("checkbox", { name: "I understand this can’t be undone." }));
    fireEvent.click(screen.getByRole("button", { name: "Delete and continue" }));
    fireEvent.click(await screen.findByRole("button", { name: "Verify this number again" }));
    expect(await screen.findByRole("textbox", { name: "Phone number" })).toBeVisible();
    expect(confirmLinkedDeletion).toHaveBeenCalledOnce();
  });
});
