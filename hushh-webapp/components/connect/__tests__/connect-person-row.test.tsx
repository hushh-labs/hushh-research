// @vitest-environment jsdom
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ConnectPersonRow, DirectoryMutualLine } from "../connect-person-row";
import { Checkbox } from "@/components/ui/checkbox";
import type { DirectoryPerson } from "@/lib/services/connections-service";

const person: DirectoryPerson = { userId: "test-person", displayName: "Test Person", photoUrl: null, email: null, maskedEmail: "t***@example.com", relationship: "none" };

describe("compact person row", () => {
  it("keeps the profile control and the trailing action apart", () => {
    const open = vi.fn();
    const connect = vi.fn();
    render(
      <ConnectPersonRow
        leading={<span>TP</span>}
        title="Test Person"
        description="Connected 28 Sep"
        openLabel="Open Test Person's profile"
        onOpen={open}
        trailing={<button onClick={connect}>Connect</button>}
      />,
    );
    expect(screen.getByText("Connected 28 Sep")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Connect" }));
    expect(connect).toHaveBeenCalledOnce();
    expect(open).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Open Test Person's profile" }));
    expect(open).toHaveBeenCalledOnce();
  });

  it("omits the secondary line when there is nothing to say", () => {
    const view = render(<ConnectPersonRow leading={<span>TP</span>} title="Test Person" />);
    expect(view.container.querySelector('[data-slot="settings-row-description"]')).toBeNull();
  });

  it("keeps bulk-selection checkboxes interactive", () => {
    const changed = vi.fn();
    render(
      <ConnectPersonRow
        leading={<span>TP</span>}
        title="Test Person"
        trailing={<Checkbox aria-label="Select Test Person" onCheckedChange={changed} />}
      />,
    );
    fireEvent.click(screen.getByRole("checkbox", { name: "Select Test Person" }));
    expect(changed).toHaveBeenCalledWith(true);
  });
});

describe("mutual connections line", () => {
  it("renders server-backed counts without naming the preview", () => {
    const withCount = { ...person, mutualConnectionCount: 3 };
    const view = render(<DirectoryMutualLine person={withCount} />);
    expect(screen.getByTestId("mutual-connection")).toHaveTextContent("3 mutual connections");
    view.rerender(<DirectoryMutualLine person={{ ...withCount, mutualConnectionPreview: { displayName: "Alex", photoUrl: null } }} />);
    expect(screen.getByTestId("mutual-connection")).toHaveTextContent("3 mutual connections");
    expect(screen.queryByText("Alex")).toBeNull();
  });

  it("renders nothing without mutual connections", () => {
    const view = render(<DirectoryMutualLine person={person} />);
    expect(view.container).toBeEmptyDOMElement();
  });

  it("opens the mutual profile independently of the candidate profile", () => {
    const openMutual = vi.fn();
    const openPerson = vi.fn();
    render(
      <ConnectPersonRow
        leading={<span>TP</span>}
        title="Test Person"
        openLabel="Open Test Person's profile"
        onOpen={openPerson}
        supplement={
          <DirectoryMutualLine
            person={{ ...person, mutualConnectionCount: 1, mutualConnectionPreview: { displayName: "98******10", photoUrl: "https://example.com/alex.png", publicPersonRef: "person_alex" } }}
            onOpenMutual={openMutual}
          />
        }
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Open mutual connection Hussh member's profile" }));
    expect(openMutual).toHaveBeenCalledOnce();
    expect(openPerson).not.toHaveBeenCalled();
    expect(screen.getByTestId("mutual-connection")).toHaveTextContent("Mutual connection");
  });
});
