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
  it("publishes and executes the same Meet your agents control used by tapping", async () => {
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

    const button = screen.getByRole("button", { name: /meet your agents/i });
    expect(button).toHaveAttribute(
      "data-voice-control-id",
      "onboarding_claim_one",
    );
    expect(button.querySelector(":scope > .morphy-ripple-host")).not.toBeNull();
    fireEvent.click(button);
    expect(onLogin).toHaveBeenCalledTimes(1);

    const handler = resolveLocalOnboardingHandler("onboarding.claim_one");
    const result = await handler?.({});
    expect(onLogin).toHaveBeenCalledTimes(2);
    expect(result).toEqual({
      status: "started",
      summary: "Opening sign-in.",
      routeAfter: "/login",
      screenAfter: "login",
    });
  });

  it("uses the standardized root quiet mark before One without the old eyebrow", () => {
    render(<IntroStep onLogin={vi.fn()} />);

    expect(screen.queryByText("Your private agent")).toBeNull();
    const quietMark = screen.getByText("🤫");
    const one = screen.getByRole("heading", { name: "One" });

    expect(quietMark.compareDocumentPosition(one)).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );
  });

  it("renders the focused root copy and removes public footer links", () => {
    render(<IntroStep onLogin={vi.fn()} />);

    expect(
      screen.getByText("Personal agents for everyday life."),
    ).toBeInTheDocument();
    expect(
      screen.getByText("One app to bring them together."),
    ).toBeInTheDocument();
    expect(screen.getByText("Your agents. Yours to own.")).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Research" })).toBeNull();
    expect(screen.queryByRole("link", { name: "Blog" })).toBeNull();
    expect(screen.queryByRole("link", { name: "Developers" })).toBeNull();
  });
});
