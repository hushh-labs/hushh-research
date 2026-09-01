import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { MapPin } from "lucide-react";

import { FeedRow } from "@/components/feed/feed-row";
import type { FeedItem } from "@/lib/services/feed-service";

vi.mock("@/lib/feed/feed-item-renderers", () => ({
  presentFeedItem: (item: FeedItem) => ({
    icon: MapPin,
    domainLabel: "Location",
    label: "Someone shared location",
    description: "A routine location share.",
    href: item.metadata.hrefEnabled ? "/one/location" : null,
    person: null,
  }),
}));

function feedItem(overrides: Partial<FeedItem> = {}): FeedItem {
  return {
    id: "item-1",
    source_domain: "location",
    event_type: "location_share_created",
    actor_label: "A contact",
    metadata: {},
    read: false,
    created_at: "2026-08-12T15:45:00.000Z",
    ...overrides,
  };
}

describe("FeedRow", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-12T15:50:00.000Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("shows the local time label next to the description", () => {
    render(<FeedRow item={feedItem()} onOpen={() => {}} />);

    expect(screen.getAllByText(/^\d{2}:\d{2}\s?[AP]M$/i).length).toBeGreaterThan(
      0,
    );
    expect(screen.getByText("A routine location share.")).toBeInTheDocument();
  });

  it("never renders the old relative time format", () => {
    render(<FeedRow item={feedItem()} onOpen={() => {}} />);

    expect(screen.queryByText(/^\d+[mhd]$/)).toBeNull();
    expect(screen.queryByText(/^Today -/)).toBeNull();
    expect(screen.queryByText("now")).toBeNull();
  });

  it("shows the unread dot when the item is unread", () => {
    render(<FeedRow item={feedItem({ read: false })} onOpen={() => {}} />);

    expect(screen.getByText("Unread:")).toHaveClass("sr-only");
  });

  it("does not show the unread dot when the item is read", () => {
    render(<FeedRow item={feedItem({ read: true })} onOpen={() => {}} />);

    expect(screen.queryByText("Unread:")).toBeNull();
  });

  it("shows a chevron and opens the item when a href is present", () => {
    const onOpen = vi.fn();
    render(
      <FeedRow
        item={feedItem({ metadata: { hrefEnabled: true } })}
        onOpen={onOpen}
      />,
    );

    screen
      .getByText("Someone shared location")
      .closest("button")
      ?.click();
    expect(onOpen).toHaveBeenCalledOnce();
  });
});
