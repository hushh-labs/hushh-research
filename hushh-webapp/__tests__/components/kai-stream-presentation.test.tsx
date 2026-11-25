import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { AppStreamPanel } from "@/components/app-ui/stream-progress-panel";
import { StreamingProgressView } from "@/components/kai/views/streaming-progress-view";
import { RoundTabsCard } from "@/components/kai/views/round-tabs-card";

const idle = { stage: "idle" as const, text: "", thoughts: [] };

describe("Kai stream presentation", () => {
  it("does not fabricate an empty reasoning stream for a structured active agent", () => {
    render(
      <StreamingProgressView
        stage="active"
        title="Fundamental Agent"
        streamedText=""
      />,
    );

    expect(screen.getByText("Live update...")).toBeInTheDocument();
    expect(screen.queryByText("Preparing stream...")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /analysis/i })).not.toBeInTheDocument();
  });

  it("renders real streamed analysis in a flat expandable surface", () => {
    render(
      <StreamingProgressView
        stage="active"
        title="Valuation Agent"
        streamedText="Revenue quality is improving."
      />,
    );

    expect(screen.getByRole("button", { name: /analysis/i })).toBeInTheDocument();
    expect(screen.getByText("Revenue quality is improving.")).toBeInTheDocument();
  });

  it("formats saved XML-compatible debate analysis without treating it as HTML", () => {
    const { container } = render(
      <StreamingProgressView
        stage="complete"
        title="Fundamental Agent"
        compactMode
        streamedText={
          '<analysis><thought>Revenue growth is flat.</thought><claim id="c1" type="fact" confidence="0.95">Free cash flow remains strong.</claim><evidence target="c1" source="SEC">Free cash flow was $108.8B.</evidence><portfolio_impact type="risk" magnitude="medium" score="6">Concentration increases valuation risk.</portfolio_impact><bull_case_personalized>Cash flow supports the portfolio.</bull_case_personalized><bear_case_personalized><img src=x onerror=alert(1)> Growth could stall.</bear_case_personalized><renaissance_verdict>ACE tier remains intact.</renaissance_verdict></analysis>'
        }
      />,
    );

    expect(screen.getByText("Reasoning")).toBeInTheDocument();
    expect(screen.getByText("Claim · Fact · 95% confidence")).toBeInTheDocument();
    expect(screen.getByText("Evidence · SEC")).toBeInTheDocument();
    expect(screen.getByText("Portfolio impact · Risk · Medium · 6/10")).toBeInTheDocument();
    expect(screen.getByText("Personalized bull case")).toBeInTheDocument();
    expect(screen.getByText("Personalized bear case")).toBeInTheDocument();
    expect(screen.getByText("Renaissance verdict")).toBeInTheDocument();
    expect(screen.getByText(/<img src=x onerror=alert\(1\)> Growth could stall\./)).toBeInTheDocument();
    expect(container.querySelector("img")).toBeNull();
    expect(screen.queryByText(/<analysis>|<claim|<portfolio_impact/)).not.toBeInTheDocument();
  });

  it("keeps every analyst result available through independent disclosures", () => {
    render(
      <RoundTabsCard
        roundNumber={1}
        title="Initial Deep Analysis"
        isCollapsed={false}
        onToggleCollapse={() => undefined}
        agentStates={{
          fundamental: { ...idle, stage: "complete", text: "Fundamental result" },
          sentiment: { ...idle, stage: "complete", text: "Sentiment result" },
          valuation: { ...idle, stage: "complete", text: "Valuation result" },
        }}
      />,
    );

    expect(screen.queryByRole("tablist")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Sentiment · round 1" }));
    expect(screen.getByText("Sentiment result")).toBeInTheDocument();
    expect(screen.queryByText("Fundamental result")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Fundamental · round 1" }));
    expect(screen.getByText("Fundamental result")).toBeInTheDocument();
    expect(screen.getByText("Sentiment result")).toBeInTheDocument();
  });

  it("collapses Activity and Reasoning smoothly in-place without remounting triggers when the answer arrives", () => {
    const progressItems = [{ id: "step-1", label: "Search", message: "Checking records", status: "done" as const }];
    const thinkingItems = [{ id: "think-1", message: "Synthesizing timeline", status: "done" as const }];

    const { rerender } = render(
      <AppStreamPanel
        isStreaming
        progressItems={progressItems}
        thinkingItems={thinkingItems}
        responseText=""
      />,
    );

    const activityTriggerBefore = screen.getByRole("button", { name: /activity/i });
    const reasoningTriggerBefore = screen.getByRole("button", { name: /reasoning/i });
    expect(activityTriggerBefore).toHaveAttribute("data-state", "open");
    expect(reasoningTriggerBefore).toHaveAttribute("data-state", "open");

    rerender(
      <AppStreamPanel
        isStreaming={false}
        progressItems={progressItems}
        thinkingItems={thinkingItems}
        responseText="Here is your summary."
      />,
    );

    const activityTriggerAfter = screen.getByRole("button", { name: /activity/i });
    const reasoningTriggerAfter = screen.getByRole("button", { name: /reasoning/i });
    expect(activityTriggerAfter).toBe(activityTriggerBefore);
    expect(reasoningTriggerAfter).toBe(reasoningTriggerBefore);
    expect(activityTriggerAfter).toHaveAttribute("data-state", "closed");
    expect(reasoningTriggerAfter).toHaveAttribute("data-state", "closed");

    fireEvent.click(activityTriggerAfter);
    expect(activityTriggerAfter).toHaveAttribute("data-state", "open");
    expect(screen.getByText("Checking records")).toBeInTheDocument();
  });
});
