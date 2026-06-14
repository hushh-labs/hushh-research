import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { MarketHeadlinesRail } from "@/components/kai/views/kai-market-preview-view";
import type { KaiHomeNewsItem } from "@/lib/services/api-service";

vi.mock("@/components/ui/hover-card", () => ({
  HoverCard: ({ children }: any) => <div>{children}</div>,
  HoverCardTrigger: ({ children }: any) => <div>{children}</div>,
  HoverCardContent: ({ children }: any) => <div>{children}</div>,
}));

function makeNewsItem(
  overrides: Partial<KaiHomeNewsItem> = {}
): KaiHomeNewsItem {
  return {
    symbol: "NVDA",
    title: "Nvidia announces new architecture",
    url: "https://example.com/news",
    published_at: "2026-05-15T12:00:00Z",
    source_name: "Tech News",
    provider: "news_api",
    degraded: false,
    ...overrides,
  };
}

describe("MarketHeadlinesRail", () => {
  it("renders the sentiment hint when provided by the canonical caller", () => {
    const rows = [
      makeNewsItem({
        sentiment_hint: "Kai analysis indicates strong positive momentum.",
      }),
    ];

    render(<MarketHeadlinesRail rows={rows} />);

    expect(screen.getByText("Kai analysis indicates strong positive momentum.")).toBeTruthy();
    expect(screen.getByText("Kai quick scan")).toBeTruthy();
  });

  it("renders a fallback message when sentiment hint is not available", () => {
    const rows = [
      makeNewsItem({
        sentiment_hint: null,
      }),
    ];

    render(<MarketHeadlinesRail rows={rows} />);

    expect(screen.getByText("No analysis available for this headline.")).toBeTruthy();
    expect(screen.queryByText("Kai quick scan")).toBeNull();
  });

  it("handles empty state gracefully", () => {
    const { container } = render(<MarketHeadlinesRail rows={[]} />);
    expect(container.textContent).toContain(
      "No recent market headlines are available right now."
    );
  });
});
