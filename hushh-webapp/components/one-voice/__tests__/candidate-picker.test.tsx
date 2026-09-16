import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  CandidatePicker,
  candidateDisambiguator,
  candidateId,
} from "@/components/one-voice/candidate-picker";
import type { CandidatePickerView } from "@/lib/one-voice/session-types";

afterEach(() => cleanup());

const picker: CandidatePickerView = {
  kind: "person",
  question: "Which Alex did you mean?",
  candidates: [
    {
      user_id: "usr_alex_one_9a8b",
      display_name: "Alex Chen",
      photo_url: null,
      relationship: "connected",
      has_location_key: true,
      match_tier: 1,
    },
    {
      user_id: "usr_alex_two_1c2d",
      display_name: "Alex Rivera",
      photo_url: "https://cdn.example/alex.jpg",
      relationship: "pending_outgoing",
      has_location_key: false,
      match_tier: 2,
    },
    { display_name: "No id at all" },
  ],
};

describe("CandidatePicker", () => {
  it("renders one single-select row per candidate the server sent, without ids", () => {
    const { container } = render(
      <CandidatePicker picker={picker} onPick={vi.fn()} onNone={vi.fn()} />,
    );
    expect(screen.getByText("Which Alex did you mean?")).toBeInTheDocument();
    const rows = screen.getAllByRole("radio");
    // The candidate without a canonical id cannot be chosen, so it is not offered.
    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveAccessibleName(
      "Alex Chen, Connected · Ready for location",
    );
    expect(rows[1]).toHaveAccessibleName("Alex Rivera, Request pending");
    expect(container.textContent).not.toContain("usr_alex_one_9a8b");
    expect(container.textContent).not.toContain("usr_alex_two_1c2d");
    expect(container.innerHTML).not.toContain("usr_alex_one_9a8b");
  });

  it("hands back the canonical id on pick and none:true on 'None of these'", () => {
    const onPick = vi.fn();
    const onNone = vi.fn();
    render(
      <CandidatePicker
        picker={picker}
        onPick={onPick}
        onNone={onNone}
        selectedId="usr_alex_two_1c2d"
      />,
    );
    fireEvent.click(screen.getAllByRole("radio")[0]!);
    expect(onPick).toHaveBeenCalledWith("usr_alex_one_9a8b");
    expect(screen.getAllByRole("radio")[1]).toHaveAttribute(
      "aria-checked",
      "true",
    );
    fireEvent.click(screen.getByTestId("one-voice-candidate-none"));
    expect(onNone).toHaveBeenCalledTimes(1);
  });

  it("keeps 44pt targets and a group label", () => {
    render(
      <CandidatePicker picker={picker} onPick={vi.fn()} onNone={vi.fn()} />,
    );
    expect(screen.getByRole("radiogroup")).toHaveAccessibleName(
      "Which Alex did you mean?",
    );
    for (const row of screen.getAllByRole("radio"))
      expect(row.className).toContain("min-h-11");
    expect(screen.getByTestId("one-voice-candidate-none").className).toContain(
      "min-h-11",
    );
  });

  it("derives ids and disambiguators per kind", () => {
    expect(candidateId("person", { user_id: "u1" })).toBe("u1");
    expect(candidateId("circle", { circle_id: "c1", user_id: "u1" })).toBe(
      "c1",
    );
    expect(candidateId("circle", { user_id: "u1" })).toBeNull();
    expect(candidateDisambiguator("person", { relationship: "none" })).toBe(
      "Not connected",
    );
    expect(
      candidateDisambiguator("circle", {
        relationship: "connected",
        has_location_key: true,
      }),
    ).toBe("");
  });
});
