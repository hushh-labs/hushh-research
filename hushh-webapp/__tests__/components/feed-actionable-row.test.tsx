import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { MapPin, Siren } from "lucide-react";

import { FeedActionableRow } from "@/components/feed/feed-actionable-row";
import type { FeedActionable } from "@/lib/feed/use-feed-actionables";

function actionable(overrides: Partial<FeedActionable> = {}): FeedActionable {
  return {
    id: "a-1",
    icon: MapPin,
    iconTone: "blue",
    title: "Row title",
    description: "Row description",
    actions: [],
    sortAt: 0,
    ...overrides,
  };
}

describe("FeedActionableRow", () => {
  it("wraps an emergency SMS alert in a prominent red alert frame", () => {
    render(
      <FeedActionableRow
        item={actionable({
          icon: Siren,
          iconTone: "red",
          emphasis: "emergency",
          title: "Mom triggered an SOS",
          description: "Emergency SMS — sharing live location with you now.",
          href: "/one/location?grantId=g1&open=1&section=shared",
          chevron: true,
        })}
      />,
    );

    const frame = screen.getByTestId("feed-sms-emergency");
    expect(frame).toHaveAttribute("role", "alert");
    expect(frame).toHaveClass("border-destructive/45");
    expect(screen.getByText("Mom triggered an SOS")).toBeInTheDocument();
  });

  it("renders a routine actionable without the emergency frame", () => {
    render(<FeedActionableRow item={actionable({ title: "Routine row" })} />);

    expect(screen.queryByTestId("feed-sms-emergency")).toBeNull();
    expect(screen.getByText("Routine row")).toBeInTheDocument();
  });
});
