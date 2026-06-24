import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { AgentPkmReviewPanel } from "@/components/agent/agent-pkm-review-panel";
import type { AgentPkmPreviewCard } from "@/lib/agent/agent-pkm-memory";

function makeCard(overrides: Partial<AgentPkmPreviewCard> = {}): AgentPkmPreviewCard {
  return {
    card_id: "test-card-1",
    source_text: "Sample source text",
    write_mode: "confirm_first",
    ...overrides,
  };
}

describe("AgentPkmReviewPanel – add mode (default)", () => {
  it('shows "Save to PKM?" header when mode is add', () => {
    render(
      <AgentPkmReviewPanel
        cards={[makeCard()]}
        onSave={vi.fn()}
        onDismiss={vi.fn()}
      />
    );
    expect(screen.getByText("Save to PKM?")).toBeTruthy();
  });

  it('shows "Save" button label when mode is add', () => {
    render(
      <AgentPkmReviewPanel
        cards={[makeCard()]}
        onSave={vi.fn()}
        onDismiss={vi.fn()}
      />
    );
    expect(screen.getByText("Save")).toBeTruthy();
  });

  it('shows "needs your review before it is stored" description when mode is add', () => {
    render(
      <AgentPkmReviewPanel
        cards={[makeCard()]}
        onSave={vi.fn()}
        onDismiss={vi.fn()}
      />
    );
    expect(
      screen.getByText(/needs your review before it is stored/)
    ).toBeTruthy();
  });

  it("renders identically with no mode/updateContext props (regression)", () => {
    render(
      <AgentPkmReviewPanel
        cards={[makeCard()]}
        onSave={vi.fn()}
        onDismiss={vi.fn()}
      />
    );
    expect(screen.getByText("Save to PKM?")).toBeTruthy();
    expect(screen.getByText("Save")).toBeTruthy();
  });
});

describe("AgentPkmReviewPanel – update mode", () => {
  const updateContext = {
    domain: "personal",
    fieldPath: "contact.name",
    currentValue: "Alice",
    proposedValue: "Bob",
  };

  it('shows "Update PKM?" header when mode is update', () => {
    render(
      <AgentPkmReviewPanel
        cards={[]}
        mode="update"
        updateContext={updateContext}
        onSave={vi.fn()}
        onDismiss={vi.fn()}
      />
    );
    expect(screen.getByText("Update PKM?")).toBeTruthy();
  });

  it('shows description containing "proposes a change to your saved record" when mode is update', () => {
    render(
      <AgentPkmReviewPanel
        cards={[]}
        mode="update"
        updateContext={updateContext}
        onSave={vi.fn()}
        onDismiss={vi.fn()}
      />
    );
    expect(
      screen.getByText(/proposes a change to your saved record/)
    ).toBeTruthy();
  });

  it('shows "Current" and "Proposed" labels in diff block when mode is update', () => {
    render(
      <AgentPkmReviewPanel
        cards={[]}
        mode="update"
        updateContext={updateContext}
        onSave={vi.fn()}
        onDismiss={vi.fn()}
      />
    );
    expect(screen.getByText("Current")).toBeTruthy();
    expect(screen.getByText("Proposed")).toBeTruthy();
  });

  it("shows currentValue and proposedValue in diff block", () => {
    render(
      <AgentPkmReviewPanel
        cards={[]}
        mode="update"
        updateContext={updateContext}
        onSave={vi.fn()}
        onDismiss={vi.fn()}
      />
    );
    expect(screen.getByText("Alice")).toBeTruthy();
    expect(screen.getByText("Bob")).toBeTruthy();
  });

  it('shows "Update" button label when mode is update', () => {
    render(
      <AgentPkmReviewPanel
        cards={[]}
        mode="update"
        updateContext={updateContext}
        onSave={vi.fn()}
        onDismiss={vi.fn()}
      />
    );
    expect(screen.getByText("Update")).toBeTruthy();
  });

  it("does NOT return null when mode is update and cards.length === 0", () => {
    const { container } = render(
      <AgentPkmReviewPanel
        cards={[]}
        mode="update"
        updateContext={updateContext}
        onSave={vi.fn()}
        onDismiss={vi.fn()}
      />
    );
    expect(container.firstChild).not.toBeNull();
  });
});
