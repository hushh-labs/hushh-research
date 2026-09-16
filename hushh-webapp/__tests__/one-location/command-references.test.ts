import { expect, it } from "vitest";
import { LocationReferenceSession } from "@/lib/one-location/command-references";

it("bounds references to 50, expires at 15 minutes and discards a locked or changed owner session", () => {
  let now = Date.parse("2026-09-13T00:00:00Z");
  const session = new LocationReferenceSession(() => now);
  const observation = (n: number) => ({
    reference: `candidate_${n.toString(16).padStart(32, "0")}`,
    kind: "place",
    id: `provider-place-${n}`,
    name: `Restaurant ${n}`,
    observed_at: new Date(now).toISOString(),
  });
  session.observe(
    "a",
    Array.from({ length: 50 }, (_, n) => observation(n)),
  );
  session.observe("a", [observation(50)]);
  expect(session.list("a")).toHaveLength(50);
  expect(session.list("a")[0]?.id).toBe("provider-place-1");
  now += 15 * 60_000 + 1;
  expect(session.list("a")).toEqual([]);
  session.observe("a", [observation(51)]);
  expect(session.list("b")).toEqual([]);
  expect(session.list("a")).toEqual([]);
  session.observe("a", [observation(52)]);
  session.clear();
  expect(session.list("a")).toEqual([]);
});

it("does not retain malformed, future or expired observations", () => {
  const now = Date.parse("2026-09-13T00:00:00Z");
  const session = new LocationReferenceSession(() => now);
  const value = {
    reference: `candidate_${"a".repeat(32)}`,
    kind: "place",
    id: "place",
    name: "Restaurant",
    observed_at: new Date(now).toISOString(),
  };
  session.observe("a", [
    { ...value, observed_at: new Date(now + 1000).toISOString() },
    { ...value, name: "x".repeat(121) },
    { ...value, kind: "authority" },
  ]);
  expect(session.list("a")).toEqual([]);
});

it("projects only locators and protects retained entries from caller mutation", () => {
  const now = Date.parse("2026-09-13T00:00:00Z");
  const session = new LocationReferenceSession(() => now);
  const value = {
    reference: `candidate_${"a".repeat(32)}`,
    kind: "place",
    id: "place",
    name: "Restaurant",
    observed_at: new Date(now).toISOString(),
    latitude: 1,
    confirmed: true,
  };
  session.observe("a", [value]);
  value.id = "changed";
  const first = session.list("a");
  expect(first[0]).not.toHaveProperty("latitude");
  expect(first[0]).not.toHaveProperty("confirmed");
  first[0]!.id = "changed again";
  expect(session.list("a")[0]?.id).toBe("place");
});

it("expired inputs cannot evict current references and a new Nearby result replaces the visible collection", () => {
  const now = Date.parse("2026-09-13T00:00:00Z");
  const session = new LocationReferenceSession(() => now);
  const value = (n: number, age = 0) => ({
    reference: `candidate_${n.toString(16).padStart(32, "0")}`,
    kind: "place",
    id: `place-${n}`,
    name: `Place ${n}`,
    observed_at: new Date(now - age).toISOString(),
  });
  session.observe(
    "a",
    Array.from({ length: 10 }, (_, n) => value(n)),
    true,
  );
  session.observe(
    "a",
    Array.from({ length: 50 }, (_, n) => value(n + 10, 16 * 60_000)),
  );
  expect(session.list("a")).toHaveLength(10);
  session.observe("a", [value(60), value(61)], true);
  expect(session.list("a").map((item) => item.id)).toEqual([
    "place-60",
    "place-61",
  ]);
});

it("an empty successful Nearby search clears the previous visible results", () => {
  const now = Date.parse("2026-09-13T00:00:00Z");
  const session = new LocationReferenceSession(() => now);
  session.observe(
    "a",
    [
      {
        reference: `candidate_${"a".repeat(32)}`,
        kind: "place",
        id: "place",
        name: "Restaurant",
        observed_at: new Date(now).toISOString(),
      },
    ],
    true,
  );
  session.observe("a", [], true);
  expect(session.list("a")).toEqual([]);
});
