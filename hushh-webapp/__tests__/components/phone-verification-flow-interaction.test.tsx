import { renderPhoneVerificationFlow, reachCodeStep, selectCountryOnce, selectIndiaOnce } from "@/__tests__/fixtures/phone-verification-flow";
import {
  act,
  fireEvent,
  renderHook,
  screen,
  waitFor,
} from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Capacitor } from "@capacitor/core";

beforeEach(() => { vi.spyOn(Capacitor, "isNativePlatform").mockReturnValue(false); });

import { usePhoneVerificationFlow } from "@/components/auth/phone-verification-flow";
import { ApiError } from "@/lib/services/api-client";
import { resolveLocalOnboardingHandler } from "@/lib/agent/local-onboarding-actions";
import { getVoiceSurfaceMetadata } from "@/lib/kai/actions/voice-surface-metadata";

vi.mock("next/navigation", () => ({
  usePathname: () => "/register-phone",
}));

describe("PhoneVerificationFlow country selector", () => {
  it.each(["send", "confirm"])("does not navigate from a %s completion after its phone destination retires", async path => {
    let finish!: (value: unknown) => void;
    const pending = new Promise(resolve => { finish = resolve; });
    const start = vi.fn().mockReturnValue(path === "send" ? pending : Promise.resolve({ autoVerified: false }));
    const confirm = vi.fn().mockReturnValue(pending);
    const flow = renderPhoneVerificationFlow({ startVerification: start, confirmVerification: confirm });
    const input = screen.getByRole("textbox", { name: "Phone number" });
    fireEvent.change(input, { target: { value: "6505550101" } });
    fireEvent.submit(input.closest("form")!);
    if (path === "confirm") {
      const code = await screen.findByRole("textbox", { name: "One-time code" });
      fireEvent.change(code, { target: { value: "123456" } });
      fireEvent.submit(code.closest("form")!);
      expect(confirm).toHaveBeenCalledOnce();
    }
    flow.unmount();
    await act(async () => { finish(path === "send" ? { autoVerified: true, user: { uid: "user_1" } } : { uid: "user_1" }); });
    expect(flow.onCompleted).not.toHaveBeenCalled();
    expect(start).toHaveBeenCalledOnce();
  });

  it("rejects a retained verification callback after OTP Back and a retired owner before provider dispatch", async () => {
    let ownerCurrent = true;
    const start = vi.fn().mockResolvedValue({ autoVerified: false });
    const confirm = vi.fn();
    const { result } = renderHook(() => usePhoneVerificationFlow({ mode: "replace", currentPhoneNumber: "+16505550101",
      startVerification: start, confirmVerification: confirm, onCompleted: vi.fn(), isCurrent: () => ownerCurrent }));
    await act(async () => { await result.current.handleStartVerification(false, "+16505550102"); });
    const retainedConfirm = result.current.submitVerificationCode;
    act(() => { result.current.returnToPhoneNumber(); });
    await act(async () => { await retainedConfirm("123456", { notify: false }); });
    expect(confirm).not.toHaveBeenCalled();
    ownerCurrent = false;
    await act(async () => { await result.current.handleStartVerification(); });
    expect(start).toHaveBeenCalledOnce();
  });

  it("does not repeat committed verification when Account refresh fails", async () => {
    const confirm = vi.fn().mockResolvedValue({ uid: "user_1" });
    let failCompletion!: (error: Error) => void;
    const pendingCompletion = new Promise<void>((_resolve, reject) => { failCompletion = reject; });
    const completed = vi.fn().mockReturnValueOnce(pendingCompletion).mockResolvedValue(undefined);
    const start = vi.fn().mockResolvedValue({ autoVerified: false });
    const { result, rerender } = renderHook(({ phone }) => usePhoneVerificationFlow({ mode: "replace", currentPhoneNumber: phone,
      startVerification: start, confirmVerification: confirm, onCompleted: completed }), { initialProps: { phone: "+16505550101" } });
    await act(async () => { await result.current.handleStartVerification(false, "+16505550102"); });
    let verification!: Promise<unknown>;
    act(() => { verification = result.current.submitVerificationCode("123456", { notify: false }); });
    await waitFor(() => expect(completed).toHaveBeenCalledOnce());
    rerender({ phone: "+16505550102" });
    await act(async () => { failCompletion(new Error("private provider response must not appear")); expect(await verification).toBe("verified"); });
    expect(result.current.step).toBe("linked");
    expect(result.current.verificationCode).toBe("");
    expect(result.current.operationError).toContain("Phone verified. Couldn’t refresh Account.");
    expect(result.current.operationError).not.toContain("provider response");
    await act(async () => { await result.current.submitVerificationCode("123456", { notify: false }); });
    expect(confirm).toHaveBeenCalledOnce();
    await act(async () => { await result.current.handleContinueExisting(); });
    expect(completed).toHaveBeenCalledTimes(2);
    expect(start).toHaveBeenCalledOnce();
    expect(confirm).toHaveBeenCalledOnce();
  });

  it("lets an international native paste outrank the picker without changing its recipient", async () => {
    const start = vi.fn().mockResolvedValue({ autoVerified: false });
    const { result } = renderHook(() => usePhoneVerificationFlow({ mode: "replace", currentPhoneNumber: "+16505550101",
      startVerification: start, confirmVerification: vi.fn(), onCompleted: vi.fn() }));
    act(() => { result.current.handlePhoneNumberChange("+916505550101", "US"); });
    expect(result.current.selectedCountry).toBe("IN");
    await act(async () => { await result.current.handleStartVerification(); });
    expect(start).toHaveBeenCalledWith("+916505550101", { resendCode: false });
    act(() => { result.current.returnToPhoneNumber(); });
    const staleSend = result.current.handleStartVerification;
    act(() => { expect(result.current.handlePhoneNumberChange("650555010199", "US")).toBe(false); });
    await act(async () => { await staleSend(); });
    expect(start).toHaveBeenCalledOnce();
    act(() => { result.current.handlePhoneNumberChange("6505550102", "US"); });
    await act(async () => { await result.current.handleStartVerification(); });
    expect(start).toHaveBeenLastCalledWith("+16505550102", { resendCode: false });
  });

  it("keeps the pending attempt when its same owner publishes the newly verified phone", async () => {
    let finish!: (value: { uid: string }) => void;
    const pending = new Promise<{ uid: string }>(resolve => { finish = resolve; });
    const completed = vi.fn(), confirm = vi.fn().mockReturnValue(pending), start = vi.fn().mockResolvedValue({ autoVerified: false });
    const { result, rerender } = renderHook(({ phone }: { phone: string | null }) => usePhoneVerificationFlow({ ownerKey: "same-visit",
      mode: phone ? "replace" : "link", currentPhoneNumber: phone, startVerification: start, confirmVerification: confirm, onCompleted: completed }),
    { initialProps: { phone: null } });
    await act(async () => { await result.current.handleStartVerification(false, "+16505550102"); });
    let verification!: Promise<unknown>;
    act(() => { verification = result.current.submitVerificationCode("123456", { notify: false }); });
    rerender({ phone: "+16505550102" });
    await act(async () => { finish({ uid: "user_1" }); await verification; });
    expect(completed).toHaveBeenCalledOnce();
    expect(result.current.busy).toBe(false);
    expect(result.current.step).toBe("linked");
    expect(confirm).toHaveBeenCalledOnce();
  });

  it("does not let a retired request unlock a new owner's pending phone operation", async () => {
    let resolveOld!: (value: { autoVerified: boolean }) => void;
    const old = new Promise<{ autoVerified: boolean }>(resolve => { resolveOld = resolve; });
    const start = vi.fn().mockReturnValueOnce(old).mockReturnValue(new Promise(() => undefined));
    const completed = vi.fn();
    const { result, rerender } = renderHook(({ owner }) => usePhoneVerificationFlow({ ownerKey: owner, mode: "replace",
      currentPhoneNumber: "+16505550101", startVerification: start, confirmVerification: vi.fn(), onCompleted: completed }),
    { initialProps: { owner: "first-visit" } });
    let first!: Promise<unknown>;
    act(() => { first = result.current.handleStartVerification(false, "+16505550102"); });
    rerender({ owner: "second-visit" });
    act(() => { void result.current.handleStartVerification(false, "+16505550103"); });
    expect(start).toHaveBeenCalledTimes(2);
    await act(async () => { resolveOld({ autoVerified: true }); await first; });
    expect(result.current.busy).toBe(true);
    await act(async () => { await result.current.handleStartVerification(false, "+16505550104"); });
    expect(start).toHaveBeenCalledTimes(2);
    expect(completed).not.toHaveBeenCalled();
  });

  it.each(["linked", "same-number"])("requires retryable native synchronization before %s completion", async (path) => {
    vi.mocked(Capacitor.isNativePlatform).mockReturnValue(true);
    let reject!: (error: Error) => void;
    const pending = new Promise<{ autoVerified: boolean }>((_resolve, rejectPromise) => { reject = rejectPromise; });
    const start = vi.fn().mockReturnValueOnce(pending).mockResolvedValue({ autoVerified: true });
    const continueExisting = vi.fn();
    const handle = renderPhoneVerificationFlow({ mode: path === "linked" ? "link" : "replace", currentPhoneNumber: "+16505550101", startVerification: start, onContinueExisting: continueExisting });
    const action = screen.getByRole("button", { name: path === "linked" ? "Continue" : "Send verification code" });
    fireEvent.click(action);
    fireEvent.click(action);
    expect(start).toHaveBeenCalledTimes(1);
    expect(continueExisting).not.toHaveBeenCalled();
    expect(handle.onCompleted).not.toHaveBeenCalled();
    await act(async () => { reject(new Error("persistence unavailable")); });
    await waitFor(() => expect(action).toBeEnabled());
    expect(continueExisting).not.toHaveBeenCalled();
    expect(handle.onCompleted).not.toHaveBeenCalled();
    fireEvent.click(action);
    await waitFor(() => expect(path === "linked" ? continueExisting : handle.onCompleted).toHaveBeenCalledOnce());
    expect(start).toHaveBeenCalledTimes(2);
    expect(handle.confirmVerification).not.toHaveBeenCalled();
  });

  it.each(["linked", "same-number"])("retains the existing web %s completion without another OTP", async (path) => {
    const continueExisting = vi.fn();
    const handle = renderPhoneVerificationFlow({ mode: path === "linked" ? "link" : "replace", currentPhoneNumber: "+16505550101", onContinueExisting: continueExisting });
    fireEvent.click(screen.getByRole("button", { name: path === "linked" ? "Continue" : "Send verification code" }));
    await waitFor(() => expect(path === "linked" ? continueExisting : handle.onCompleted).toHaveBeenCalledOnce());
    expect(handle.startVerification).not.toHaveBeenCalled();
    expect(handle.confirmVerification).not.toHaveBeenCalled();
  });

  it("validates compact entry only after Continue, retains errors until corrected, and never sends invalid input", async () => {
    const { startVerification } = renderPhoneVerificationFlow({ phonePresentation: "compact" });
    const input = screen.getByRole("textbox", { name: "Phone number" });
    const submit = screen.getByRole("button", { name: "Send verification code" });
    expect(screen.queryByRole("alert")).toBeNull();
    fireEvent.click(submit);
    expect(screen.getByRole("alert")).toHaveTextContent("Enter your phone number.");
    expect(startVerification).not.toHaveBeenCalled();
    fireEvent.change(input, { target: { value: "123" } });
    fireEvent.click(submit);
    expect(screen.getByRole("alert")).toHaveTextContent("Enter a valid phone number.");
    expect(startVerification).not.toHaveBeenCalled();
    fireEvent.change(input, { target: { value: "6505550101" } });
    expect(screen.queryByRole("alert")).toBeNull();
    expect(input).toHaveAttribute("aria-invalid", "false");
    expect(startVerification).not.toHaveBeenCalled();
    fireEvent.click(submit);
    await waitFor(() => expect(startVerification).toHaveBeenCalledTimes(1));
    expect(startVerification).toHaveBeenCalledWith("+16505550101", { resendCode: false });
  });

  it("does not send the previous valid recipient after rejecting an oversized compact paste", async () => {
    const { startVerification } = renderPhoneVerificationFlow({ phonePresentation: "compact" });
    const input = screen.getByRole("textbox", { name: "Phone number" }) as HTMLInputElement;
    fireEvent.change(input, { target: { value: "6505550101" } });
    input.setSelectionRange(0, input.value.length);
    fireEvent.paste(input, { clipboardData: { getData: () => "650555010199" } });
    expect(screen.queryByRole("alert")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Send verification code" }));
    expect(screen.getByRole("alert")).toHaveTextContent("Enter a valid phone number.");
    expect(startVerification).not.toHaveBeenCalled();
    fireEvent.change(input, { target: { value: "+16505550101" } });
    fireEvent.click(screen.getByRole("button", { name: "Send verification code" }));
    await waitFor(() => expect(startVerification).toHaveBeenCalledWith("+16505550101", { resendCode: false }));
    expect(startVerification).toHaveBeenCalledOnce();
  });

  it("can resend after a valid voice replacement of rejected compact input", async () => {
    const { startVerification } = renderPhoneVerificationFlow({ phonePresentation: "compact" });
    const input = screen.getByRole("textbox", { name: "Phone number" }) as HTMLInputElement;
    fireEvent.change(input, { target: { value: "6505550101" } });
    input.setSelectionRange(0, input.value.length);
    fireEvent.paste(input, { clipboardData: { getData: () => "650555010199" } });
    await act(async () => {
      await resolveLocalOnboardingHandler("phone_mandate.submit_number")?.({
        phoneNumber: "+16505550102",
      });
    });
    await screen.findByRole("textbox", { name: "One-time code" });
    expect(startVerification).toHaveBeenCalledWith("+16505550102", { resendCode: false });
    fireEvent.click(screen.getByRole("button", { name: "Resend code" }));
    await waitFor(() => expect(startVerification).toHaveBeenCalledTimes(2));
    expect(startVerification).toHaveBeenLastCalledWith("+16505550102", { resendCode: true });
  });

  it("filters country choices from typed names and dial codes", async () => {
    renderPhoneVerificationFlow();
    const countryInput = screen.getByRole("combobox", {
      name: "Country code",
    });

    fireEvent.focus(countryInput);
    fireEvent.change(countryInput, { target: { value: "India" } });
    expect(await screen.findByText("India")).toBeTruthy();
    expect(screen.queryByText("France")).toBeNull();

    fireEvent.change(countryInput, { target: { value: "+33" } });
    expect(await screen.findByText("France")).toBeTruthy();
    expect(screen.queryByText("India")).toBeNull();
  });

  it("keeps dial codes on the same foreground as each option state", async () => {
    renderPhoneVerificationFlow();
    const countryInput = screen.getByRole("combobox", {
      name: "Country code",
    });

    fireEvent.focus(countryInput);

    const indiaLabel = await screen.findByText("India");
    const indiaItem = indiaLabel.closest("[data-slot='combobox-item']");
    expect(indiaItem).not.toBeNull();
    expect(indiaItem?.className).toContain(
      "data-highlighted:text-accent-foreground",
    );

    const dialCode = Array.from(indiaItem?.querySelectorAll("span") ?? []).find(
      (element) => element.textContent === "+91",
    );
    expect(dialCode?.className).toContain("text-current");
    expect(dialCode?.className).not.toContain("text-muted-foreground");
  });

  it("shows an honest empty state for an unmatched country query", async () => {
    renderPhoneVerificationFlow();
    const countryInput = screen.getByRole("combobox", {
      name: "Country code",
    });

    fireEvent.focus(countryInput);
    fireEvent.change(countryInput, { target: { value: "not-a-country" } });

    expect(await screen.findByText("No country codes found.")).toBeTruthy();
  });

  it.each([
    ["United States", "US", "+1"],
    ["United Kingdom", "GB", "+44"],
    ["India", "IN", "+91"],
    ["Angola", "AO", "+244"],
    ["Brazil", "BR", "+55"],
  ])("keeps compact country selection synchronized for %s", async (name, iso, code) => {
    renderPhoneVerificationFlow({ phonePresentation: "compact" });
    const phone = screen.getByRole("textbox", { name: "Phone number" });
    fireEvent.change(phone, { target: { value: "12345" } });
    fireEvent.click(screen.getByRole("button", { name: /^Country code:/ }));
    const search = await screen.findByRole("searchbox", { name: "Search countries" });
    fireEvent.change(search, { target: { value: name } });
    fireEvent.click(screen.getByRole("option", { name: `${name} (${code})`, exact: true }));
    await waitFor(() => expect(screen.queryByRole("listbox", { name: "Country codes" })).toBeNull());
    expect(screen.getByRole("button", { name: `Country code: ${name} (${code})` })).toBeTruthy();
    expect(screen.getByRole("button", { name: `Country code: ${name} (${code})` }).textContent).toContain(`${iso} ${code}`);
    expect((phone as HTMLInputElement).value).toBe("12345");
  });

  it("cancels the compact picker without changing the selected country", async () => {
    renderPhoneVerificationFlow({ phonePresentation: "compact" });
    const trigger = screen.getByRole("button", { name: /^Country code:/ });
    const before = trigger.getAttribute("aria-label");
    fireEvent.click(trigger);
    fireEvent.change(await screen.findByRole("searchbox"), { target: { value: "Brazil" } });
    fireEvent.keyDown(screen.getByRole("searchbox"), { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("listbox", { name: "Country codes" })).toBeNull());
    expect(trigger.getAttribute("aria-label")).toBe(before);
  });

  it("shows India immediately after the first country selection", async () => {
    renderPhoneVerificationFlow();

    await selectIndiaOnce();
  });

  it("keeps the flag, country name, and dialing code synchronized", async () => {
    renderPhoneVerificationFlow();

    const countries = [
      { name: "United States", label: "United States (+1)", flag: "🇺🇸" },
      { name: "United Kingdom", label: "United Kingdom (+44)", flag: "🇬🇧" },
      { name: "India", label: "India (+91)", flag: "🇮🇳" },
      { name: "Angola", label: "Angola (+244)", flag: "🇦🇴" },
      { name: "Brazil", label: "Brazil (+55)", flag: "🇧🇷" },
    ];

    for (const [index, country] of countries.entries()) {
      const countryInput = await selectCountryOnce(country.name, country.label);
      expect(countryInput.value).toBe(country.label);
      expect(screen.getByText(country.flag)).toBeTruthy();
      if (index > 0) {
        expect(screen.queryByText(countries[index - 1]!.flag)).toBeNull();
      }
    }
  });

  it("publishes bounded country options and restores the phone surface after close", async () => {
    renderPhoneVerificationFlow();
    const countryInput = screen.getByRole("combobox", {
      name: "Country code",
    }) as HTMLInputElement;
    fireEvent.focus(countryInput);

    await waitFor(() => {
      expect(getVoiceSurfaceMetadata()?.interactionLayer).toMatchObject({
        id: "phone_country_picker",
        kind: "country_picker",
        agentContinuity: "interactive",
      });
      expect(
        getVoiceSurfaceMetadata()?.interactionLayer?.options.length,
      ).toBeLessThanOrEqual(10);
    });

    const selectCountry = resolveLocalOnboardingHandler(
      "phone_mandate.select_country",
    );
    let selectionResult;
    await act(async () => {
      selectionResult = await selectCountry?.({ country: "IN" });
    });
    expect(selectionResult).toMatchObject({ status: "succeeded" });
    await waitFor(() => expect(countryInput.value).toBe("India (+91)"));

    fireEvent.focus(countryInput);
    const closePicker = resolveLocalOnboardingHandler(
      "phone_mandate.close_country_picker",
    );
    let closeResult;
    await act(async () => {
      closeResult = await closePicker?.({});
    });
    expect(closeResult).toMatchObject({ status: "succeeded" });
    await waitFor(() => {
      expect(getVoiceSurfaceMetadata()?.interactionLayer ?? null).toBeNull();
    });
  });

  it("uses the first selected country when sending the verification phone number", async () => {
    const { startVerification } = renderPhoneVerificationFlow();

    await selectIndiaOnce();

    fireEvent.change(screen.getByRole("textbox", { name: "Phone number" }), {
      target: { value: "8004482372" },
    });
    fireEvent.click(
      screen.getByRole("button", { name: "Send verification code" }),
    );

    await waitFor(() => {
      expect(startVerification).toHaveBeenCalledWith("+918004482372", {
        resendCode: false,
      });
    });
  });

  it("blocks an Indian number with an extra leading zero before Firebase", async () => {
    const { startVerification } = renderPhoneVerificationFlow();

    await selectIndiaOnce();
    const phoneInput = screen.getByRole("textbox", {
      name: "Phone number",
    }) as HTMLInputElement;
    expect(phoneInput.maxLength).toBe(10);

    fireEvent.change(phoneInput, { target: { value: "0800448237" } });
    expect(phoneInput.value).toBe("0800448237");
    fireEvent.click(
      screen.getByRole("button", { name: "Send verification code" }),
    );

    await waitFor(() => expect(startVerification).not.toHaveBeenCalled());
    expect(phoneInput).toHaveAttribute("aria-invalid", "true");
    expect(screen.getByRole("alert").textContent).toBe(
      "Enter the mobile number without a local leading prefix after +91.",
    );
    expect(screen.queryByRole("textbox", { name: "One-time code" })).toBeNull();
  });

  it("rejects an overlength paste without changing or sending the recipient", async () => {
    const { startVerification } = renderPhoneVerificationFlow();

    await selectIndiaOnce();
    const phoneInput = screen.getByRole("textbox", {
      name: "Phone number",
    }) as HTMLInputElement;
    fireEvent.change(phoneInput, { target: { value: "8004482372" } });
    phoneInput.setSelectionRange(0, phoneInput.value.length);
    fireEvent.paste(phoneInput, {
      clipboardData: { getData: () => "800448237299" },
    });

    expect(phoneInput.value).toBe("8004482372");
    expect(phoneInput.maxLength).toBe(10);
    expect(screen.getByRole("alert").textContent).toBe(
      "Enter no more than 10 digits for India.",
    );

    fireEvent.click(
      screen.getByRole("button", { name: "Send verification code" }),
    );
    await waitFor(() => expect(startVerification).not.toHaveBeenCalled());
  });

  it("preserves a complete E.164 paste before native maxLength clipping", async () => {
    const { startVerification } = renderPhoneVerificationFlow();
    const phoneInput = screen.getByRole("textbox", {
      name: "Phone number",
    }) as HTMLInputElement;

    fireEvent.paste(phoneInput, {
      clipboardData: { getData: () => "+16582101234" },
    });

    await waitFor(() => expect(phoneInput.value).toBe("6582101234"));
    const countryInput = screen.getByRole("combobox", {
      name: "Country code",
    }) as HTMLInputElement;
    expect(countryInput.value).toBe("Jamaica (+1)");

    fireEvent.click(
      screen.getByRole("button", { name: "Send verification code" }),
    );
    await waitFor(() => {
      expect(startVerification).toHaveBeenCalledWith("+16582101234", {
        resendCode: false,
      });
    });
  });

  it("shows only the masked national number on the OTP screen", async () => {
    renderPhoneVerificationFlow();

    await selectIndiaOnce();
    fireEvent.change(screen.getByRole("textbox", { name: "Phone number" }), {
      target: { value: "8004482372" },
    });
    fireEvent.click(
      screen.getByRole("button", { name: "Send verification code" }),
    );

    expect(await screen.findByText("••••••2372")).toBeTruthy();
    expect(screen.queryByText(/\+91/)).toBeNull();
    expect(screen.getByRole("textbox", { name: "One-time code" })).toBeTruthy();
  });

  it("submits both the phone number and six-digit code through their semantic forms", async () => {
    const { startVerification, confirmVerification, onCompleted } =
      renderPhoneVerificationFlow();

    const phoneInput = screen.getByRole("textbox", { name: "Phone number" });
    fireEvent.change(phoneInput, { target: { value: "6505550101" } });
    fireEvent.submit(phoneInput.closest("form")!);

    await waitFor(() => {
      expect(startVerification).toHaveBeenCalledWith("+16505550101", {
        resendCode: false,
      });
    });

    const codeInput = await screen.findByRole("textbox", {
      name: "One-time code",
    });
    fireEvent.change(codeInput, { target: { value: "123456" } });
    fireEvent.submit(codeInput.closest("form")!);

    await waitFor(() => {
      expect(confirmVerification).toHaveBeenCalledWith("123456");
      expect(onCompleted).toHaveBeenCalledWith({ uid: "user_1" });
    });
  });

  it("reports a failed voice settlement when the SMS provider rejects", async () => {
    renderPhoneVerificationFlow({ startRejects: true });
    await waitFor(() => {
      expect(
        resolveLocalOnboardingHandler("phone_mandate.submit_number"),
      ).not.toBeNull();
    });

    const result = await resolveLocalOnboardingHandler(
      "phone_mandate.submit_number",
    )?.({
      phoneNumber: "+16505550101",
    });

    expect(result).toMatchObject({ status: "failed" });
  });

  it("keeps the spoken code transient and settles only after confirmation succeeds", async () => {
    const { confirmVerification, onCompleted } = renderPhoneVerificationFlow();
    await waitFor(() => {
      expect(
        resolveLocalOnboardingHandler("phone_mandate.submit_number"),
      ).not.toBeNull();
    });
    await resolveLocalOnboardingHandler("phone_mandate.submit_number")?.({
      phoneNumber: "+16505550101",
    });
    await waitFor(() => {
      expect(
        resolveLocalOnboardingHandler("phone_mandate.submit_code"),
      ).not.toBeNull();
    });

    const result = await resolveLocalOnboardingHandler(
      "phone_mandate.submit_code",
    )?.({
      code: "123456",
    });

    expect(confirmVerification).toHaveBeenCalledWith("123456");
    expect(onCompleted).toHaveBeenCalled();
    expect(result).toMatchObject({ status: "succeeded" });
    expect(result?.summary).not.toContain("123456");
    expect(
      (screen.getByRole("textbox", { name: "One-time code" }) as HTMLInputElement)
        .value,
    ).toBe("");
  });

  it("clears stale OTP digits on resend so the newest verification session wins", async () => {
    const { startVerification } = renderPhoneVerificationFlow();
    const codeInput = (await reachCodeStep(
      startVerification,
    )) as HTMLInputElement;

    fireEvent.change(codeInput, { target: { value: "111111" } });
    expect(codeInput.value).toBe("111111");

    fireEvent.click(screen.getByRole("button", { name: "Resend code" }));

    await waitFor(() => expect(startVerification).toHaveBeenCalledTimes(2));
    expect(startVerification).toHaveBeenLastCalledWith("+16505550101", {
      resendCode: true,
    });
    await waitFor(() => expect(codeInput.value).toBe(""));
  });

  it("clears the OTP input when the code has expired, keeping the person on the OTP screen with Resend available", async () => {
    const confirmVerification = vi
      .fn()
      .mockRejectedValue(
        Object.assign(
          new Error("This verification code has expired. Please request a new code."),
          { code: "code-expired" },
        ),
      );
    const { startVerification } = renderPhoneVerificationFlow({
      confirmVerification,
    });
    const codeInput = (await reachCodeStep(
      startVerification,
    )) as HTMLInputElement;

    fireEvent.change(codeInput, { target: { value: "222222" } });
    fireEvent.submit(codeInput.closest("form")!);

    await waitFor(() => expect(confirmVerification).toHaveBeenCalledWith("222222"));
    await waitFor(() => expect(codeInput.value).toBe(""));
    // Stays on the OTP screen (not bounced back to the phone step) and no
    // second SMS was auto-sent.
    expect(screen.getByRole("button", { name: "Resend code" })).toBeTruthy();
    expect(startVerification).toHaveBeenCalledTimes(1);
  });

  it("keeps a wrong OTP in place instead of clearing it, so a typo can be fixed", async () => {
    const confirmVerification = vi
      .fn()
      .mockRejectedValue(
        Object.assign(
          new Error(
            "That verification code is incorrect. Please check the code and try again.",
          ),
          { code: "invalid-verification-code" },
        ),
      );
    const { startVerification } = renderPhoneVerificationFlow({
      confirmVerification,
    });
    const codeInput = (await reachCodeStep(
      startVerification,
    )) as HTMLInputElement;

    fireEvent.change(codeInput, { target: { value: "333333" } });
    fireEvent.submit(codeInput.closest("form")!);

    await waitFor(() =>
      expect(confirmVerification).toHaveBeenCalledWith("333333"),
    );
    expect(codeInput.value).toBe("333333");
  });

  it("does not fire a second verify request while one is still in flight", async () => {
    let resolveConfirm: (value: { uid: string }) => void = () => {};
    const confirmVerification = vi.fn(
      () =>
        new Promise<{ uid: string }>((resolve) => {
          resolveConfirm = resolve;
        }),
    );
    const { startVerification } = renderPhoneVerificationFlow({
      confirmVerification,
    });
    const codeInput = (await reachCodeStep(
      startVerification,
    )) as HTMLInputElement;
    fireEvent.change(codeInput, { target: { value: "444444" } });

    const verifyButton = screen.getByRole("button", {
      name: "Verify and continue",
    });
    fireEvent.click(verifyButton);
    fireEvent.click(verifyButton);
    // A Resend click while the verify request is still in flight must not
    // start a second, competing network request either.
    fireEvent.click(screen.getByRole("button", { name: "Resend code" }));

    await waitFor(() => expect(confirmVerification).toHaveBeenCalledTimes(1));
    expect(startVerification).toHaveBeenCalledTimes(1);

    resolveConfirm({ uid: "user_1" });
  });
});

describe("the OTP screen survives a late auth-context update", () => {
  async function sendCode(
    handle: ReturnType<typeof renderPhoneVerificationFlow>,
  ) {
    const phoneInput = screen.getByRole("textbox", { name: "Phone number" });
    fireEvent.change(phoneInput, { target: { value: "6505550101" } });
    fireEvent.submit(phoneInput.closest("form")!);
    await waitFor(() =>
      expect(handle.startVerification).toHaveBeenCalledWith("+16505550101", {
        resendCode: false,
      }),
    );
    return screen.findByRole("textbox", { name: "One-time code" });
  }

  it("keeps the person on the OTP screen when the backend phone number lands after the code was sent", async () => {
    // /register-phone always mounts with phoneNumber === null, which is the
    // exact condition that makes the auth context resolve the verified number
    // from the backend. That read can settle AFTER the code is sent.
    const handle = renderPhoneVerificationFlow({ currentPhoneNumber: null });
    const codeInput = await sendCode(handle);
    fireEvent.change(codeInput, { target: { value: "1234" } });

    handle.rerenderWithPhone("+16505550101");

    // The sent code is the only thing that matters now. A late identity read
    // must not take away the one screen that can consume it.
    await waitFor(() => {
      expect(
        screen.queryByRole("textbox", { name: "One-time code" }),
      ).not.toBeNull();
    });
    expect(
      screen.getByRole("textbox", { name: "One-time code" }),
    ).toHaveValue("1234");
  });

  it("keeps the person on the OTP screen when the context settles from undefined to null", async () => {
    const handle = renderPhoneVerificationFlow({ currentPhoneNumber: undefined });
    await sendCode(handle);

    handle.rerenderWithPhone(null);

    await waitFor(() => {
      expect(
        screen.queryByRole("textbox", { name: "One-time code" }),
      ).not.toBeNull();
    });
  });

  it("still re-seeds the form from a changed number before any code is sent", async () => {
    // The reset must keep working where it is meant to: no code is
    // outstanding, so a new owner number should still take effect.
    const handle = renderPhoneVerificationFlow({ currentPhoneNumber: null });
    expect(
      screen.getByRole("textbox", { name: "Phone number" }),
    ).not.toBeNull();

    handle.rerenderWithPhone("+16505550101");

    await waitFor(() => {
      expect(
        screen.queryByRole("textbox", { name: "Phone number" }),
      ).toBeNull();
    });
  });
});

describe("the country picker starts on the person's own country", () => {
  const realLanguage = navigator.language;

  function setBrowserLocale(tag: string) {
    Object.defineProperty(navigator, "language", {
      value: tag,
      configurable: true,
    });
  }

  afterEach(() => {
    setBrowserLocale(realLanguage);
  });

  it("selects India for a browser reporting en-IN", async () => {
    // The founder tests from India. This defaulted to "United States (+1)",
    // so a real Indian mobile was sent as +1<10 digits> -- a different number
    // entirely. The code went nowhere and the test-number allowlist, which
    // matches on the full E.164 string, could never match.
    setBrowserLocale("en-IN");
    renderPhoneVerificationFlow({ currentPhoneNumber: null });

    await waitFor(() => {
      expect(screen.getByDisplayValue(/India/i)).not.toBeNull();
    });
  });

  it("leaves the United States selected for a US browser", async () => {
    setBrowserLocale("en-US");
    renderPhoneVerificationFlow({ currentPhoneNumber: null });

    await waitFor(() => {
      expect(screen.getByDisplayValue(/United States/i)).not.toBeNull();
    });
  });

  it("keeps the country implied by an existing number over the browser locale", async () => {
    // A person whose account already carries a US number must not have it
    // silently re-pointed at India just because the browser says en-IN.
    setBrowserLocale("en-IN");
    renderPhoneVerificationFlow({ currentPhoneNumber: "+16505550101" });

    await waitFor(() => {
      expect(screen.queryByDisplayValue(/India/i)).toBeNull();
    });
  });
});


describe("onboarding code presentation", () => {
  it("keeps resend and change-number actions connected to the existing flow", async () => {
    let stepBack: (() => boolean) | null = null;
    const { startVerification } = renderPhoneVerificationFlow({ codePresentation: "onboarding",
      onBackStepChange: handler => { stepBack = handler; } });
    await reachCodeStep(startVerification);
    const resend = screen.getByRole("button", { name: "Resend code" });
    expect(resend.closest("p")?.textContent).toContain("Enter the code sent to");
    fireEvent.click(resend);
    await waitFor(() => expect(startVerification).toHaveBeenCalledTimes(2));
    fireEvent.click(screen.getByRole("button", { name: "Use a Different number" }));
    expect(await screen.findByRole("textbox", { name: "Phone number" })).toBeTruthy();
    expect(stepBack).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Send verification code" }));
    await screen.findByRole("textbox", { name: "One-time code" });
    expect(stepBack).not.toBeNull();
    act(() => { expect(stepBack?.()).toBe(true); });
    expect(await screen.findByRole("textbox", { name: "Phone number" })).toBeTruthy();
    expect(stepBack).toBeNull();
  });
  it("marks a rejected code and clears its error when corrected", async () => {
    const confirmVerification = vi.fn().mockRejectedValue(Object.assign(new Error("Wrong code"), { code: "auth/invalid-verification-code" }));
    const { startVerification } = renderPhoneVerificationFlow({ codePresentation: "onboarding", confirmVerification });
    const input = await reachCodeStep(startVerification);
    fireEvent.change(input, { target: { value: "123456" } });
    fireEvent.submit(input.closest("form")!);
    expect(await screen.findByText("That code isn't right. Check it and try again.")).toBeTruthy();
    expect(input.getAttribute("aria-invalid")).toBe("true");
    fireEvent.change(input, { target: { value: "12345" } });
    expect(input.getAttribute("aria-invalid")).toBe("false");
  });
});


describe("phone conflict recovery", () => {
  it("requires explicit transfer review and confirmation while preserving the old account", async () => {
    const transfer = vi.fn().mockResolvedValue({ uid: "receiving-user" });
    const flow = renderPhoneVerificationFlow({ confirmTransfer: transfer, confirmVerification: vi.fn().mockRejectedValue(
      new ApiError("Conflict", 409, { detail: { code: "PHONE_TRANSFER_CONFIRMATION_REQUIRED" } })) });
    const code = await reachCodeStep(flow.startVerification);
    fireEvent.change(code, { target: { value: "123456" } }); fireEvent.submit(code.closest("form")!);
    fireEvent.click(await screen.findByRole("button", { name: "Use this number on this account" }));
    expect(transfer).not.toHaveBeenCalled();
    expect(screen.getByText(/moving the phone link keeps both accounts, files and vaults/i)).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(transfer).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Use this number on this account" }));
    fireEvent.click(screen.getByRole("button", { name: "Confirm phone transfer" }));
    await waitFor(() => expect(flow.onCompleted).toHaveBeenCalledWith({ uid: "receiving-user" }));
    expect(transfer).toHaveBeenCalledOnce();
  });
  it("recovery never transfers and provider failure never opens account conflict choices", async () => {
    const recover = vi.fn(); const transfer = vi.fn();
    const flow = renderPhoneVerificationFlow({ confirmTransfer: transfer, recoverPreviousAccount: recover, confirmVerification: vi.fn().mockRejectedValue(
      new ApiError("Conflict", 409, { detail: { code: "PHONE_TRANSFER_CONFIRMATION_REQUIRED" } })) });
    const code = await reachCodeStep(flow.startVerification);
    fireEvent.change(code, { target: { value: "123456" } }); fireEvent.submit(code.closest("form")!);
    fireEvent.click(await screen.findByRole("button", { name: "Recover my previous account" }));
    expect(recover).toHaveBeenCalledOnce(); expect(transfer).not.toHaveBeenCalled();
    expect(flow.onCompleted).not.toHaveBeenCalled(); flow.unmount();
    const outage = renderPhoneVerificationFlow({ confirmVerification: vi.fn().mockRejectedValue(new ApiError("Unavailable", 503, { code: "DATABASE_UNAVAILABLE" })) });
    const next = await reachCodeStep(outage.startVerification);
    fireEvent.change(next, { target: { value: "123456" } }); fireEvent.submit(next.closest("form")!);
    await waitFor(() => expect(outage.confirmVerification).toHaveBeenCalledOnce());
    expect(screen.queryByRole("button", { name: "Use this number on this account" })).not.toBeInTheDocument();
  });
});


describe("phone transfer temporal and Back contracts", () => {
  it("rejects retained review confirmation after Back and consumes Back while pending", async () => {
    const transfer = vi.fn().mockRejectedValue(new ApiError("pending", 503, { code: "PHONE_TRANSFER_IN_PROGRESS" }));
    const { result } = renderHook(() => usePhoneVerificationFlow({ mode: "replace", currentPhoneNumber: "+16505550101",
      startVerification: vi.fn().mockResolvedValue({ autoVerified: false }),
      confirmVerification: vi.fn().mockRejectedValue(new ApiError("conflict", 409, { code: "PHONE_TRANSFER_CONFIRMATION_REQUIRED" })),
      confirmTransfer: transfer, onCompleted: vi.fn() }));
    await act(async () => { await result.current.handleStartVerification(false, "+16505550102"); });
    await act(async () => { await result.current.submitVerificationCode("123456", { notify: false }); });
    expect(result.current.conflict).toBe("choices");
    act(() => { result.current.reviewTransfer(); });
    const retainedConfirm = result.current.handleTransfer;
    act(() => { result.current.returnToPhoneNumber(); });
    expect(result.current.conflict).toBe("choices");
    await act(async () => { await retainedConfirm(); });
    expect(transfer).not.toHaveBeenCalled();
    act(() => { result.current.reviewTransfer(); });
    await act(async () => { await result.current.handleTransfer(); });
    expect(result.current.transferPending).toBe(true);
    act(() => { expect(result.current.returnToPhoneNumber()).toBe(true); });
    expect(result.current.conflict).toBe("review");
    expect(transfer).toHaveBeenCalledTimes(1);
  });
  it("shared test conflicts cannot offer a transfer without real SMS proof", async () => {
    const { startVerification } = renderPhoneVerificationFlow({ startVerification: vi.fn().mockRejectedValue(new ApiError("test number in use", 409, { code: "PHONE_TEST_NUMBER_IN_USE" })), confirmTransfer: vi.fn() });
    fireEvent.change(screen.getByRole("textbox", { name: "Phone number" }), { target: { value: "6505550101" } });
    fireEvent.click(screen.getByRole("button", { name: "Send verification code" }));
    expect(await screen.findByRole("button", { name: "Use this number on this account" })).toBeDisabled();
    expect(startVerification).toHaveBeenCalledTimes(1);
  });
});
