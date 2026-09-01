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
