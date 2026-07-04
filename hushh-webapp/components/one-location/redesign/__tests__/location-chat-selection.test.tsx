import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ChatMessageList } from "@/components/one-location/redesign/location-chat-message-list";

describe("location chat theme", () => {
  it("user bubble uses primary, not cream", () => {
    const { container } = render(
      <ChatMessageList
        busy={false}
        messages={[{ id: "1", role: "user", text: "Abdul Zalil" }]}
      />,
    );
    expect(container.innerHTML).not.toContain("#d4a574");
    expect(container.innerHTML).not.toContain("#b8894d");
  });

  it("selection message renders SelectionChip", () => {
    const { container } = render(
      <ChatMessageList
        busy={false}
        messages={[{ id: "2", role: "user", text: "Mom", kind: "selection" }]}
      />,
    );
    expect(container.querySelector('[data-testid="selection-chip"]')).toBeTruthy();
  });
});
