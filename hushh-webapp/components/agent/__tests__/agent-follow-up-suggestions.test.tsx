import { fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it } from "vitest";

import {
  AgentFollowUpSuggestions,
  visibleFollowUps,
} from "@/components/agent/agent-follow-up-suggestions";

type Message = {
  id: string;
  role: "user" | "assistant";
  status?: "streaming" | "done" | "error";
  followUps?: string[];
};

const FOLLOW_UPS = ["Find a free hour after 2pm", "Move standup to 9:30"];

/** The workspace's wiring: chips under each bubble, a tap fills the composer. */
function Transcript({ messages, busy = false }: { messages: Message[]; busy?: boolean }) {
  const [draft, setDraft] = useState("");
  return (
    <>
      {messages.map((message) => (
        <AgentFollowUpSuggestions
          key={message.id}
          suggestions={visibleFollowUps(message, messages.at(-1)?.id, busy)}
          onSelect={setDraft}
        />
      ))}
      <textarea aria-label="Message" value={draft} readOnly />
    </>
  );
}

const answered: Message[] = [
  { id: "u-1", role: "user", status: "done" },
  { id: "a-1", role: "assistant", status: "done", followUps: FOLLOW_UPS },
];

describe("smart follow-ups", () => {
  it("renders the latest answer's chips and a tap fills the composer", () => {
    render(<Transcript messages={answered} />);
    const group = screen.getByRole("group", { name: "Suggested follow-ups" });
    expect(Array.from(group.querySelectorAll("button"), (button) => button.textContent)).toEqual(FOLLOW_UPS);

    fireEvent.click(screen.getByRole("button", { name: "Move standup to 9:30" }));
    expect(screen.getByRole("textbox", { name: "Message" })).toHaveValue("Move standup to 9:30");
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
});
