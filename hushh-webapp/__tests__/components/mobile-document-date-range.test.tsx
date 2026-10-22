import { useState } from "react";
import { format, startOfMonth } from "date-fns";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { MobileDocumentDateRange } from "@/components/consent/mobile-document-date-range";

const scheduler = vi.hoisted(() => ({ heldMonth: null as Date | null }));
vi.mock("react", async (original) => {
  const actual = await original<typeof import("react")>();
  return { ...actual, useDeferredValue: <T,>(value: T) => {
    const deferred = actual.useDeferredValue(value);
    return scheduler.heldMonth ?? deferred;
  } };
});

afterEach(() => { cleanup(); scheduler.heldMonth = null; });

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

it("keeps the year picker responsive while the calendar catches up", async () => {
  render(<RequestDates />);
  fireEvent.click(screen.getByRole("button", { name: "Start date: Choose date" }));

  const year = screen.getByRole("combobox", { name: "Year" });
  // Mobile select controls can emit several changes during one reverse scroll.
  // The final selection must win and the day grid must settle on that month.
  fireEvent.change(year, { target: { value: "2020" } });
  fireEvent.change(year, { target: { value: "2010" } });
  fireEvent.change(year, { target: { value: "2000" } });
  fireEvent.change(screen.getByRole("combobox", { name: "Month" }), {
    target: { value: "0" },
  });

  await waitFor(() => {
    expect(year).toHaveValue("2000");
    expect(
      screen.getByRole("button", { name: "Saturday, January 1, 2000" }),
    ).toBeVisible();
  });
});

it("cannot commit a day from the previous calendar while the latest year is pending", () => {
  const month = startOfMonth(new Date());
  scheduler.heldMonth = month; // Reproduce a valid deferred-render scheduling gap.
  const onStartChange = vi.fn();
  const onEndChange = vi.fn();
  const calendar = <MobileDocumentDateRange start="" end="" onStartChange={onStartChange} onEndChange={onEndChange} />;
  const view = render(calendar);
  fireEvent.click(screen.getByRole("button", { name: "Start date: Choose date" }));
  fireEvent.change(screen.getByRole("combobox", { name: "Year" }), {
    target: { value: String(month.getFullYear() - 1) },
  });
  const staleDay = screen.getByRole("button", { name: format(month, "EEEE, MMMM d, yyyy") });
  fireEvent.click(staleDay);
  expect(onStartChange).not.toHaveBeenCalled();
  expect(onEndChange).not.toHaveBeenCalled();
  expect(staleDay).toBeDisabled();

  scheduler.heldMonth = null;
  view.rerender(<MobileDocumentDateRange start="" end="" onStartChange={onStartChange} onEndChange={onEndChange} />);
  const currentDay = new Date(month.getFullYear() - 1, month.getMonth(), 1);
  fireEvent.click(screen.getByRole("button", { name: format(currentDay, "EEEE, MMMM d, yyyy") }));
  expect(onStartChange).toHaveBeenCalledExactlyOnceWith(format(currentDay, "yyyy-MM-dd"));
});
