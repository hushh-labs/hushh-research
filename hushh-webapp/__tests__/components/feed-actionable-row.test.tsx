import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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

  it("shows a small green live dot before the description on a live SOS card only", () => {
    const { container: liveContainer } = render(
      <FeedActionableRow
        item={actionable({
          icon: Siren,
          iconTone: "red",
          emphasis: "emergency",
          title: "Mom triggered an SOS",
          description: "Emergency SMS - Sent.",
        })}
      />,
    );
    expect(liveContainer.querySelector(".bg-emerald-500")).not.toBeNull();

    const { container: revokedContainer } = render(
      <FeedActionableRow
        item={actionable({
          icon: Siren,
          iconTone: "red",
          title: "Mom triggered an SOS",
          description: "Emergency SMS - Revoked",
        })}
      />,
    );
    expect(revokedContainer.querySelector(".bg-emerald-500")).toBeNull();
  });

  it("renders a routine actionable without the emergency frame", () => {
    render(<FeedActionableRow item={actionable({ title: "Routine row" })} />);

    expect(screen.queryByTestId("feed-sms-emergency")).toBeNull();
    expect(screen.getByText("Routine row")).toBeInTheDocument();
  });

  it("renders a revoked SOS card as a plain row (no frame) but keeps the Siren/red icon signal", () => {
    const { container } = render(
      <FeedActionableRow
        item={actionable({
          icon: Siren,
          iconTone: "red",
          title: "Mom triggered an SOS",
          description: "Emergency SMS - Revoked",
          href: "/one/location?grantId=g1&open=1&section=shared",
          chevron: true,
          // No `emphasis` — this is the confirmed "downgrade to plain row" behavior.
        })}
      />,
    );

    expect(screen.queryByTestId("feed-sms-emergency")).toBeNull();
    expect(screen.getByText("Mom triggered an SOS")).toBeInTheDocument();
    expect(
      container.querySelector('[data-icon-tone="red"]'),
    ).not.toBeNull();
  });

  describe("time label", () => {
    beforeEach(() => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date(2026, 7, 12, 15, 45, 0));
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it("shows the formatted day/time label when displayTimestamp is set", () => {
      render(
        <FeedActionableRow
          item={actionable({
            title: "Has a time",
            displayTimestamp: new Date(2026, 7, 12, 15, 45, 0).getTime(),
          })}
        />,
      );

      expect(screen.getByText(/^Today - 3:45\s?PM$/i)).toBeInTheDocument();
    });

    it("shows no time label when displayTimestamp is null", () => {
      render(
        <FeedActionableRow
          item={actionable({ title: "No time", displayTimestamp: null })}
        />,
      );

      expect(screen.queryByText(/Today -|Yesterday -/i)).toBeNull();
    });

    it("shows no time label when displayTimestamp is absent", () => {
      render(<FeedActionableRow item={actionable({ title: "No time field" })} />);

      expect(screen.queryByText(/Today -|Yesterday -/i)).toBeNull();
    });

    it("keeps the spinning pulse dot and the time label together", () => {
      render(
        <FeedActionableRow
          item={actionable({
            title: "Running task",
            spinning: true,
            displayTimestamp: new Date(2026, 7, 12, 15, 45, 0).getTime(),
          })}
        />,
      );

      expect(screen.getByText(/^Today - 3:45\s?PM$/i)).toBeInTheDocument();
      expect(screen.getByText("Row description")).toBeInTheDocument();
    });
  });
});
