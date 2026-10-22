import { describe, expect, it } from "vitest";
import { connectedInvitationPeople } from "@/lib/calendar/invitation-people";
import type { ConnectionSummaryEntry } from "@/lib/services/connections-service";

const connection = (email: string, displayName: string, photoUrl: string | null = null): ConnectionSummaryEntry => ({
  connectionId: email, userId: email, email, displayName, photoUrl, createdAt: null,
});

describe("Calendar connected people", () => {
  it("uses only unique exact email matches for names and photos", () => {
    const people = connectedInvitationPeople([
      connection("JHUMMA@hushh.ai", "Jhumma Kumari", "https://images.example.test/jhumma.jpg"),
      connection("other@example.com", "Jhumma Kumari", "https://images.example.test/other.jpg"),
      connection("duplicate@example.com", "First"),
      connection("DUPLICATE@example.com", "Second"),
    ]);
    expect(people.get("jhumma@hushh.ai")).toEqual({ displayName: "Jhumma Kumari", photoUrl: "https://images.example.test/jhumma.jpg" });
    expect(people.has("duplicate@example.com")).toBe(false);
    expect(people.has("unknown@example.com")).toBe(false);
  });
});
