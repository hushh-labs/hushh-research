import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { PhoneVerificationFlow } from "@/components/auth/phone-verification-flow";
import { resolveLocalOnboardingHandler } from "@/lib/agent/local-onboarding-actions";
import { getVoiceSurfaceMetadata } from "@/lib/voice/voice-surface-metadata";

vi.mock("next/navigation", () => ({
  usePathname: () => "/register-phone",
}));

function renderPhoneVerificationFlow(options?: { startRejects?: boolean }) {
  const startVerification = options?.startRejects
    ? vi.fn().mockRejectedValue(new Error("provider unavailable"))
    : vi.fn().mockResolvedValue({ autoVerified: false });
  const confirmVerification = vi.fn().mockResolvedValue({ uid: "user_1" });
  const onCompleted = vi.fn();

  render(
    <PhoneVerificationFlow
      mode="link"
      startVerification={startVerification}
      confirmVerification={confirmVerification}
      onCompleted={onCompleted}
    />,
  );

  return {
    startVerification,
    confirmVerification,
    onCompleted,
  };
}

async function selectIndiaOnce() {
  const countryInput = screen.getByRole("combobox", {
    name: "Country code",
  }) as HTMLInputElement;

  fireEvent.focus(countryInput);

  const indiaOption = await screen.findByText("India");
  const indiaItem = (indiaOption.closest("[data-slot='combobox-item']") ??
    indiaOption) as Element;

  fireEvent.pointerDown(indiaItem);
  fireEvent.click(indiaItem);

  await waitFor(() => {
    expect(countryInput.value).toBe("India (+91)");
  });

  return countryInput;
}

describe("PhoneVerificationFlow country selector", () => {
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

  it("shows India immediately after the first country selection", async () => {
    renderPhoneVerificationFlow();

    await selectIndiaOnce();
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

    expect(await screen.findByText("•••••• 2372")).toBeTruthy();
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
});
