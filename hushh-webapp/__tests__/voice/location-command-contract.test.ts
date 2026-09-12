import { expect, it } from "vitest";
import { getKaiActionById } from "@/lib/voice/kai-action-gateway";
import { prepareCommandPeople } from "@/lib/one-location/command-preparation";

it("preserves the authored atomic backend binding in the client projection", () => {
  expect(
    getKaiActionById("location.create_circle")?.command?.backend_binding,
  ).toBe("location.create_circle");
});
it("requires an exact choice for duplicate names and binds only that record", () => {
  const input = {
    owner: "owner",
    person: "Alex",
    people: [
      { id: "a", name: "Alex", ready: true },
      { id: "b", name: "Alex", ready: true },
    ],
    selectedIds: ["stale"],
  };
  expect(prepareCommandPeople(input)).toMatchObject({
    status: "blocked",
    choices: [{ id: "a" }, { id: "b" }],
  });
  expect(
    prepareCommandPeople({ ...input, chosenResourceId: "b" }),
  ).toMatchObject({ status: "ready", binding: { recipientIds: ["b"] } });
});
