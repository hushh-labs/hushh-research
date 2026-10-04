// @vitest-environment jsdom
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { DirectoryPersonCard } from "../directory-person-card";
import { Checkbox } from "@/components/ui/checkbox";
import type { DirectoryPerson } from "@/lib/services/connections-service";

const person: DirectoryPerson = { userId: "test-person", displayName: "Test Person", photoUrl: null, email: null, maskedEmail: "t***@example.com", relationship: "none" };
describe("directory card", () => {
  it("keeps profile and connection actions separate and renders existing contact details", () => {
    const profile = vi.fn();
    const connect = vi.fn();
    render(<DirectoryPersonCard person={person} title={person.displayName} leading={<span>TP</span>} onClick={profile} trailing={<button onClick={connect}>Connect</button>} />);
    expect(screen.getByText("t***@example.com")).toBeVisible();
    expect(screen.queryByTestId("mutual-connection")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Connect" }));
    expect(connect).toHaveBeenCalledOnce();
    expect(profile).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Open Test Person's profile" }));
    expect(profile).toHaveBeenCalledOnce();
  });
  it("renders server-backed counts with optional named preview", () => {
    const props = { person: { ...person, mutualConnectionCount: 3 }, title: person.displayName, leading: <span>TP</span>, trailing: <button>Connect</button> };
    const view = render(<DirectoryPersonCard {...props} />);
    expect(screen.getByTestId("mutual-connection")).toHaveTextContent("3 mutual connections");
    view.rerender(<DirectoryPersonCard {...props} person={{ ...props.person, mutualConnectionPreview: { displayName: "Alex", photoUrl: null } }} />);
    expect(screen.getByTestId("mutual-connection")).toHaveTextContent("3 mutual connections");
    expect(screen.queryByText("Alex")).toBeNull();
  });
  it("opens the mutual profile independently of the candidate profile", () => {
    const openMutual = vi.fn();
    const openPerson = vi.fn();
    render(<DirectoryPersonCard person={{ ...person, mutualConnectionCount: 1, mutualConnectionPreview: { displayName: "Alex", photoUrl: "https://example.com/alex.png", publicPersonRef: "person_alex" } }} title={person.displayName} leading={<span>TP</span>} onClick={openPerson} onOpenMutual={openMutual} trailing={<button>Connect</button>} />);
    fireEvent.click(screen.getByRole("button", { name: "Open mutual connection Alex's profile" }));
    expect(openMutual).toHaveBeenCalledOnce();
    expect(openPerson).not.toHaveBeenCalled();
    expect(screen.getByTestId("mutual-connection")).toHaveTextContent("Mutual connection");
  });
  it("keeps bulk-selection checkboxes interactive", () => {
    const changed = vi.fn();
    render(<DirectoryPersonCard person={person} title={person.displayName} leading={<span>TP</span>} trailing={<Checkbox aria-label="Select Test Person" onCheckedChange={changed} />} />);
    fireEvent.click(screen.getByRole("checkbox", { name: "Select Test Person" }));
    expect(changed).toHaveBeenCalledWith(true);
  });
});
