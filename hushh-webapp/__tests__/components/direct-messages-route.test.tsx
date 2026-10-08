import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { DirectMessagesRoute } from "@/components/direct-messages/direct-messages-route";

const mocks = vi.hoisted(() => ({
  query: "",
}));

vi.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams(mocks.query),
}));

vi.mock("@/components/direct-messages/direct-messages-page", () => ({
  DirectMessagesPage: () => <div data-testid="direct-message-thread" />,
}));

describe("DirectMessagesRoute", () => {
  beforeEach(() => {
    mocks.query = "";
  });

  it("renders the inbox at the bare messages address", () => {
    render(<DirectMessagesRoute />);

    expect(screen.getByTestId("direct-message-thread")).toBeVisible();
  });

  it.each(["person=connected-person", "conversation=conversation-opaque-1"])(
    "keeps a selected conversation route (%s)",
    (query) => {
      mocks.query = query;
      render(<DirectMessagesRoute />);

      expect(screen.getByTestId("direct-message-thread")).toBeVisible();
    },
  );
});
