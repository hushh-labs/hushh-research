import { describe, expect, it } from "vitest";

import { filterPeopleByQuery } from "../people-search";

const nameOf = (name: string) => name;

describe("filterPeopleByQuery", () => {
  it("narrows to the person whose name begins with a single typed letter", () => {
    // The reported bug, exactly: both names contain an "n" ("Ankit", "Singh"),
    // so a substring filter returned the whole list and one-letter search
    // looked broken.
    const people = ["Ankit Kumar Singh", "Neelesh Meena"];

    expect(filterPeopleByQuery(people, "n", nameOf)).toEqual(["Neelesh Meena"]);
  });

  it("matches the beginning of any word, not just the first", () => {
    const people = ["Ankit Kumar Singh", "Neelesh Meena"];

    expect(filterPeopleByQuery(people, "kum", nameOf)).toEqual([
      "Ankit Kumar Singh",
    ]);
    expect(filterPeopleByQuery(people, "mee", nameOf)).toEqual([
      "Neelesh Meena",
    ]);
  });

  it("still finds a name by its middle once two characters are typed", () => {
    const people = ["Ankit Kumar Singh", "Neelesh Meena"];

    expect(filterPeopleByQuery(people, "ingh", nameOf)).toEqual([
      "Ankit Kumar Singh",
    ]);
  });

  it("keeps every match beyond one character, word beginnings first", () => {
    const people = ["Ameena Khan", "Meena Rao"];

    expect(filterPeopleByQuery(people, "me", nameOf)).toEqual([
      "Meena Rao",
      "Ameena Khan",
    ]);
  });

  it("never empties a list that has a match, even for one character", () => {
    // Nothing BEGINS with "o", so the loose match is all there is — returning
    // an empty list here would be worse than the bug being fixed.
    expect(filterPeopleByQuery(["Bob Rao"], "o", nameOf)).toEqual(["Bob Rao"]);
  });

  it("returns every person for an empty or whitespace query", () => {
    const people = ["Ankit Kumar Singh", "Neelesh Meena"];

    expect(filterPeopleByQuery(people, "", nameOf)).toEqual(people);
    expect(filterPeopleByQuery(people, "   ", nameOf)).toEqual(people);
  });

  it("ignores case and surrounding whitespace", () => {
    const people = ["Neelesh Meena"];

    expect(filterPeopleByQuery(people, "  NEE  ", nameOf)).toEqual(people);
  });

  it("treats hyphens, apostrophes and dots as word breaks", () => {
    expect(filterPeopleByQuery(["Jean-Luc Picard"], "l", nameOf)).toEqual([
      "Jean-Luc Picard",
    ]);
    expect(filterPeopleByQuery(["Riya O'Brien"], "b", nameOf)).toEqual([
      "Riya O'Brien",
    ]);
    expect(filterPeopleByQuery(["R. Meena"], "m", nameOf)).toEqual([
      "R. Meena",
    ]);
  });

  it("matches a multi-word query across the whole name", () => {
    const people = ["Ankit Kumar Singh", "Neelesh Meena"];

    expect(filterPeopleByQuery(people, "ankit ku", nameOf)).toEqual([
      "Ankit Kumar Singh",
    ]);
  });

  it("searches every word of the text the caller supplies, not just a name", () => {
    const people = [
      { name: "Neelesh Meena", headline: "Product designer" },
      { name: "Ankit Kumar Singh", headline: "Founder" },
    ];

    expect(
      filterPeopleByQuery(
        people,
        "designer",
        (person) => `${person.name} ${person.headline}`,
      ),
    ).toEqual([people[0]]);
  });

  it("keeps an Indic name whole instead of splitting it at every matra", () => {
    // A matra is a combining mark, not a letter. Without \p{M} in the word
    // boundary, "झुम्मा" splits into ["झ","म","म",""] and every syllable reads
    // as a separate word — so a mid-word letter counts as a beginning and a
    // genuine match gets dropped.
    const people = ["सुमन", "कमल"];

    expect(filterPeopleByQuery(people, "म", nameOf)).toEqual(people);
    expect(filterPeopleByQuery(["झुम्मा", "नीलेश"], "झ", nameOf)).toEqual([
      "झुम्मा",
    ]);
    expect(filterPeopleByQuery(["नीलेश", "सुमन"], "न", nameOf)).toEqual([
      "नीलेश",
    ]);
  });

  it("still finds an Indic name by a syllable inside it", () => {
    expect(filterPeopleByQuery(["नीलेश मीणा"], "मी", nameOf)).toEqual([
      "नीलेश मीणा",
    ]);
    expect(filterPeopleByQuery(["झुम्मा कुमारी"], "कु", nameOf)).toEqual([
      "झुम्मा कुमारी",
    ]);
  });

  it("drops a person no part of whose text matches", () => {
    const people = ["Ankit Kumar Singh", "Neelesh Meena"];

    expect(filterPeopleByQuery(people, "zz", nameOf)).toEqual([]);
  });
});
