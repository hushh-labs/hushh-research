import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";

import {
  LOCATION_SUGGESTION_CHIPS,
  SuggestionChips,
} from "@/components/one-location/redesign/location-chat-suggestions";

describe("SuggestionChips", () => {
  it("exposes exactly the four control-plane prompts", () => {
    expect(LOCATION_SUGGESTION_CHIPS.map((c) => c.label)).toEqual([
      "Who can see me?",
      "Stop sharing with…",
      "Ask someone to share",
      "Deny a request",
    ]);
  });

  it("sends unambiguous chips and prefills person-naming chips", () => {
    const onSend = vi.fn();
    const onPrefill = vi.fn();
    render(<SuggestionChips onSend={onSend} onPrefill={onPrefill} />);

    fireEvent.click(screen.getByRole("button", { name: "Who can see me?" }));
    expect(onSend).toHaveBeenCalledWith("Who can see me right now?");

    fireEvent.click(screen.getByRole("button", { name: "Stop sharing with…" }));
    expect(onPrefill).toHaveBeenCalledWith("Stop sharing with ");
    expect(onSend).toHaveBeenCalledTimes(1);
  });
});
