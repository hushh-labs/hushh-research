import { useState } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { PkmMemoryLevel } from "@/components/profile/pkm-memory-level";
import type { PkmMemoryCard, PkmPathSegment } from "@/lib/pkm/pkm-memory-cards";

function financialData() {
  return {
    goals: {
      retirement: {
        target_corpus: "5 crore",
        milestones: [
          { name: "First 1 crore", status: "done" },
          { name: "Second target", status: "pending" },
        ],
      },
      house: { down_payment: "40 lakh" },
    },
  } as Record<string, unknown>;
}

/** Harness that owns the navigation stack exactly like PkmNaturalPanel does. */
function Harness({
  onExit,
  onOpenLeaf,
}: {
  onExit: () => void;
  onOpenLeaf: (card: PkmMemoryCard) => void;
}) {
  const [pathStack, setPathStack] = useState<PkmPathSegment[]>([]);
  return (
    <PkmMemoryLevel
      domainKey="financial"
      domainTitle="Financial"
      data={financialData()}
      pathStack={pathStack}
      loading={false}
      error={false}
      sharingImpactError={null}
      onDrill={(segment) => setPathStack((stack) => [...stack, segment])}
      onBack={() => {
        if (pathStack.length === 0) {
          onExit();
          return;
        }
        setPathStack((stack) => stack.slice(0, -1));
      }}
      onOpenLeaf={onOpenLeaf}
    />
  );
}

describe("PkmMemoryLevel", () => {
  it("drills through 3+ levels showing only immediate children, then Back walks up one at a time", () => {
    const onExit = vi.fn();
    const onOpenLeaf = vi.fn();
    render(<Harness onExit={onExit} onOpenLeaf={onOpenLeaf} />);

    // Level 0 — domain root.
    expect(screen.getByRole("heading", { name: "Financial" })).toBeTruthy();
    expect(screen.getByTestId("memory-group-goals")).toHaveTextContent("Goals");
    expect(screen.queryByText("Retirement")).toBeNull();

    // Level 1.
    fireEvent.click(screen.getByRole("button", { name: "Open Goals" }));
    expect(screen.getByRole("heading", { name: "Goals" })).toBeTruthy();
    const retirement = screen.getByTestId("memory-group-retirement");
    expect(retirement).toHaveTextContent("Retirement");
    // target_corpus + 2 milestones x {name,status} = 5 descendant memories.
    expect(retirement).toHaveTextContent("5");

    // Level 2.
    fireEvent.click(screen.getByRole("button", { name: "Open Retirement" }));
    expect(screen.getByRole("heading", { name: "Retirement" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Open memory: Target Corpus" })).toBeTruthy();

    // Level 3 — nested array, human-readable item labels (never "[0]").
    fireEvent.click(screen.getByRole("button", { name: "Open Milestones" }));
    expect(screen.getByRole("heading", { name: "Milestones" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Open First 1 crore" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Open Second target" })).toBeTruthy();
    expect(screen.getByText("Financial › Goals › Retirement")).toBeTruthy();

    // Back = exactly one level up, each press.
    fireEvent.click(screen.getByRole("button", { name: "Retirement" }));
    expect(screen.getByRole("heading", { name: "Retirement" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Goals" }));
    expect(screen.getByRole("heading", { name: "Goals" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Financial" }));
    expect(screen.getByRole("heading", { name: "Financial" })).toBeTruthy();

    // Back from the root asks the parent to leave the category.
    expect(onExit).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Memory" }));
    expect(onExit).toHaveBeenCalledTimes(1);
  });

  it("opens a leaf with its exact path", () => {
    const onOpenLeaf = vi.fn();
    render(<Harness onExit={vi.fn()} onOpenLeaf={onOpenLeaf} />);

    fireEvent.click(screen.getByRole("button", { name: "Open Goals" }));
    fireEvent.click(screen.getByRole("button", { name: "Open Retirement" }));
    fireEvent.click(screen.getByRole("button", { name: "Open memory: Target Corpus" }));

    expect(onOpenLeaf).toHaveBeenCalledTimes(1);
    expect(onOpenLeaf.mock.calls[0][0].pathSegments).toEqual([
      "goals",
      "retirement",
      "target_corpus",
    ]);
  });

  it("renders a defensive not-found state when the path is gone", () => {
    render(
      <PkmMemoryLevel
        domainKey="financial"
        domainTitle="Financial"
        data={financialData()}
        pathStack={["goals", "missing"]}
        loading={false}
        error={false}
        sharingImpactError={null}
        onDrill={vi.fn()}
        onBack={vi.fn()}
        onOpenLeaf={vi.fn()}
      />,
    );
    expect(screen.getByText("This memory moved")).toBeTruthy();
  });
});
