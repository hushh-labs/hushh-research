import { fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";

import {
  AgentFollowUpSuggestions,
  AgentSuggestionList,
  visibleFollowUps,
} from "@/components/agent/agent-follow-up-suggestions";

type Message = {
  id: string;
  role: "user" | "assistant";
  status?: "streaming" | "done" | "error";
  followUps?: string[];
};

const FOLLOW_UPS = ["Find a free hour after 2pm", "Move standup to 9:30"];

/** Chips below each bubble invoke turn submission into chat directly. */
function Transcript({
  messages,
  busy = false,
  disabled = false,
  onSend,
}: {
  messages: Message[];
  busy?: boolean;
  disabled?: boolean;
  onSend?: (text: string) => void;
}) {
  const [chatLog, setChatLog] = useState<string[]>([]);
  return (
    <>
      {messages.map((message) => (
        <AgentFollowUpSuggestions
          key={message.id}
          suggestions={visibleFollowUps(message, messages.at(-1)?.id, busy)}
          disabled={disabled}
          onSelect={(suggestion) => {
            setChatLog((prev) => [...prev, suggestion]);
            onSend?.(suggestion);
          }}
        />
      ))}
      <div data-testid="chat-turns">{chatLog.join(",")}</div>
    </>
  );
}

const answered: Message[] = [
  { id: "u-1", role: "user", status: "done" },
  { id: "a-1", role: "assistant", status: "done", followUps: FOLLOW_UPS },
];

describe("smart follow-ups", () => {
  it.each(["Other", "Others", "Something else"])("keeps %s on the ordinary follow-up path", (choice) => {
    const select = vi.fn();
    render(<AgentFollowUpSuggestions suggestions={[choice]} onSelect={select} />);
    fireEvent.click(screen.getByRole("button", { name: choice }));
    expect(select).toHaveBeenCalledExactlyOnceWith(choice);
  });

  it("does not accept a starter while disabled and resumes after the owner enables it", () => {
    const select = vi.fn();
    const props = {
      suggestions: FOLLOW_UPS,
      label: "Suggestions",
      testId: "agent-chat-suggestions",
      layout: "starter-grid" as const,
      onSelect: select,
    };
    const { rerender } = render(<AgentSuggestionList {...props} disabled />);
    const button = screen.getByRole("button", { name: FOLLOW_UPS[0] });
    expect(screen.getByRole("group", { name: "Suggestions" })).toBeInTheDocument();
    expect(button).toBeDisabled();
    fireEvent.click(button);
    expect(select).not.toHaveBeenCalled();

    rerender(<AgentSuggestionList {...props} />);
    fireEvent.click(screen.getByRole("button", { name: FOLLOW_UPS[0] }));
    expect(select).toHaveBeenCalledExactlyOnceWith(FOLLOW_UPS[0]);
  });

  it("renders the latest answer's chips and submits a selected recommendation directly into the chat", () => {
    const onSend = vi.fn();
    render(<Transcript messages={answered} onSend={onSend} />);
    const group = screen.getByRole("group", { name: "Suggested follow-ups" });
    expect(Array.from(group.querySelectorAll("button"), (button) => button.textContent)).toEqual(FOLLOW_UPS);

    fireEvent.click(screen.getByRole("button", { name: "Move standup to 9:30" }));
    expect(onSend).toHaveBeenCalledExactlyOnceWith("Move standup to 9:30");
    expect(screen.getByTestId("chat-turns")).toHaveTextContent("Move standup to 9:30");
  });

  it("does not submit recommendation when AgentFollowUpSuggestions is disabled", () => {
    const onSend = vi.fn();
    render(<Transcript messages={answered} disabled onSend={onSend} />);
    const button = screen.getByRole("button", { name: FOLLOW_UPS[0] });
    expect(button).toBeDisabled();
    fireEvent.click(button);
    expect(onSend).not.toHaveBeenCalled();
    expect(screen.getByTestId("chat-turns")).toBeEmptyDOMElement();
  });

  it("hides the chips once the next turn starts", () => {
    const { rerender } = render(<Transcript messages={answered} />);
    expect(screen.getByRole("group", { name: "Suggested follow-ups" })).toBeInTheDocument();

    const nextTurn: Message[] = [
      ...answered,
      { id: "u-2", role: "user", status: "done" },
      { id: "a-2", role: "assistant", status: "streaming" },
    ];
    rerender(<Transcript messages={nextTurn} busy />);
    expect(screen.queryByRole("group", { name: "Suggested follow-ups" })).toBeNull();

    // The next answer settles without calling the tool: still no chips.
    rerender(<Transcript messages={[...nextTurn.slice(0, 3), { id: "a-2", role: "assistant", status: "done" }]} />);
    expect(screen.queryByRole("group", { name: "Suggested follow-ups" })).toBeNull();
  });

  it("shows nothing while a turn is busy, for an error, or when the tool was not called", () => {
    expect(visibleFollowUps(answered[1], "a-1", true)).toEqual([]);
    expect(visibleFollowUps({ ...answered[1], status: "error" }, "a-1", false)).toEqual([]);
    expect(visibleFollowUps({ id: "a-1", role: "assistant", status: "done" }, "a-1", false)).toEqual([]);
    render(<Transcript messages={[answered[0], { id: "a-1", role: "assistant", status: "done" }]} />);
    expect(screen.queryByTestId("agent-follow-up-suggestions")).toBeNull();
  });

  it("handles empty lists, single items, special characters, and long text", () => {
    const onSend = vi.fn();
    const { rerender } = render(<AgentFollowUpSuggestions suggestions={[]} onSelect={onSend} />);
    expect(screen.queryByTestId("agent-follow-up-suggestions")).toBeNull();

    const complexPrompts = [
      "Can you verify my 💳 card & email? ✉️",
      "A very long prompt that describes a detailed query with many instructions to ensure wrapping works cleanly without throwing or breaking targets",
    ];
    rerender(<AgentFollowUpSuggestions suggestions={complexPrompts} onSelect={onSend} />);
    const buttons = screen.getAllByRole("button");
    expect(buttons).toHaveLength(2);
    fireEvent.click(buttons[0]);
    expect(onSend).toHaveBeenCalledWith(complexPrompts[0]);
  });
});
