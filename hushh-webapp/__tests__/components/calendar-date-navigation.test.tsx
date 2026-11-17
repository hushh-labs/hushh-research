import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { CalendarDateNavigation } from "@/components/calendar/calendar-date-navigation";

describe("CalendarDateNavigation", () => {
  it("keeps Today between the day arrows and marks it only while today is selected", () => {
    const onChange = vi.fn();
    const { rerender } = render(<CalendarDateNavigation date="2026-10-21" today="2026-10-21" onChange={onChange} />);
    const group = screen.getByRole("group", { name: "Change day" });
    expect(within(group).getAllByRole("button").map(button => button.getAttribute("aria-label") || button.textContent)).toEqual(["Previous day", "Today", "Next day"]);
    expect(screen.getByRole("button", { name: "Today" })).toHaveAttribute("aria-current", "date");
    fireEvent.click(screen.getByRole("button", { name: "Next day" }));
    expect(onChange).toHaveBeenLastCalledWith("2026-10-22");

    rerender(<CalendarDateNavigation date="2026-10-22" today="2026-10-21" onChange={onChange} />);
    expect(screen.getByRole("button", { name: "Today" })).not.toHaveAttribute("aria-current");
    fireEvent.click(screen.getByRole("button", { name: "Today" }));
    expect(onChange).toHaveBeenLastCalledWith("2026-10-21");
    fireEvent.click(screen.getByRole("button", { name: "Previous day" }));
    expect(onChange).toHaveBeenLastCalledWith("2026-10-21");
  });
});
