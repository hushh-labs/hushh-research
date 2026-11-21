import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import {
  AgentHistorySidebar,
  resolveConversationCategory,
} from "@/components/agent/agent-history-sidebar";
import { HusshOneLockup } from "@/components/brand/hussh-one-lockup";
import { humanizeConsentScope } from "@/lib/consent/consent-display";
import { consentInformationLabel } from "@/lib/consent/consent-owner-copy";
import {
  createPointerVelocityTracker,
  sampleClosedFormSpring,
} from "@/lib/motion/closed-form-spring";
import { isPublicEditorialOrLegalRoute } from "@/lib/navigation/routes";
import type { AgentChatConversation } from "@/lib/services/agent-chat-client";

describe("Closed-form 120Hz spring solver", () => {
  it("inherits initial gesture velocity (C1 continuity) and settles cleanly", () => {
    const startSample = sampleClosedFormSpring(100, 0, 0.016, {
      visualDuration: 0.28,
      bounce: 0.08,
      initialVelocity: -900,
      restDelta: 0.5,
      restSpeed: 4,
    });
    const zeroVelocitySample = sampleClosedFormSpring(100, 0, 0.016, {
      visualDuration: 0.28,
      bounce: 0.08,
      initialVelocity: 0,
      restDelta: 0.5,
      restSpeed: 4,
    });
    expect(startSample.value).toBeLessThan(zeroVelocitySample.value);

    const settled = sampleClosedFormSpring(100, 0, 1.0, {
      visualDuration: 0.28,
      bounce: 0.08,
      initialVelocity: -900,
    });
    expect(settled.done).toBe(true);
    expect(settled.value).toBe(0);
    expect(settled.velocity).toBe(0);
  });

  it("tracks rolling 80ms pointer velocity in px/s", () => {
    const tracker = createPointerVelocityTracker();
    tracker.reset(10, 100);
    tracker.push(50, 140);
    tracker.push(90, 180);
    expect(tracker.velocityPxPerSec(180)).toBeCloseTo(1000, 0);
  });
});

describe("HusshOneLockup brand mark", () => {
  it("renders pure SVG vector paths and preserves exact textContent for header contracts", () => {
    const { container } = render(<HusshOneLockup variant="header" label="One" />);
    const svg = screen.getByTestId("hussh-wordmark-svg");
    expect(svg.querySelectorAll("path").length).toBe(2);
    expect(svg.querySelector("text")).toBeNull();
    expect(container.textContent).toBe("One");
  });
});

describe("AgentHistorySidebar categorization and hussh One lockup", () => {
  const sampleConversations: AgentChatConversation[] = [
    {
      id: "conv-one",
      title: "One",
      status: "active",
      message_count: 10,
      updated_at: Date.now() / 1000,
    },
    {
      id: "conv-fin",
      title: "Connect Plaid bank accounts for Q4 cashflow",
      category: "Finance",
      category_source: "auto",
      status: "active",
      message_count: 4,
      updated_at: Date.now() / 1000 - 120,
    },
    {
      id: "conv-conn",
      title: "What has my connection Kushal shared with me",
      category: "Connections",
      category_source: "auto",
      status: "active",
      message_count: 3,
      updated_at: Date.now() / 1000 - 300,
    },
    {
      id: "conv-custom",
      title: "2026 Portfolio Strategy",
      category: "Advisory",
      category_source: "custom",
      status: "active",
      message_count: 6,
      updated_at: Date.now() / 1000 - 600,
    },
  ];

  it("infers smart categories deterministically when unauthored", () => {
    expect(resolveConversationCategory({ title: "Plaid bank balance" })).toBe("Finance");
    expect(
      resolveConversationCategory({ title: "Information request from trusted circle" }),
    ).toBe("Connections");
    expect(resolveConversationCategory({ title: "Schedule client meeting on Calendar" })).toBe(
      "Work",
    );
    expect(resolveConversationCategory({ title: "Weekend hike ideas" })).toBe("Personal");
  });

  it("renders themed hussh One lockup and filters chats by smart & custom categories", () => {
    render(
      <AgentHistorySidebar
        conversations={sampleConversations}
        activeConversationId="conv-fin"
        mode="mobile"
        pinnedOneConversationId="conv-one"
        oneStreamActive={false}
        onSelectOneStream={vi.fn()}
        onCreateNew={vi.fn()}
        onSelectConversation={vi.fn()}
        onRenameConversation={vi.fn()}
        onCategorizeConversation={vi.fn()}
        onDeleteConversation={vi.fn()}
      />,
    );

    const pinnedOne = screen.getByTestId("agent-history-pinned-one");
    expect(pinnedOne.querySelector('[data-testid="hussh-wordmark-svg"]')).not.toBeNull();
    expect(pinnedOne.textContent).toContain("Main chat");

    const financeTab = screen.getByTestId("agent-history-category-finance");
    const advisoryTab = screen.getByTestId("agent-history-category-advisory");
    expect(financeTab).toBeTruthy();
    expect(advisoryTab).toBeTruthy();

    fireEvent.click(financeTab);
    expect(
      screen.getByText("Connect Plaid bank accounts for Q4 cashflow"),
    ).toBeTruthy();
    expect(
      screen.queryByText("What has my connection Kushal shared with me"),
    ).toBeNull();

    fireEvent.click(advisoryTab);
    expect(screen.getByText("2026 Portfolio Strategy")).toBeTruthy();
    expect(screen.getByTestId("agent-history-row-category").textContent).toBe(
      "Advisory",
    );
  });
});

describe("Consent copy and public legal/editorial chrome gating", () => {
  it("strips trailing record-timestamp metadata suffixes like as_of from consent labels", () => {
    expect(humanizeConsentScope("attr.financial.liabilities.as_of")).toBe(
      "Financial Liabilities",
    );
    expect(
      consentInformationLabel({
        scope: "attr.financial.liabilities.as_of",
        label: "Financial liabilities as of",
      }),
    ).toBe("Financial liabilities");
    expect(
      consentInformationLabel({
        label: "Financial cashflow as of",
      }),
    ).toBe("Financial cashflow");
  });

  it("excludes legal, terms, welcome, research, blog, and developer routes from voice/command chrome", () => {
    for (const route of [
      "/privacy",
      "/terms",
      "/welcome",
      "/research",
      "/research/protocol",
      "/blog",
      "/blog/agentic-privacy",
      "/developers",
    ]) {
      expect(isPublicEditorialOrLegalRoute(route)).toBe(true);
    }
    for (const appRoute of ["/", "/one", "/one/feed", "/one/location", "/connect"]) {
      expect(isPublicEditorialOrLegalRoute(appRoute)).toBe(false);
    }
  });
});
