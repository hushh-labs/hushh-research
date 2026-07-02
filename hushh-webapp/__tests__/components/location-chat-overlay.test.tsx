import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";

import { LocationChatOverlay } from "@/components/one-location/redesign/location-chat-overlay";

// Force the desktop (Dialog) branch for deterministic rendering in jsdom.
vi.mock("@/hooks/use-mobile", () => ({ useIsMobile: () => false }));

describe("LocationChatOverlay", () => {
  it("renders the conversation when open", () => {
    render(
      <LocationChatOverlay
        open
        onOpenChange={() => {}}
        busy={false}
        value=""
        onChange={() => {}}
        onSend={() => {}}
        messages={[{ id: "1", role: "assistant", text: "Mom and Dad." }]}
      />,
    );
    expect(screen.getByText("Mom and Dad.")).toBeTruthy();
    expect(screen.getByTestId("location-chat-input")).toBeTruthy();
  });

  it("renders nothing visible when closed", () => {
    render(
      <LocationChatOverlay
        open={false}
        onOpenChange={() => {}}
        busy={false}
        value=""
        onChange={() => {}}
        onSend={() => {}}
        messages={[{ id: "1", role: "assistant", text: "hidden" }]}
      />,
    );
    expect(screen.queryByText("hidden")).toBeNull();
  });
});
