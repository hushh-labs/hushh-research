import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { Button } from "@/components/ui/button";
import { OneStreamEventCard } from "@/components/agent/specialist-directive-card";
import { ReferenceStorybook } from "@/components/design-system/reference-storybook";

describe("Core design system craft reset & Reference-Design Storybook", () => {
  it("applies sleek global Button heights and refined hairline geometry", () => {
    render(
      <div>
        <Button>Save changes</Button>
        <Button size="compact" variant="outline">
          Optimize memory
        </Button>
        <Button size="prominent">Confirm order</Button>
        <Button size="row" variant="secondary">
          Switch
        </Button>
      </div>,
    );

    const standardBtn = screen.getByRole("button", { name: "Save changes" });
    expect(standardBtn).toHaveClass("h-9", "min-h-9", "rounded-[10px]");
    expect(standardBtn.className).not.toContain("h-[50px]");

    const compactBtn = screen.getByRole("button", { name: "Optimize memory" });
    expect(compactBtn).toHaveClass("h-8", "min-h-8", "rounded-[9px]");

    const prominentBtn = screen.getByRole("button", { name: "Confirm order" });
    expect(prominentBtn).toHaveClass("h-10", "min-h-10", "rounded-[11px]");

    const rowBtn = screen.getByRole("button", { name: "Switch" });
    expect(rowBtn).toHaveClass("h-7", "rounded-full");
  });

  it("renders OneStreamEventCard as a compact tactile row with semantic badge and inline compact action", () => {
    const onOpen = vi.fn();
    render(
      <OneStreamEventCard
        item={{
          id: "evt-1",
          eventKind: "shared_access_unlocked",
          actorLabel: "Kushal Trivedi",
          headline: "Kushal Trivedi shared access",
          detail: "Financial · Investment Portfolio · 7 days · Decrypted on this device",
          href: "/one/consent?tab=active",
          status: "pending",
        }}
        onOpen={onOpen}
      />,
    );

    const card = screen.getByTestId("one-stream-event-card");
    expect(card).toHaveClass("sm:flex-row", "sm:items-center", "sm:justify-between");
    expect(screen.getByTestId("one-stream-event-badge")).toHaveTextContent("Encrypted");
    expect(screen.getByText("Kushal Trivedi shared access")).toBeVisible();
    expect(
      screen.getByText("Financial · Investment Portfolio · 7 days · Decrypted on this device"),
    ).toBeVisible();

    const openBtn = screen.getByTestId("one-stream-event-open");
    expect(openBtn).toHaveClass("h-8", "rounded-[9px]");
    fireEvent.click(openBtn);
    expect(onOpen).toHaveBeenCalledTimes(1);
  });

  it("renders the Reference-Design Storybook with interactive viewport and surface controls", () => {
    render(<ReferenceStorybook />);

    expect(screen.getByTestId("reference-design-storybook-page")).toBeVisible();
    expect(screen.getByTestId("storybook-controls-bar")).toBeVisible();
    expect(screen.getByText("Sleek Global Button Scale & Toolbar Alignment")).toBeVisible();
    expect(screen.getByText("Universal Raised-Cosine Progressive Mask Fade")).toBeVisible();
    expect(screen.getByText("Living Confidential Sandbox Hero Card")).toBeVisible();
    expect(screen.getByText("Compact Tactile Shared-Access & Settlement Cards")).toBeVisible();
    expect(screen.getByText("Tabular Metric Strip & Brokerage Holdings Table")).toBeVisible();

    fireEvent.click(screen.getByRole("button", { name: "360px phone" }));
    fireEvent.click(screen.getByRole("button", { name: "Dark" }));
    fireEvent.click(screen.getByRole("button", { name: "Optimize memory" }));
    expect(screen.getByTestId("storybook-last-action")).toHaveTextContent("Optimize memory");
    expect(screen.getByTestId("shared-with-you-chat-summary")).toBeVisible();
    expect(screen.queryByTestId("shared-with-you-values")).toBeNull();
    fireEvent.click(screen.getByTestId("shared-with-you-view-details"));
    expect(screen.getByTestId("shared-with-you-detail-modal")).toBeVisible();
  });
});
