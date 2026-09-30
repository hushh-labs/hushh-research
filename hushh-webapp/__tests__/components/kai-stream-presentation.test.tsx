import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

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

  it("uses the canonical segmented tab contract for analyst selection", () => {
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

    expect(screen.getByRole("tablist", { name: "Initial Deep Analysis analysts" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("tab", { name: "Sentiment" }));
    expect(screen.getByText("Sentiment result")).toBeInTheDocument();
    expect(screen.queryByText("Fundamental result")).not.toBeInTheDocument();
  });
});
