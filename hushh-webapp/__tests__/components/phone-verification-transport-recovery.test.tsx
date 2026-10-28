import { fireEvent, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { renderPhoneVerificationFlow, reachCodeStep } from "@/__tests__/fixtures/phone-verification-flow";
import { ApiError } from "@/lib/services/api-client";

vi.mock("next/navigation", () => ({ usePathname: () => "/register-phone" }));

function conflict(code: string) {
  return new ApiError("synthetic conflict", 409, { detail: { code } });
}
async function beginOccupiedPhone() {
  const phone = screen.getByRole("textbox", { name: "Phone number" });
  fireEvent.change(phone, { target: { value: "6505550101" } });
  fireEvent.submit(phone.closest("form")!);
  return screen.findByRole("button", { name: "Send a real SMS code" });
}

describe("phone verification explicit transport recovery", () => {
  it("shows shared-auth transfer unavailability with account recovery instead of retry advice", async () => {
    const transfer = vi.fn().mockRejectedValue(new ApiError("synthetic provider body must stay private", 403,
      { detail: { code: "PHONE_TRANSFER_SHARED_AUTH_UNAVAILABLE" } }));
    const confirm = vi.fn().mockRejectedValue(conflict("PHONE_TRANSFER_CONFIRMATION_REQUIRED"));
    const flow = renderPhoneVerificationFlow({ confirmVerification: confirm, confirmTransfer: transfer });
    const code = await reachCodeStep(flow.startVerification);
    fireEvent.change(code, { target: { value: "123456" } });
    fireEvent.submit(code.closest("form")!);
    fireEvent.click(await screen.findByRole("button", { name: "Use this number on this account" }));
    fireEvent.click(screen.getByRole("button", { name: "Confirm phone transfer" }));
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("Phone transfer is unavailable in this environment. Recover your previous account or use another number."));
    expect(screen.getByRole("alert").textContent).not.toMatch(/retry|SMS|progress|synthetic/i);
    expect(screen.queryByRole("button", { name: "Check transfer progress" })).toBeNull();
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
    const confirm = vi.fn().mockRejectedValue(conflict("PHONE_TRANSFER_CONFIRMATION_REQUIRED"));
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

  it("deletes with the fixture code only after explicit acknowledgement, then continues", async () => {
    const verified = { uid: "user_1" };
    const prepare = prepared("configured_test");
    const confirmLinkedDeletion = vi.fn().mockResolvedValue(verified);
    const flow = renderPhoneVerificationFlow({ startVerification: vi.fn().mockRejectedValue(conflict("PHONE_TEST_NUMBER_IN_USE")),
      prepareLinkedDeletion: prepare, confirmLinkedDeletion, cancelLinkedDeletion: vi.fn() });
    await beginOccupiedPhone();
    fireEvent.click(screen.getByRole("button", { name: "Delete my previous account" }));
    await screen.findByRole("heading", { name: "Delete the account linked to ••01?" });
    expect(prepare).toHaveBeenCalledWith("+16505550101");
    fireEvent.change(screen.getByRole("textbox", { name: "Verification code" }), { target: { value: "123456" } });
    const remove = screen.getByRole("button", { name: "Delete and continue" });
    expect(remove).toBeDisabled();
    fireEvent.click(screen.getByRole("checkbox", { name: "I understand this can’t be undone." }));
    fireEvent.click(remove);
    await waitFor(() => expect(flow.onCompleted).toHaveBeenCalledWith(verified));
    expect(confirmLinkedDeletion).toHaveBeenCalledExactlyOnceWith({ operationId: "op-1", phoneNumber: "+16505550101", testCode: "123456" });
  });

  it("cancels from the review, and an unconfirmed deletion offers Check again without trapping Back", async () => {
    const cancel = vi.fn().mockResolvedValue({});
    const confirmLinkedDeletion = vi.fn().mockRejectedValue(new ApiError("unknown outcome", 409, { code: "PHONE_LINKED_DELETION_SUPPORT_REQUIRED" }));
    const flow = renderPhoneVerificationFlow({ confirmVerification: vi.fn().mockRejectedValue(conflict("PHONE_TRANSFER_CONFIRMATION_REQUIRED")),
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
    fireEvent.click(await screen.findByRole("button", { name: "Cancel" }));
    await screen.findByRole("heading", { name: "This number is linked to another account" });
    expect(flow.onCompleted).not.toHaveBeenCalled();
  });

  it.each(["PHONE_LINKED_PROOF_REQUIRED", "ACCOUNT_DELETION_PAUSED"])("sends a spent operation (%s) back to number verification instead of retrying it", async refusal => {
    const confirmLinkedDeletion = vi.fn().mockRejectedValue(new ApiError("spent", 409, { code: refusal }));
    const flow = renderPhoneVerificationFlow({ confirmVerification: vi.fn().mockRejectedValue(conflict("PHONE_TRANSFER_CONFIRMATION_REQUIRED")),
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
