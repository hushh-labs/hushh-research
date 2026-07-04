import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ClarificationCard } from "@/components/one-location/redesign/clarification-card";
import { ActionConfirmCard } from "@/components/one-location/redesign/action-confirm-card";
import type { ClientAction, ClientPrompt } from "@/lib/one-location/types";

const prompt: ClientPrompt = {
  id: "p1",
  kind: "select",
  purpose: "recipient",
  question: "Who?",
  options: [{ label: "Mom", ref: { recipientUserId: "m" } }],
};
const action: ClientAction = {
  id: "a1",
  type: "publish_share",
  summary: "Share with Mom",
};
const noop = () => {};

describe("cards use primary theme", () => {
  it("ClarificationCard has no cream tokens", () => {
    const { container } = render(
      <ClarificationCard
        prompt={prompt}
        busy={false}
        onAnswer={noop}
        onConfirm={noop}
        onCancel={noop}
      />,
    );
    expect(container.innerHTML).not.toContain("#b8894d");
    expect(container.innerHTML).not.toContain("#d4a574");
  });

  it("ActionConfirmCard has no cream tokens", () => {
    const { container } = render(
      <ActionConfirmCard
        action={action}
        busy={false}
        onConfirm={noop}
        onCancel={noop}
      />,
    );
    expect(container.innerHTML).not.toContain("#b8894d");
    expect(container.innerHTML).not.toContain("#d4a574");
  });
});
