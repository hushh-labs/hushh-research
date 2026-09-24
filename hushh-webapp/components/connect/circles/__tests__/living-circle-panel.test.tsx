// @vitest-environment jsdom
import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { ComponentProps } from "react";
import { PeopleOrbit } from "@/components/connect/people-orbit";
import { LivingCirclePanel } from "@/components/connect/circles/living-circle-panel";

const people = Array.from({ length: 12 }, (_, index) => ({
  id: `person-${index}`,
  name: `Person ${index}`,
  photoUrl: `https://example.com/${index}.png`,
}));

describe("responsive people orbit", () => {
  it("replaces decorative open spots with real people without changing the true count", () => {
    const view = render(
      <PeopleOrbit
        people={people.slice(0, 1)}
        totalCount={1}
        emptySlots={3}
        center={<span>Circle</span>}
      />,
    );
    const orbit = screen.getByTestId("people-orbit");
    const mobile = orbit.children[0] as HTMLElement;
    expect(mobile.querySelectorAll("[data-circle-empty-spot]")).toHaveLength(3);
    expect(within(mobile).getAllByTitle(/^Person /)).toHaveLength(1);
    expect(screen.queryByTestId("people-orbit-overflow")).toBeNull();
    for (const spot of orbit.querySelectorAll("[data-circle-empty-spot]")) {
      expect(spot).toHaveAttribute("aria-hidden", "true");
      expect(spot.tagName).toBe("SPAN");
    }
    view.rerender(
      <PeopleOrbit
        people={people.slice(0, 2)}
        totalCount={2}
        emptySlots={2}
        center={<span>Circle</span>}
      />,
    );
    expect(mobile.querySelectorAll("[data-circle-empty-spot]")).toHaveLength(2);
    expect(within(mobile).getAllByTitle(/^Person /)).toHaveLength(2);
    view.rerender(
      <PeopleOrbit
        people={people}
        totalCount={12}
        emptySlots={3}
        center={<span>Circle</span>}
      />,
    );
    expect(orbit.querySelectorAll("[data-circle-empty-spot]")).toHaveLength(0);
    expect(within(mobile).getByLabelText("9 more people")).toBeTruthy();
  });

  it("never uses open spots for real members whose previews have not loaded", () => {
    render(
      <PeopleOrbit
        people={[]}
        totalCount={1}
        emptySlots={3}
        center={<span>Circle</span>}
      />,
    );
    expect(
      screen
        .getByTestId("people-orbit")
        .querySelectorAll("[data-circle-empty-spot]"),
    ).toHaveLength(0);
  });

  it("keeps the circle uncrowded and represents every remaining member", () => {
    render(
      <PeopleOrbit
        people={people}
        totalCount={12}
        center={<span>Circle</span>}
      />,
    );
    const orbit = screen.getByTestId("people-orbit");
    const mobile = orbit.children[0] as HTMLElement;
    const desktop = orbit.children[1] as HTMLElement;
    expect(mobile.className).toContain("sm:hidden");
    expect(desktop.className).toContain("sm:block");
    expect(within(mobile).getByLabelText("9 more people").textContent).toBe(
      "+9",
    );
    expect(within(desktop).getByLabelText("7 more people").textContent).toBe(
      "+7",
    );
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

  it.each([
    ["new circle", {}, 3],
    ["connections still loading", { loading: true, remainingCapacity: 0 }, 3],
    ["only one place left", { remainingCapacity: 1 }, 1],
    ["full circle", { remainingCapacity: 0 }, 0],
    ["read-only circle", { canInvite: false }, 0],
    ["unavailable connections", { error: "Please retry" }, 0],
  ] as const)(
    "shows honest placeholders for %s",
    (_name, overrides, expected) => {
      const props: ComponentProps<typeof LivingCirclePanel> = {
        circleName: "Family",
        members: [
          {
            userId: "owner",
            displayName: "You",
            role: "owner",
            phoneVerified: true,
            secureLocationReady: true,
          },
        ],
        memberCount: 1,
        canInvite: true,
        candidates: [],
        availableCount: 0,
        remainingCapacity: 20,
        loading: false,
        error: null,
        addingUserId: null,
        onAdd: vi.fn(),
        searchQuery: "",
        onSearchChange: vi.fn(),
        hasMore: false,
        loadingMore: false,
        onLoadMore: vi.fn(),
        onRetry: vi.fn(),
        ...overrides,
      };
      render(<LivingCirclePanel {...props} />);
      const mobile = screen.getByTestId("people-orbit").children[0];
      expect(mobile.querySelectorAll("[data-circle-empty-spot]")).toHaveLength(
        expected,
      );
      expect(screen.getByText("Your circle starts with you")).toBeTruthy();
      if (expected)
        expect(
          screen.getByText("Room for the people you choose."),
        ).toBeTruthy();
      if (_name === "new circle")
        expect(
          screen.getByRole("link", { name: "Find people" }),
        ).toHaveAttribute("href", "/one/connect?tab=all");
    },
  );

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
        searchQuery=""
        onSearchChange={vi.fn()}
        hasMore={false}
        loadingMore={false}
        onLoadMore={vi.fn()}
        onRetry={vi.fn()}
      />,
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Add Asha Rao to Family" }),
    );
    expect(onAdd).toHaveBeenCalledWith("person-1");
    const data = new Map<string, string>();
    const dataTransfer = {
      types: ["application/x-hushh-circle-person"],
      effectAllowed: "none",
      dropEffect: "none",
      setData: (type: string, value: string) => data.set(type, value),
      getData: (type: string) => data.get(type) ?? "",
    };
    fireEvent.dragStart(screen.getByText("Asha Rao").closest("[draggable]")!, {
      dataTransfer,
    });
    fireEvent.dragOver(screen.getByTestId("connect-circle-drop-zone"), {
      dataTransfer,
    });
    fireEvent.drop(screen.getByTestId("connect-circle-drop-zone"), {
      dataTransfer,
    });
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
        searchQuery=""
        onSearchChange={vi.fn()}
        hasMore={false}
        loadingMore={false}
        onLoadMore={vi.fn()}
        onRetry={vi.fn()}
      />,
    );
    expect(screen.queryByText("Bring in your connections")).toBeNull();
    expect(screen.queryByRole("button", { name: /Add Asha Rao/ })).toBeNull();
  });

  it("expands the candidate list inline with search and pagination, never a modal", () => {
    const onSearchChange = vi.fn();
    const onLoadMore = vi.fn();
    const candidates = Array.from({ length: 7 }, (_, index) => ({
      ...candidate,
      userId: `person-${index + 1}`,
      displayName: `Person ${index + 1}`,
    }));
    render(
      <LivingCirclePanel
        circleName="Family"
        members={[]}
        memberCount={1}
        canInvite
        candidates={candidates}
        availableCount={60}
        remainingCapacity={10}
        loading={false}
        error={null}
        addingUserId={null}
        onAdd={vi.fn()}
        searchQuery=""
        onSearchChange={onSearchChange}
        hasMore
        loadingMore={false}
        onLoadMore={onLoadMore}
        onRetry={vi.fn()}
      />,
    );
    expect(screen.queryByText("Person 7")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "See all (60)" }));
    expect(screen.getByText("Person 7")).toBeTruthy();
    fireEvent.change(
      screen.getByRole("searchbox", { name: "Search connections to add" }),
      {
        target: { value: "Person 55" },
      },
    );
    expect(onSearchChange).toHaveBeenCalledWith("Person 55");
    fireEvent.click(
      screen.getByRole("button", { name: "Load more connections" }),
    );
    expect(onLoadMore).toHaveBeenCalledOnce();
    expect(screen.queryByRole("dialog", { name: "Add people" })).toBeNull();
  });
});
