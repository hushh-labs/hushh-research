import { useState } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { MobileDocumentDateRange } from "@/components/consent/mobile-document-date-range";

afterEach(cleanup);

function RequestDates() {
  const [start, setStart] = useState("");
  const [end, setEnd] = useState("");
  return (
    <MobileDocumentDateRange
      start={start}
      end={end}
      onStartChange={setStart}
      onEndChange={setEnd}
    />
  );
}

it("requires two deliberate taps and prevents an end before the start", () => {
  render(<RequestDates />);
  fireEvent.click(screen.getByRole("button", { name: "Start date: Choose date" }));
  fireEvent.change(screen.getByRole("combobox", { name: "Year" }), { target: { value: "2026" } });
  fireEvent.change(screen.getByRole("combobox", { name: "Month" }), { target: { value: "8" } });
  fireEvent.click(screen.getByRole("button", { name: "Tuesday, September 29, 2026" }));
  expect(screen.getByRole("button", { name: "Start date: Sep 29, 2026" })).toBeVisible();
  expect(screen.getByRole("button", { name: "End date: Choose date" })).toHaveFocus();
  expect(screen.getByRole("group", { name: "Choose end date" })).toBeVisible();
  expect(screen.getByRole("button", { name: "Monday, September 28, 2026" })).toBeDisabled();
  fireEvent.change(screen.getByRole("combobox", { name: "Month" }), { target: { value: "9" } });
  fireEvent.click(screen.getByRole("button", { name: "Thursday, October 1, 2026" }));
  expect(screen.getByRole("button", { name: "End date: Oct 1, 2026" })).toBeVisible();
  expect(screen.getByRole("button", { name: "End date: Oct 1, 2026" })).toHaveFocus();
  expect(screen.queryByRole("group", { name: "Choose end date" })).toBeNull();

  fireEvent.click(screen.getByRole("button", { name: "Start date: Sep 29, 2026" }));
  fireEvent.change(screen.getByRole("combobox", { name: "Month" }), { target: { value: "9" } });
  fireEvent.click(screen.getByRole("button", { name: "Friday, October 2, 2026" }));
  expect(screen.getByRole("button", { name: "Start date: Oct 2, 2026" })).toBeVisible();
  expect(screen.getByRole("button", { name: "End date: Choose date" })).toBeVisible();
});
