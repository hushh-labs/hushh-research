import { describe, expect, it } from "vitest";
import { connectedInvitationPeople, connectedInvitationPhotoUrl, invitationGooglePhoto } from "@/lib/calendar/invitation-people";
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

  it("prioritizes the selected Google account and never substitutes a Hussh-uploaded guest photo", () => {
    const people = connectedInvitationPeople([connection("manish@example.test", "Manish", "https://images.example.test/manish.jpg")]);
    expect(people.get("manish@example.test")?.displayName).toBe("Manish");
    const ownerPhoto = "https://lh3.googleusercontent.com/a/owner=s96-c";
    const googlePhotos = new Map([["manish@example.test", { url: "https://lh3.googleusercontent.com/profile/manish/photo.jpg", source: "google_profile" as const }]]);
    expect(invitationGooglePhoto(" OWNER@example.test ", "owner@example.test", ownerPhoto)?.url).toBe(ownerPhoto);
    expect(invitationGooglePhoto("manish@example.test", "owner@example.test", ownerPhoto, googlePhotos)?.url).toBe(googlePhotos.get("manish@example.test")?.url);
    expect(invitationGooglePhoto("manish@example.test", "owner@example.test", ownerPhoto)).toBeNull();
    expect(connectedInvitationPhotoUrl(people, "manish@example.test", "owner@example.test", ownerPhoto)).toBe("https://images.example.test/manish.jpg");
    expect(invitationGooglePhoto("stranger@example.test", "owner@example.test", ownerPhoto)).toBeNull();
    expect(invitationGooglePhoto("owner@example.test", "owner@example.test", "https://evil.example.test/avatar")).toBeNull();
  });
});
