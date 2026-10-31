import { describe, expect, it } from "vitest";
import { calendarEventPeople, calendarHusshPeople, calendarHusshPerson } from "@/lib/calendar/calendar-hussh-people";
import type { AccountEmailAlias } from "@/lib/services/account-service";
import type { ConnectionSummaryEntry } from "@/lib/services/connections-service";

const husshPhoto = "data:image/png;base64,aGVsbG8=";
const googlePhoto = "https://lh3.googleusercontent.com/a/google=s96-c";
const connection = (userId: string, email: string, photoUrl: string | null, emailVerified = true): ConnectionSummaryEntry => ({
  connectionId: userId, userId, email, displayName: "Same name", photoUrl, emailVerified, createdAt: null,
});
const alias = (email: string, status: AccountEmailAlias["verification_status"] = "verified"): AccountEmailAlias => ({
  alias_id: email, user_id: "owner", email, email_normalized: email, verification_status: status, verification_source: "email_code",
});
const resolve = (connections: ConnectionSummaryEntry[], overrides: Partial<Parameters<typeof calendarHusshPeople>[0]> = {}) => calendarHusshPeople({
  connections, ownerId: "owner", ownerEmail: "owner@example.test", ownerEmailVerified: true,
  ownerPhotoUrl: husshPhoto, ...overrides,
});

describe("Calendar HUSSH identity resolution", () => {
  it("uses the canonical HUSSH photo for verified exact Connections even when Google has a different photo", () => {
    const people = resolve([connection("peer", "Peer@Example.Test", husshPhoto)]);
    expect(calendarHusshPerson(people, " peer@example.test ")?.photoUrl).toBe(husshPhoto);
    expect(calendarHusshPerson(people, "peer+other@example.test")).toBeNull();
    expect(calendarHusshPerson(people, "unknown@example.test")).toBeNull();
    expect(googlePhoto).not.toBe(husshPhoto);
  });

  it("does not use names, unverified emails, duplicate owners or unadmitted image URLs", () => {
    const people = resolve([
      connection("peer-a", "a@example.test", husshPhoto),
      connection("peer-b", "b@example.test", husshPhoto),
      connection("unverified", "unverified@example.test", husshPhoto, false),
      connection("duplicate-a", "duplicate@example.test", husshPhoto),
      connection("duplicate-b", "DUPLICATE@example.test", husshPhoto),
      connection("bad-url", "bad@example.test", "https://images.example.test/photo.png"),
    ]);
    expect(calendarHusshPerson(people, "a@example.test")?.userId).toBe("peer-a");
    expect(calendarHusshPerson(people, "b@example.test")?.userId).toBe("peer-b");
    expect(calendarHusshPerson(people, "unverified@example.test")).toBeNull();
    expect(calendarHusshPerson(people, "duplicate@example.test")).toBeNull();
    expect(calendarHusshPerson(people, "bad@example.test")?.photoUrl).toBeNull();
  });

  it("uses the owner photo only for a verified primary or verified linked email", () => {
    const people = resolve([], { ownerAliases: [alias("linked@example.test"), alias("pending@example.test", "pending")] });
    expect(calendarHusshPerson(people, "owner@example.test")?.photoUrl).toBe(husshPhoto);
    expect(calendarHusshPerson(people, "linked@example.test")?.userId).toBe("owner");
    expect(calendarHusshPerson(people, "pending@example.test")).toBeNull();
    expect(calendarHusshPerson(people, "second-google@example.test")).toBeNull();
    expect(calendarHusshPerson(resolve([], { ownerEmailVerified: false }), "owner@example.test")).toBeNull();
  });

  it("keeps ambiguous owner and peer email claims as initials", () => {
    const people = resolve([connection("peer", "owner@example.test", husshPhoto)]);
    expect(calendarHusshPerson(people, "owner@example.test")).toBeNull();
  });

  it("reflects updated and removed profile photos on the next bounded read", () => {
    expect(calendarHusshPerson(resolve([connection("peer", "peer@example.test", googlePhoto)]), "peer@example.test")?.photoUrl).toBe(googlePhoto);
    expect(calendarHusshPerson(resolve([connection("peer", "peer@example.test", husshPhoto)]), "peer@example.test")?.photoUrl).toBe(husshPhoto);
    expect(calendarHusshPerson(resolve([connection("peer", "peer@example.test", null)]), "peer@example.test")?.photoUrl).toBeNull();
  });

  it("keeps a valid uploaded JPG portrait visible in Calendar", () => {
    const jpgPhoto = "data:image/jpg;base64,aGVsbG8=";
    const people = calendarEventPeople(resolve([]), {
      "manish@example.test": { userId: "manish", photoUrl: jpgPhoto },
    }, "owner");
    expect(calendarHusshPerson(people, "manish@example.test")?.photoUrl).toBe(jpgPhoto);
  });

  it("keeps the Connect name for a match without an admitted photo and drops matches with neither", () => {
    const people = calendarEventPeople(resolve([]), {
      "priya@example.test": { userId: "priya", displayName: " Priya Shah ", photoUrl: null },
      "bad-photo@example.test": { userId: "bad-photo", displayName: "Bad Photo", photoUrl: "https://images.example.test/photo.png" },
      "empty@example.test": { userId: "empty", displayName: null, photoUrl: null },
    }, "owner");
    expect(calendarHusshPerson(people, "priya@example.test")).toEqual({ userId: "priya", displayName: "Priya Shah", photoUrl: null });
    expect(calendarHusshPerson(people, "bad-photo@example.test")).toEqual({ userId: "bad-photo", displayName: "Bad Photo", photoUrl: null });
    expect(calendarHusshPerson(people, "empty@example.test")).toBeNull();
  });

  it("uses the current verified event match over stale connection email and rejects unsafe media", () => {
    const known = resolve([connection("peer", "peer@example.test", husshPhoto)]);
    const people = calendarEventPeople(known, {
      "manish@example.test": { userId: "manish", photoUrl: googlePhoto },
      "peer@example.test": { userId: "current-owner", photoUrl: googlePhoto },
      "unknown@example.test": { userId: "unknown", photoUrl: "https://images.example.test/photo.png" },
    }, "owner");
    expect(calendarHusshPerson(known, "manish@example.test")).toBeNull();
    expect(calendarHusshPerson(people, "manish@example.test")?.photoUrl).toBe(googlePhoto);
    expect(calendarHusshPerson(people, "peer@example.test")?.userId).toBe("current-owner");
    expect(calendarHusshPerson(people, "peer@example.test")?.photoUrl).toBe(googlePhoto);
    expect(calendarHusshPerson(people, "unknown@example.test")).toBeNull();
    expect(calendarHusshPerson(calendarEventPeople(known, undefined, "owner"), "peer@example.test")).toBeNull();
    expect(calendarHusshPerson(calendarEventPeople(known, {}, "owner"), "owner@example.test")?.photoUrl).toBe(husshPhoto);
  });
});
