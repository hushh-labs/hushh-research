import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { DirectMessagesRoute } from "@/components/direct-messages/direct-messages-route";

const mocks = vi.hoisted(() => ({
  query: "",
}));

vi.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams(mocks.query),
}));

vi.mock("@/components/navigation/client-redirect", () => ({
  ClientRedirect: ({ to }: { to: string }) => (
    <output data-testid="messages-route-redirect">{to}</output>
  ),
}));

vi.mock("@/components/direct-messages/direct-messages-page", () => ({
  DirectMessagesPage: () => <div data-testid="direct-message-thread" />,
}));

describe("DirectMessagesRoute", () => {
  beforeEach(() => {
    mocks.query = "";
  });

  it("returns the retired bare inbox address to Connect", () => {
    render(<DirectMessagesRoute />);

    expect(screen.getByTestId("messages-route-redirect")).toHaveTextContent(
      "/one/connect",
    );
    expect(screen.queryByTestId("direct-message-thread")).toBeNull();
  });

  it.each(["person=connected-person", "conversation=conversation-opaque-1"])(
    "keeps a selected conversation route (%s)",
    (query) => {
      mocks.query = query;
      render(<DirectMessagesRoute />);

      expect(screen.getByTestId("direct-message-thread")).toBeVisible();
      expect(screen.queryByTestId("messages-route-redirect")).toBeNull();
    },
  );
});
