import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";

import { ClarificationCard } from "@/components/one-location/redesign/clarification-card";
import type { ClientPrompt } from "@/lib/one-location/types";

const selectPrompt: ClientPrompt = {
  id: "prm-1",
  kind: "select",
  purpose: "select_share",
  question: "Which to stop?",
  options: [
    { label: "Mom", ref: { grantId: "g1" } },
    { label: "Dad", ref: { grantId: "g2" } },
  ],
  maxSelections: null,
  minSelections: 1,
};

const singlePickPrompt: ClientPrompt = {
  id: "prm-2",
  kind: "select",
  purpose: "select_share",
  question: "Pick one to stop?",
  options: [
    { label: "Mom", ref: { grantId: "g1" } },
    { label: "Dad", ref: { grantId: "g2" } },
  ],
  maxSelections: 1,
  minSelections: 1,
};

const confirmPromptData: ClientPrompt = {
  id: "p",
  kind: "confirm",
  purpose: "confirm_action",
  question: "Stop all?",
  destructive: true,
};

describe("ClarificationCard", () => {
  it("renders with clarification-card testid", () => {
    render(
      <ClarificationCard
        prompt={selectPrompt}
        busy={false}
        onAnswer={vi.fn()}
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    expect(screen.getByTestId("clarification-card")).toBeTruthy();
  });

  it("renders the question text", () => {
    render(
      <ClarificationCard
        prompt={selectPrompt}
        busy={false}
        onAnswer={vi.fn()}
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    expect(screen.getByText("Which to stop?")).toBeTruthy();
  });

  it("multi-select: ticks options and answers with their refs", () => {
    const onAnswer = vi.fn();
    render(
      <ClarificationCard
        prompt={selectPrompt}
        busy={false}
        onAnswer={onAnswer}
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByText("Mom"));
    fireEvent.click(screen.getByText("Dad"));
    fireEvent.click(screen.getByTestId("clarification-confirm"));
    expect(onAnswer).toHaveBeenCalledWith([{ grantId: "g1" }, { grantId: "g2" }]);
  });

  it("confirm prompt: Yes calls onConfirm(true)", () => {
    const onConfirm = vi.fn();
    render(
      <ClarificationCard
        prompt={confirmPromptData}
        busy={false}
        onAnswer={vi.fn()}
        onConfirm={onConfirm}
        onCancel={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByTestId("clarification-confirm"));
    expect(onConfirm).toHaveBeenCalledWith(true);
  });

  it("single-pick: auto-answers immediately on tap without Confirm click", () => {
    const onAnswer = vi.fn();
    render(
      <ClarificationCard
        prompt={singlePickPrompt}
        busy={false}
        onAnswer={onAnswer}
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByText("Mom"));
    expect(onAnswer).toHaveBeenCalledWith([{ grantId: "g1" }]);
  });

  it("does NOT auto-answer on render — onAnswer not called without a click", () => {
    const onAnswer = vi.fn();
    render(
      <ClarificationCard
        prompt={selectPrompt}
        busy={false}
        onAnswer={onAnswer}
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    expect(onAnswer).not.toHaveBeenCalled();
  });

  it("cancel calls onCancel", () => {
    const onCancel = vi.fn();
    render(
      <ClarificationCard
        prompt={selectPrompt}
        busy={false}
        onAnswer={vi.fn()}
        onConfirm={vi.fn()}
        onCancel={onCancel}
      />,
    );
    fireEvent.click(screen.getByTestId("clarification-cancel"));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it("confirm button is disabled when nothing is selected (multi-select)", () => {
    render(
      <ClarificationCard
        prompt={selectPrompt}
        busy={false}
        onAnswer={vi.fn()}
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    const confirmBtn = screen.getByTestId("clarification-confirm") as HTMLButtonElement;
    expect(confirmBtn.disabled).toBe(true);
  });

  it("disables cancel button when busy", () => {
    render(
      <ClarificationCard
        prompt={selectPrompt}
        busy={true}
        onAnswer={vi.fn()}
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    const cancelBtn = screen.getByTestId("clarification-cancel") as HTMLButtonElement;
    expect(cancelBtn.disabled).toBe(true);
  });

  it("renders option pills for select kind", () => {
    render(
      <ClarificationCard
        prompt={selectPrompt}
        busy={false}
        onAnswer={vi.fn()}
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    const options = screen.getAllByTestId("clarification-option");
    expect(options.length).toBe(2);
  });
});
