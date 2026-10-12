import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { DecisionCard } from "@/components/kai/views/decision-card";

describe("Finance detailed analysis", () => {
  it("starts compact while retaining the full rationale, strategy and evidence on demand", () => {
    render(<DecisionCard result={{
      ticker: "TEST", decision: "buy", confidence: 0.82, consensus_reached: true,
      final_statement: "Full verdict retained",
      dissenting_opinions: ["Independent dissent retained"],
      raw_card: {
        fundamental_insight: { summary: "Key takeaway visible", business_moat: "Moat retained" },
        llm_synthesis: { thesis: "Strategy retained", action_plan: ["Action retained"] },
        structured_sources: [{ label: "Evidence source", url: "https://example.com/evidence" }],
      },
    }} />);
    expect(screen.getByText("Key takeaway visible")).toBeVisible();
    expect(screen.getByText("82%")).toBeVisible();
    expect(screen.queryByText("Full verdict retained")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Rationale & fundamentals" }));
    expect(screen.getByText("Full verdict retained")).toBeVisible();
    expect(screen.getByText("Moat retained")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Strategy, risks & action plan" }));
    expect(screen.getByText("Action retained")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Debate evidence & sources" }));
    expect(screen.getByText("Independent dissent retained")).toBeVisible();
    expect(screen.getByRole("link", { name: "Evidence source" })).toHaveAttribute("href", "https://example.com/evidence");
  });
});