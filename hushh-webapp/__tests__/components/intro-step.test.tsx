import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { IntroStep } from "@/components/onboarding/IntroStep";
import { resolveLocalOnboardingHandler } from "@/lib/agent/local-onboarding-actions";
import { getVoiceSurfaceMetadata } from "@/lib/voice/voice-surface-metadata";

vi.mock("@/components/app-ui/hushh-wordmark", () => ({
  HushhWordmark: () => <span>hussh</span>,
}));

vi.mock("@/components/onboarding/OnboardingHeroBackground", () => ({
  OnboardingHeroBackground: () => null,
}));

afterEach(() => {
  document.body.innerHTML = "";
});

describe("IntroStep voice contract", () => {
  it("publishes and executes the same Claim your One control used by tapping", async () => {
    const onLogin = vi.fn();
    render(<IntroStep onLogin={onLogin} />);

    await waitFor(() => {
      expect(getVoiceSurfaceMetadata()).toMatchObject({
        screenId: "one_intro",
        actions: [
          expect.objectContaining({ actionId: "onboarding.claim_one" }),
        ],
        controls: [expect.objectContaining({ id: "onboarding_claim_one" })],
      });
      expect(
        resolveLocalOnboardingHandler("onboarding.claim_one"),
      ).not.toBeNull();
    });

    const button = screen.getByRole("button", { name: /claim your one/i });
    expect(button).toHaveAttribute(
      "data-voice-control-id",
      "onboarding_claim_one",
    );
    fireEvent.click(button);
    expect(onLogin).toHaveBeenCalledTimes(1);

    const handler = resolveLocalOnboardingHandler("onboarding.claim_one");
    const result = await handler?.({});
    expect(onLogin).toHaveBeenCalledTimes(2);
    expect(result).toEqual({ status: "started", summary: "Opening sign-in." });
  });

  it("uses the standardized root quiet mark between the private-agent line and One", () => {
    render(<IntroStep onLogin={vi.fn()} />);

    const privateAgent = screen.getByText("Your private agent");
    const quietMark = screen.getByText("🤫");
    const one = screen.getByRole("heading", { name: "One" });

    expect(privateAgent.compareDocumentPosition(quietMark)).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );
    expect(quietMark.compareDocumentPosition(one)).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );
  });
});
