import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";

import { ChatMessageList } from "@/components/one-location/redesign/location-chat-message-list";

describe("ChatMessageList", () => {
  it("renders user and assistant text and the state-changed note", () => {
    render(
      <ChatMessageList
        busy={false}
        messages={[
          { id: "1", role: "user", text: "stop sharing with Mom" },
          { id: "2", role: "assistant", text: "Stopped sharing with Mom.", stateChanged: true },
        ]}
      />,
    );

    expect(screen.getByText("stop sharing with Mom")).toBeTruthy();
    expect(screen.getByText("Stopped sharing with Mom.")).toBeTruthy();
    expect(screen.getByText(/Updated — your sharing list refreshed\./)).toBeTruthy();
  });

  it("shows the typing indicator while busy", () => {
    render(<ChatMessageList busy messages={[]} />);
    expect(screen.getByTestId("location-chat-typing")).toBeTruthy();
  });

  it("renders Retry on errored messages and calls onRetry", () => {
    const onRetry = vi.fn();
    render(
      <ChatMessageList
        busy={false}
        onRetry={onRetry}
        messages={[
          { id: "1", role: "user", text: "do it" },
          { id: "2", role: "assistant", text: "Sorry — failed.", errored: true },
        ]}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /retry/i }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });
});
