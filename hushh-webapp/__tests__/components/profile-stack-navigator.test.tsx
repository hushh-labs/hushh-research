import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ProfileStackNavigator } from "@/components/profile/profile-stack-navigator";

// Helper to render the stack with default props
const renderStack = (props: any) => render(
  <ProfileStackNavigator
    rootContent={<div>Root workspace</div>}
    entries={[]}
    {...props}
  />
);

describe("ProfileStackNavigator", () => {
  it("maintains stable rendering across content updates", async () => {
    const { rerender } = renderStack({
      entries: [{ key: "panel:1", title: "Panel 1", content: <div>Original</div> }],
    });

    expect(screen.getByText("Original")).toBeDefined();

    rerender(<ProfileStackNavigator rootContent={<div>Root</div>} entries={[{ key: "panel:1", title: "Panel 1", content: <div>Updated</div> }]} />);

    await waitFor(() => {
      expect(screen.queryByText("Original")).toBeNull();
      expect(screen.getByText("Updated")).toBeDefined();
    });
  });

  it("handles deep stack navigation and back interaction", () => {
    const onBack = vi.fn();
    renderStack({
      entries: [
        { key: "1", title: "Tier 1", content: <div>Content 1</div> },
        { key: "2", title: "Tier 2", content: <div>Content 2</div> },
      ],
      onBack, // Assuming your component accepts an onBack callback
    });

    expect(screen.getByText("Content 2")).toBeDefined();

    // Simulate back navigation
    const backButton = screen.getByRole("button", { name: /back/i });
    fireEvent.click(backButton);

    expect(onBack).toHaveBeenCalled();
  });

  it("ensures root workspace stability with empty entries", () => {
    renderStack({ entries: [] });

    expect(screen.getByText("Root workspace")).toBeDefined();
    expect(screen.queryByRole("button", { name: /back/i })).toBeNull();
  });

  it("correctly manages transition states between different keys", () => {
    const { rerender } = renderStack({
      entries: [{ key: "k1", title: "T1", content: <div>C1</div> }],
    });

    expect(screen.getByText("C1")).toBeDefined();

    rerender(<ProfileStackNavigator rootContent={<div>Root</div>} entries={[{ key: "k2", title: "T2", content: <div>C2</div> }]} />);

    expect(screen.queryByText("C1")).toBeNull();
    expect(screen.getByText("C2")).toBeDefined();
  });
});