import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { AgentPkmReviewPanel } from "@/components/agent/agent-pkm-review-panel";
import type { AgentPkmPreviewCard } from "@/lib/agent/agent-pkm-memory";

function card(id: string, domain: string, scope: string, text: string): AgentPkmPreviewCard {
  return {
    card_id: id,
    source_text: text,
    write_mode: "confirm_first",
    target_domain: domain,
    primary_json_path: scope,
    structure_decision: { target_domain: domain, action: "create_entity" },
  } as unknown as AgentPkmPreviewCard;
}

const CARDS = [
  card("c1", "food", "preferences.breakfast", "I prefer early breakfasts."),
  card("c2", "food", "preferences.dinner", "I usually order the vegetarian option."),
  card("c3", "professional", "profile.typing_speed", "I type at about 85 WPM."),
];

describe("AgentPkmReviewPanel", () => {
  it("groups a multi-destination review by domain and scope with per-item keep/skip", () => {
    const onToggleCard = vi.fn();
    const onToggleGroup = vi.fn();
    render(
      <AgentPkmReviewPanel
        cards={CARDS}
        selectedCardIds={new Set(["c1", "c3"])}
        onToggleCard={onToggleCard}
        onToggleGroup={onToggleGroup}
        onSave={vi.fn()}
        onDismiss={vi.fn()}
      />,
    );
    expect(screen.getAllByTestId("agent-pkm-review-group")).toHaveLength(3);
    expect(screen.getByTestId("agent-pkm-review-save")).toHaveTextContent("Save 2 of 3");
    const boxes = screen.getAllByRole("checkbox");
    expect(boxes.map((box) => (box as HTMLInputElement).checked)).toEqual([true, false, true]);
    fireEvent.click(boxes[1]!);
    expect(onToggleCard).toHaveBeenCalledWith("c2", true);
    fireEvent.click(screen.getAllByRole("button", { name: /Skip group|Keep group/ })[0]!);
    expect(onToggleGroup).toHaveBeenCalledWith(["c1"], false);
  });

  it("saves everything by default and disables Save when nothing is kept", () => {
    const { rerender } = render(
      <AgentPkmReviewPanel cards={CARDS} onToggleCard={vi.fn()} onSave={vi.fn()} onDismiss={vi.fn()} />,
    );
    expect(screen.getByTestId("agent-pkm-review-save")).toHaveTextContent("Save all 3");
    rerender(
      <AgentPkmReviewPanel cards={CARDS} selectedCardIds={new Set()} onToggleCard={vi.fn()} onSave={vi.fn()} onDismiss={vi.fn()} />,
    );
    expect(screen.getByTestId("agent-pkm-review-save")).toBeDisabled();
  });

  it("keeps the single-destination layout when every card lands in one place", () => {
    const same = card("c4", "food", "preferences.breakfast", "Breakfast before eight.");
    render(<AgentPkmReviewPanel cards={[CARDS[0]!, same]} onSave={vi.fn()} onDismiss={vi.fn()} />);
    expect(screen.queryAllByRole("checkbox")).toHaveLength(0);
    expect(screen.getAllByTestId("agent-pkm-review-group")).toHaveLength(1);
    expect(screen.getAllByText(/Private to your private agent/)).toHaveLength(2);
  });
});
