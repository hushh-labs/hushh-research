import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";

import { ChatComposer } from "@/components/one-location/redesign/location-chat-composer";

describe("ChatComposer", () => {
  it("sends on Enter but not on Shift+Enter", () => {
    const onSend = vi.fn();
    render(
      <ChatComposer value="hi" onChange={() => {}} onSend={onSend} busy={false} />,
    );
    const input = screen.getByTestId("location-chat-input");

    fireEvent.keyDown(input, { key: "Enter", shiftKey: true });
    expect(onSend).not.toHaveBeenCalled();

    fireEvent.keyDown(input, { key: "Enter" });
    expect(onSend).toHaveBeenCalledTimes(1);
  });

  it("clicking Send fires onSend; busy disables both controls", () => {
    const onSend = vi.fn();
    const { rerender } = render(
      <ChatComposer value="hi" onChange={() => {}} onSend={onSend} busy={false} />,
    );
    fireEvent.click(screen.getByTestId("location-chat-send"));
    expect(onSend).toHaveBeenCalledTimes(1);

    rerender(
      <ChatComposer value="hi" onChange={() => {}} onSend={onSend} busy />,
    );
    expect((screen.getByTestId("location-chat-send") as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByTestId("location-chat-input") as HTMLTextAreaElement).disabled).toBe(true);
  });
});
