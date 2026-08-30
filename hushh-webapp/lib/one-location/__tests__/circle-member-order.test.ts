/**
 * The one row in a Circle roster whose position carries information.
 *
 * Reported on a Trusted Circle whose owner sat in the MIDDLE of an A-Z list:
 * "owner hamesha sabse upar hi rahega, sabhi kind ke circles ke liye". These
 * pin both halves of that -- the owner leads, and nobody else moves.
 */

import { describe, expect, it } from "vitest";

import { sortCircleMembersOwnerFirst } from "@/lib/one-location/circle-member-order";

type Row = { userId: string; displayName: string; role: "owner" | "member" };

const ankit: Row = {
  userId: "ankit",
  displayName: "Ankit Kumar Singh",
  role: "member",
};
const jhumma: Row = {
  userId: "jhumma",
  displayName: "JHUMMA KUMARI",
  role: "owner",
};
const neelesh: Row = {
  userId: "neelesh",
  displayName: "Neelesh Meena",
  role: "member",
};

const names = (rows: readonly Row[]) => rows.map((row) => row.displayName);

describe("sortCircleMembersOwnerFirst", () => {
  it("lifts the owner out of the middle of an A-Z roster", () => {
    // Exactly the screenshot: A, J (owner), N.
    expect(
      names(sortCircleMembersOwnerFirst([ankit, jhumma, neelesh])),
    ).toEqual(["JHUMMA KUMARI", "Ankit Kumar Singh", "Neelesh Meena"]);
  });

  it("leaves everyone else in the order they arrived in", () => {
    // A partition, not a sort: the members stay in the order the caller chose
    // -- server paging order here, deliberately not alphabetical.
    const pagedOrder = [neelesh, ankit, jhumma];
    expect(names(sortCircleMembersOwnerFirst(pagedOrder))).toEqual([
      "JHUMMA KUMARI",
      "Neelesh Meena",
      "Ankit Kumar Singh",
    ]);
  });

  it("is a no-op when the owner already leads", () => {
    expect(
      names(sortCircleMembersOwnerFirst([jhumma, ankit, neelesh])),
    ).toEqual(["JHUMMA KUMARI", "Ankit Kumar Singh", "Neelesh Meena"]);
  });

  it("cannot invent an owner that is not in the list", () => {
    // A paged roster whose first page has not reached the owner yet: there is
    // nothing to hoist, and nothing is fetched to make one.
    expect(names(sortCircleMembersOwnerFirst([ankit, neelesh]))).toEqual([
      "Ankit Kumar Singh",
      "Neelesh Meena",
    ]);
  });

  it("never mutates the list it was handed", () => {
    const source = [ankit, jhumma, neelesh];
    sortCircleMembersOwnerFirst(source);
    expect(names(source)).toEqual([
      "Ankit Kumar Singh",
      "JHUMMA KUMARI",
      "Neelesh Meena",
    ]);
  });

  it("returns an empty roster unchanged", () => {
    expect(sortCircleMembersOwnerFirst([])).toEqual([]);
  });
});
