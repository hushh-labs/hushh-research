import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ThemeProvider } from "next-themes";
import { afterEach, expect, it, vi } from "vitest";
import { ThemeToggleLean } from "@/components/theme-toggle";

afterEach(() => {
  vi.restoreAllMocks();
  window.localStorage.clear();
});

it("hydrates the saved theme and preserves an in-memory choice when storage fails", async () => {
  window.localStorage.setItem("theme", "dark");
  const view = render(<ThemeProvider attribute="class"><ThemeToggleLean /></ThemeProvider>);
  await screen.findByRole("radio", { name: "Dark", checked: true });
  await waitFor(() => expect(document.documentElement).toHaveClass("dark"));

  vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("unavailable"); });
  fireEvent.click(screen.getByRole("radio", { name: "Light" }));
  await screen.findByRole("radio", { name: "Light", checked: true });
  await waitFor(() => expect(document.documentElement).toHaveClass("light"));
  view.rerender(<ThemeProvider attribute="class"><span /></ThemeProvider>);
  view.rerender(<ThemeProvider attribute="class"><ThemeToggleLean /></ThemeProvider>);
  expect(screen.getByRole("radio", { name: "Light", checked: true })).toBeInTheDocument();
  expect(window.localStorage.getItem("theme")).toBe("dark");
});
