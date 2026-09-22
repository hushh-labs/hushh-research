import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { AgentMemoryCaptureStatus } from "@/components/agent/agent-memory-capture-status";

afterEach(cleanup);
describe("quiet Memory capture receipt", () => {
  it("keeps a valid no-op invisible", () => {
    render(
      <AgentMemoryCaptureStatus status={{ phase: "skipped", saved: 0 }} />,
    );
    expect(screen.queryByTestId("memory-capture-status")).toBeNull();
  });
  it("updates one status independently of the answer without claiming an early save", () => {
    const { rerender } = render(
      <AgentMemoryCaptureStatus status={{ phase: "preparing", saved: 0 }} />,
    );
    expect(screen.getAllByRole("status")).toHaveLength(1);
    expect(screen.queryByRole("link")).toBeNull();
    rerender(
      <AgentMemoryCaptureStatus status={{ phase: "saved", saved: 2 }} />,
    );
    expect(screen.getAllByRole("status")).toHaveLength(1);
    expect(screen.getByRole("status").textContent).toBe(
      "2 details saved privately",
    );
    expect(
      screen.getByRole("link", { name: "View Memory" }).getAttribute("href"),
    ).toBe("/one/pkm/recent");
    expect(screen.getByRole("link").className).toContain("min-h-11");
  });
  it("offers recovery without navigating automatically or exposing fields", () => {
    render(
      <AgentMemoryCaptureStatus status={{ phase: "partial", saved: 1 }} />,
    );
    expect(screen.getByRole("status").textContent).toContain(
      "some details still need attention",
    );
    expect(screen.getAllByRole("link")).toHaveLength(1);
  });
});
