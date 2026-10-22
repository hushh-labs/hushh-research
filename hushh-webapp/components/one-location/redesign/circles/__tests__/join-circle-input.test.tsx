// @vitest-environment jsdom
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { JoinCircleFlow } from "../named-circle-flows";

const clipboardDescriptor = Object.getOwnPropertyDescriptor(navigator, "clipboard");
afterEach(() => {
  if (clipboardDescriptor) Object.defineProperty(navigator, "clipboard", clipboardDescriptor);
  else Reflect.deleteProperty(navigator, "clipboard");
});

function setup(busy = false) {
  const onResolve = vi.fn().mockResolvedValue({
    name: "Family", kind: "family", ownerDisplayName: "Owner", memberCount: 2,
    alreadyMember: false, expiresAt: "2026-12-01T00:00:00Z",
  });
  const onJoin = vi.fn().mockResolvedValue(undefined);
  render(<JoinCircleFlow busy={busy} onResolve={onResolve} onJoin={onJoin} />);
  const fields = screen.getAllByRole("textbox") as HTMLInputElement[];
  return { fields, onResolve, onJoin };
}

describe("Circle invite code entry", () => {
  it("advances between groups, preserves a later group when editing, and reviews the complete code", async () => {
    const { fields, onResolve } = setup();
    fireEvent.change(fields[0], { target: { value: "rf58" } });
    expect(fields[1]).toHaveFocus();
    fireEvent.change(fields[1], { target: { value: "dg8g" } });
    expect(fields[2]).toHaveFocus();
    fireEvent.change(fields[2], { target: { value: "w544" } });
    fireEvent.change(fields[1], { target: { value: "" } });
    expect(fields.map((field) => field.value)).toEqual(["RF58", "", "W544"]);
    expect(screen.getByRole("button", { name: "Review Circle" })).toBeDisabled();
    fireEvent.keyDown(fields[1], { key: "Backspace" });
    expect(fields[0]).toHaveFocus();
    fireEvent.change(fields[1], { target: { value: "DG8G" } });
    fireEvent.keyDown(fields[2], { key: "Enter" });
    await waitFor(() => expect(onResolve).toHaveBeenCalledWith("RF58-DG8G-W544"));
  });

  it.each([
    [0, "rf58dg8gw544"],
    [1, "Join my Circle with code RF58-DG8G-W544."],
    [2, "https://one.hushh.ai/circle/join?code=RF58-DG8G-W544"],
  ] as const)("accepts a complete pasted invitation in group %s", (index, text) => {
    const { fields } = setup();
    fireEvent.paste(fields[index], { clipboardData: { getData: () => text } });
    expect(fields.map((field) => field.value)).toEqual(["RF58", "DG8G", "W544"]);
    expect(screen.getByRole("button", { name: "Review Circle" })).toBeEnabled();
  });

  it("reads the clipboard only after a click and waits for explicit review", async () => {
    const readText = vi.fn().mockResolvedValue("RF58-DG8G-W544");
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { readText } });
    const { fields, onResolve } = setup();
    expect(readText).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Paste from clipboard" }));
    await waitFor(() => expect(fields.map((field) => field.value)).toEqual(["RF58", "DG8G", "W544"]));
    expect(onResolve).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Review Circle" }));
    await waitFor(() => expect(onResolve).toHaveBeenCalledWith("RF58-DG8G-W544"));
  });

  it.each(["denied", "unavailable", "invalid"])("keeps manual entry available when the clipboard is %s", async (condition) => {
    const readText = condition === "denied"
      ? vi.fn().mockRejectedValue(new Error("Denied"))
      : vi.fn().mockResolvedValue("Not an invite");
    Object.defineProperty(navigator, "clipboard", {
      configurable: true, value: condition === "unavailable" ? undefined : { readText },
    });
    const { fields, onResolve } = setup();
    fireEvent.click(screen.getByRole("button", { name: "Paste from clipboard" }));
    await screen.findByText(condition === "invalid" ? /Enter a valid 12-character/ : /Clipboard access is unavailable/);
    expect(screen.getByRole("alert")).toBeInTheDocument();
    await waitFor(() => expect(fields[0]).toBeEnabled());
    expect(onResolve).not.toHaveBeenCalled();
    fireEvent.change(fields[0], { target: { value: "RF58" } });
    expect(fields[0]).toHaveValue("RF58");
  });

  it("ignores a pending clipboard result when a newer invitation arrives", async () => {
    let finishRead: ((value: string) => void) | undefined;
    const read = new Promise<string>((resolve) => { finishRead = resolve; });
    Object.defineProperty(navigator, "clipboard", {
      configurable: true, value: { readText: vi.fn().mockReturnValue(read) },
    });
    const onResolve = vi.fn().mockResolvedValue({
      name: "New Circle", kind: "family", ownerDisplayName: "Owner", memberCount: 2,
      alreadyMember: false, expiresAt: "2026-12-01T00:00:00Z",
    });
    const onJoin = vi.fn();
    const { rerender } = render(<JoinCircleFlow busy={false} onResolve={onResolve} onJoin={onJoin} />);
    fireEvent.click(screen.getByRole("button", { name: "Paste from clipboard" }));
    rerender(<JoinCircleFlow busy={false} initialCode="2345-6789-ABCD" onResolve={onResolve} onJoin={onJoin} />);
    await screen.findByText("New Circle");
    await act(async () => {
      finishRead?.("RF58-DG8G-W544");
      await read;
    });
    expect(screen.getAllByRole("textbox").map((input) => (input as HTMLInputElement).value))
      .toEqual(["2345", "6789", "ABCD"]);
    expect(screen.getByText("New Circle")).toBeInTheDocument();
  });

  it("disables editing, clipboard access, and review while busy", () => {
    const { fields, onResolve } = setup(true);
    for (const field of fields) expect(field).toBeDisabled();
    expect(screen.getByRole("button", { name: "Paste from clipboard" })).toBeDisabled();
    fireEvent.keyDown(fields[2], { key: "Enter" });
    expect(onResolve).not.toHaveBeenCalled();
  });
});
