/**
 * The score has to show its working.
 *
 * A bare number cannot be argued with. These pin the parts that make it
 * checkable — and the one thing that must never be hardcoded here: the weights.
 */

import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { NearbyScoreExplainer } from "@/components/ria/nearby/nearby-score-explainer";
import type { ScoreBreakdown } from "@/lib/services/nws-nearby-service";

function breakdown(over: Partial<ScoreBreakdown> = {}): ScoreBreakdown {
  return {
    components: [
      {
        key: "graph_authority",
        label: "Graph authority",
        value: 0.91,
        weight: 0.3,
        contribution: 0.273,
      },
      {
        key: "freshness",
        label: "Freshness",
        value: 0.92,
        weight: 0.05,
        contribution: 0.046,
      },
      {
        key: "capital_access",
        label: "Capital access",
        value: 0.64,
        weight: 0.1,
        contribution: 0.064,
      },
    ],
    evidenceCount: 12,
    coverageMultiplier: 1,
    integrityPenalty: 0.034,
    localRelevance: 0.772,
    method: "Each component is scored 0-1, multiplied by its weight and summed.",
    ...over,
  };
}

describe("score explainer", () => {
  it("shows each component with its score and its weight", () => {
    render(<NearbyScoreExplainer breakdown={breakdown()} />);

    expect(screen.getByText("Graph authority")).toBeInTheDocument();
    expect(screen.getByText("91 · 30%")).toBeInTheDocument();
    expect(screen.getByText("Freshness")).toBeInTheDocument();
    expect(screen.getByText("92 · 5%")).toBeInTheDocument();
  });

  it("sizes the bar by contribution, not by raw score", () => {
    // Freshness scores higher than graph authority (0.92 vs 0.91) but carries a
    // sixth of the weight. A bar drawn from the raw value would make the least
    // decisive component look like the most decisive one.
    const { container } = render(<NearbyScoreExplainer breakdown={breakdown()} />);
    const widths = Array.from(container.querySelectorAll("span[style*='width']")).map((el) =>
      parseFloat((el as HTMLElement).style.width),
    );

    expect(widths).toHaveLength(3);
    // Graph authority (0.91 × 30%) draws longer than freshness (0.92 × 5%),
    // despite freshness scoring higher.
    expect(widths[0]).toBeGreaterThan(widths[1]);
  });

  it("explains the adjustments that the component sum alone does not", () => {
    render(<NearbyScoreExplainer breakdown={breakdown()} />);

    expect(screen.getByText("12 sources")).toBeInTheDocument();
    expect(screen.getByText("×1.00")).toBeInTheDocument();
    expect(screen.getByText("fully corroborated")).toBeInTheDocument();
    expect(screen.getByText("−3%")).toBeInTheDocument();
    expect(screen.getByText("10% of the nearby rank")).toBeInTheDocument();
  });

  it("says when a score was held back for thin evidence", () => {
    render(
      <NearbyScoreExplainer
        breakdown={breakdown({ coverageMultiplier: 0.84, evidenceCount: 3 })}
      />,
    );

    expect(screen.getByText("3 sources")).toBeInTheDocument();
    expect(screen.getByText("held back on thin evidence")).toBeInTheDocument();
  });

  it("hides the integrity line when there is no penalty", () => {
    render(<NearbyScoreExplainer breakdown={breakdown({ integrityPenalty: 0 })} />);

    expect(screen.queryByText("Integrity")).not.toBeInTheDocument();
  });

  it("renders nothing rather than an empty frame when there is nothing to explain", () => {
    const { container } = render(
      <NearbyScoreExplainer breakdown={breakdown({ components: [] })} />,
    );

    expect(container).toBeEmptyDOMElement();
  });

  it("never states a weight the service did not send", () => {
    // The whole point of publishing weights upstream is that a re-weighting
    // cannot leave a confident, wrong explanation in the app.
    render(
      <NearbyScoreExplainer
        breakdown={breakdown({
          components: [
            {
              key: "graph_authority",
              label: "Graph authority",
              value: 0.5,
              weight: 0.44,
              contribution: 0.22,
            },
          ],
        })}
      />,
    );

    expect(screen.getByText("50 · 44%")).toBeInTheDocument();
    expect(screen.queryByText(/30%/)).not.toBeInTheDocument();
  });
});


describe("capital access cannot be read as wealth", () => {
  const NOTE =
    "PUBLIC_PROFESSIONAL_RELATIONSHIP_ONLY; it is not a measure of personal wealth or ability to pay.";

  it("qualifies the component on the row itself", () => {
    // This screen is used by advisers judging whether someone can invest. A
    // bare "Capital access 64" invites exactly the wrong reading, and a
    // footnote elsewhere does not reach the person reading the number.
    render(<NearbyScoreExplainer breakdown={breakdown()} capitalAccessNote={NOTE} />);

    expect(screen.getByText("Capital access")).toBeInTheDocument();
    expect(
      screen.getByText("Professional relationships only — not wealth or ability to pay."),
    ).toBeInTheDocument();
  });

  it("qualifies only that component", () => {
    render(<NearbyScoreExplainer breakdown={breakdown()} capitalAccessNote={NOTE} />);

    expect(
      screen.getAllByText("Professional relationships only — not wealth or ability to pay."),
    ).toHaveLength(1);
  });

  it("never invents the qualification when the service did not send one", () => {
    // The wording exists because the service asserts it. Without that
    // assertion the app must not put words in its mouth.
    render(<NearbyScoreExplainer breakdown={breakdown()} />);

    expect(screen.getByText("Capital access")).toBeInTheDocument();
    expect(
      screen.queryByText(/not wealth or ability to pay/),
    ).not.toBeInTheDocument();
  });
});
