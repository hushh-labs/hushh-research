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
  it("publishes and executes the same Get started control used by tapping", async () => {
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

    const button = screen.getByRole("button", { name: /get started/i });
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

  it("keeps every older spoken phrasing on the renamed control", async () => {
    render(<IntroStep onLogin={vi.fn()} />);

    await waitFor(() => {
      const metadata = getVoiceSurfaceMetadata();
      expect(metadata?.controls?.[0]).toMatchObject({
        label: "Get started",
        voiceAliases: expect.arrayContaining([
          "get started",
          "claim your one",
          "claim one",
        ]),
      });
    });
  });

  it("keeps the root public navigation to Research, Blog, and Developers", () => {
    render(<IntroStep onLogin={vi.fn()} />);

    const publicNav = screen.getByRole("navigation", { name: "Explore Hussh" });
    expect(publicNav.querySelectorAll("a")).toHaveLength(3);
    expect(screen.getByRole("link", { name: "Research" })).toHaveAttribute(
      "href",
      "/research",
    );
    expect(screen.getByRole("link", { name: "Blog" })).toHaveAttribute(
      "href",
      "/blog",
    );
    expect(screen.getByRole("link", { name: "Developers" })).toHaveAttribute(
      "href",
      "/developers",
    );
  });
});

describe("IntroStep welcome clarity", () => {
  it("shows one message and one action, in reading order", () => {
    const { container } = render(<IntroStep onLogin={vi.fn()} />);

    const wordmark = screen.getByText("hussh");
    const one = screen.getByRole("heading", { name: "One" });
    const supporting = screen.getByText(
      "Your personal assistant for everyday tasks.",
    );
    const cta = screen.getByRole("button", { name: /get started/i });
    const privacy = screen.getByText(/You control what you share\./);
    const nav = screen.getByRole("navigation", { name: "Explore Hussh" });

    const order = [wordmark, one, supporting, cta, privacy, nav];
    for (let i = 0; i < order.length - 1; i += 1) {
      expect(order[i].compareDocumentPosition(order[i + 1])).toBe(
        Node.DOCUMENT_POSITION_FOLLOWING,
      );
    }

    // One heading, one button. A second primary action on a welcome screen is
    // the failure this test exists to catch.
    expect(container.querySelectorAll("h1")).toHaveLength(1);
    expect(screen.getAllByRole("button")).toHaveLength(1);
  });

  it("keeps the quiet mark with the wordmark, as one brand lockup", () => {
    render(<IntroStep onLogin={vi.fn()} />);

    // The shush IS the brand — "hushh" is the word for it. It went missing in
    // the first simplification pass and that is the regression this guards.
    const quietMark = screen.getByText("🤫");
    const wordmark = screen.getByText("hussh");
    const one = screen.getByRole("heading", { name: "One" });

    expect(wordmark.compareDocumentPosition(quietMark)).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );
    expect(quietMark.compareDocumentPosition(one)).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );
    // Decorative twin of the wordmark: it must not be announced twice.
    expect(quietMark).toHaveAttribute("aria-hidden", "true");
  });

  it("carries no marketing text ahead of the decision", () => {
    render(<IntroStep onLogin={vi.fn()} />);

    for (const removed of [
      /Your private agent/i,
      /Yours to own/i,
      /Listens/i,
      /Remembers/i,
      /Decides/i,
      /Acts/i,
      /stays locked/i,
      /Nothing moves without/i,
    ]) {
      expect(screen.queryByText(removed)).toBeNull();
    }
  });
});
