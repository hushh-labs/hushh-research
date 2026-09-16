import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import {
  EntityCard,
  entityRelationshipLabel,
  initialsFor,
} from "@/components/one-voice/entity-card";
import type { EntityCardPayload } from "@/lib/one-voice/protocol";

afterEach(() => cleanup());

describe("EntityCard", () => {
  it("renders the server's name and relationship, never the id", () => {
    const card: EntityCardPayload = {
      kind: "person",
      user_id: "usr_SECRET_7f3a9c",
      display_name: "Priya Sharma",
      photo_url: null,
      relationship: "connected",
      has_location_key: true,
    };
    const { container } = render(<EntityCard card={card} />);
    expect(screen.getByTestId("one-voice-entity-name")).toHaveTextContent(
      "Priya Sharma",
    );
    expect(
      screen.getByTestId("one-voice-entity-relationship"),
    ).toHaveTextContent("Connected");
    expect(screen.queryByText(/usr_SECRET_7f3a9c/)).toBeNull();
    expect(container.textContent).not.toContain("usr_SECRET_7f3a9c");
    expect(container.innerHTML).not.toContain("usr_SECRET_7f3a9c");
    expect(screen.getByText("Ready for location")).toBeInTheDocument();
  });

  it("maps every relationship to a human label", () => {
    const base: EntityCardPayload = { kind: "person", display_name: "A" };
    expect(
      entityRelationshipLabel({ ...base, relationship: "connected" }),
    ).toBe("Connected");
    expect(
      entityRelationshipLabel({ ...base, relationship: "pending_outgoing" }),
    ).toBe("Request pending");
    expect(
      entityRelationshipLabel({ ...base, relationship: "pending_incoming" }),
    ).toBe("Asked to connect");
    expect(entityRelationshipLabel({ ...base, relationship: "none" })).toBe(
      "Not connected",
    );
    expect(entityRelationshipLabel({ ...base, relationship: "self" })).toBe(
      "You",
    );
    expect(entityRelationshipLabel(base)).toBeNull();
  });

  it("renders a circle with its member count and no circle id", () => {
    const card: EntityCardPayload = {
      kind: "circle",
      circle_id: "0f7d8e5c-1111-2222-3333-444455556666",
      name: "Family",
      kind_label: "Family",
      member_count: 4,
    };
    const { container } = render(<EntityCard card={card} compact />);
    expect(screen.getByTestId("one-voice-entity-name")).toHaveTextContent(
      "Family",
    );
    expect(
      screen.getByTestId("one-voice-entity-relationship"),
    ).toHaveTextContent("Family · 4 members");
    expect(container.textContent).not.toContain("0f7d8e5c");
  });

  it("falls back to initials when there is no photo", () => {
    expect(initialsFor("Priya Sharma")).toBe("PS");
    expect(initialsFor("madonna")).toBe("M");
    expect(initialsFor("")).toBe("•");
    render(
      <EntityCard card={{ kind: "person", display_name: "Priya Sharma" }} />,
    );
    expect(screen.getByText("PS")).toBeInTheDocument();
    expect(document.querySelector("img")).toBeNull();
  });

  it("shows the photo the server sent", () => {
    render(
      <EntityCard
        card={{
          kind: "person",
          display_name: "Priya Sharma",
          photo_url: "https://cdn.example/p.jpg",
        }}
      />,
    );
    const img = document.querySelector("img");
    expect(img).not.toBeNull();
    expect(img?.getAttribute("src")).toContain("cdn.example");
  });
});
