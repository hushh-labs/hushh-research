// @vitest-environment jsdom
import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { PeopleOrbit } from "@/components/connect/people-orbit";
import { LivingCirclePanel } from "@/components/connect/circles/living-circle-panel";

const people = Array.from({ length: 12 }, (_, index) => ({
  id: `person-${index}`,
  name: `Person ${index}`,
  photoUrl: `https://example.com/${index}.png`,
}));

describe("responsive people orbit", () => {
  it("keeps the circle uncrowded and represents every remaining member", () => {
    render(<PeopleOrbit people={people} totalCount={12} center={<span>Circle</span>} />);
    const orbit = screen.getByTestId("people-orbit");
    const mobile = orbit.children[0] as HTMLElement;
    const desktop = orbit.children[1] as HTMLElement;
    expect(mobile.className).toContain("sm:hidden");
    expect(desktop.className).toContain("sm:block");
    expect(within(mobile).getByLabelText("9 more people").textContent).toBe("+9");
    expect(within(desktop).getByLabelText("7 more people").textContent).toBe("+7");
    expect(within(mobile).getAllByTitle(/^Person /)).toHaveLength(3);
    expect(within(desktop).getAllByTitle(/^Person /)).toHaveLength(5);
  });
});

describe("Connect circle growth", () => {
  const candidate = {
    connectionId: "connection-1",
    userId: "person-1",
    displayName: "Asha Rao",
    photoUrl: "https://example.com/asha.png",
    isRia: false,
  };

  it("offers tap-to-add and the same eligible person as a desktop drag target", () => {
    const onAdd = vi.fn();
    render(
      <LivingCirclePanel
        circleName="Family"
        members={[]}
        memberCount={1}
        canInvite
        candidates={[candidate]}
        availableCount={1}
        remainingCapacity={5}
        loading={false}
        error={null}
        addingUserId={null}
        onAdd={onAdd}
        onOpenAll={vi.fn()}
        onRetry={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Add Asha Rao to Family" }));
    expect(onAdd).toHaveBeenCalledWith("person-1");
    const data = new Map<string, string>();
    const dataTransfer = {
      types: ["application/x-hushh-circle-person"],
      effectAllowed: "none",
      dropEffect: "none",
      setData: (type: string, value: string) => data.set(type, value),
      getData: (type: string) => data.get(type) ?? "",
    };
    fireEvent.dragStart(screen.getByText("Asha Rao").closest("[draggable]")!, { dataTransfer });
    fireEvent.dragOver(screen.getByTestId("connect-circle-drop-zone"), { dataTransfer });
    fireEvent.drop(screen.getByTestId("connect-circle-drop-zone"), { dataTransfer });
    expect(onAdd).toHaveBeenCalledTimes(2);
    expect(onAdd).toHaveBeenLastCalledWith("person-1");
  });

  it("never offers an add action to a viewer without invite permission", () => {
    render(
      <LivingCirclePanel
        circleName="Family"
        members={[]}
        memberCount={1}
        canInvite={false}
        candidates={[candidate]}
        availableCount={1}
        remainingCapacity={5}
        loading={false}
        error={null}
        addingUserId={null}
        onAdd={vi.fn()}
        onOpenAll={vi.fn()}
        onRetry={vi.fn()}
      />,
    );
    expect(screen.queryByText("Bring in your connections")).toBeNull();
    expect(screen.queryByRole("button", { name: /Add Asha Rao/ })).toBeNull();
  });
});
