// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import {
  EmptyState,
  TaskFlowHeader,
} from "@/components/one-location/redesign/primitives";

describe("TaskFlowHeader", () => {
  it("does not reserve an empty lead row for title-only flows", () => {
    render(<TaskFlowHeader title="Settings" />);

    const heading = screen.getByRole("heading", { name: "Settings" });
    expect(heading.closest("header")?.children).toHaveLength(1);
  });
});

describe("EmptyState", () => {
  it("renders an action node when provided", () => {
    render(
      <EmptyState
        title="Build your trusted circle"
        description="Add connections so the people you trust can receive your live location."
        action={<a href="/one/connect">Add connections</a>}
      />,
    );
    expect(screen.getByText("Build your trusted circle")).toBeTruthy();
    const link = screen.getByText("Add connections").closest("a");
    expect(link?.getAttribute("href")).toBe("/one/connect");
  });
});
