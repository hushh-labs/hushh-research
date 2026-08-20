import { describe, expect, it } from "vitest";

import { filterPeopleByQuery, sortPeopleByName } from "../people-search";

const nameOf = (name: string) => name;

describe("sortPeopleByName", () => {
  it("orders people A to Z", () => {
    const people = ["Neelesh Meena", "Ankit Kumar Singh", "Meena Rao"];

    expect(sortPeopleByName(people, nameOf)).toEqual([
      "Ankit Kumar Singh",
      "Meena Rao",
      "Neelesh Meena",
    ]);
  });

  it("does not let capitalisation decide the order", () => {
    // The bug this guards: a plain `localeCompare` in some locales, and every
    // byte-order sort, puts "Zara" ahead of "ankit" because uppercase sorts
    // first. A reader looking for "ankit" under A would never find it.
    const people = ["zara", "Ankit", "Bhavya"];

    expect(sortPeopleByName(people, nameOf)).toEqual([
      "Ankit",
      "Bhavya",
      "zara",
    ]);
  });

  it("sorts an accented name next to its plain spelling, not after Z", () => {
    const people = ["Zoe", "Ánkit", "Bhavya"];

    expect(sortPeopleByName(people, nameOf)).toEqual([
      "Ánkit",
      "Bhavya",
      "Zoe",
    ]);
  });

  it("leaves the caller's list untouched", () => {
    const people = ["Neelesh", "Ankit"];
    sortPeopleByName(people, nameOf);

    expect(people).toEqual(["Neelesh", "Ankit"]);
  });

  it("ignores surrounding whitespace when deciding where a name goes", () => {
    // Names are not stored tidily. A leading space used to sort a person above
    // every letter, at the top of the list, away from their own initial.
    const people = ["Bhavya", "  Ankit", "Chetan"];

    expect(sortPeopleByName(people, nameOf)).toEqual([
      "  Ankit",
      "Bhavya",
      "Chetan",
    ]);
  });
});

describe("filterPeopleByQuery on a phone keyboard", () => {
  it("finds an apostrophe name typed with the iOS curly apostrophe", () => {
    // The reported shape of this bug: an iPhone keyboard inserts U+2019 for an
    // apostrophe, but the stored name holds the straight U+0027. On the one
    // device where the user cannot type the other character, the search for a
    // name they are looking straight at returned nothing.
    const people = ["Ankit O'Brien", "Neelesh Meena"];

    expect(filterPeopleByQuery(people, "o’brien", nameOf)).toEqual([
      "Ankit O'Brien",
    ]);
    expect(filterPeopleByQuery(people, "o'brien", nameOf)).toEqual([
      "Ankit O'Brien",
    ]);
  });

  it("finds a name spelled with an en dash when a hyphen is typed", () => {
    const people = ["Smith–Jones", "Meena Rao"];

    expect(filterPeopleByQuery(people, "smith-jones", nameOf)).toEqual([
      "Smith–Jones",
    ]);
  });

  it("finds an accented name from the plain letters a keyboard produces", () => {
    const people = ["Ánkit Singh", "Neelesh Meena"];

    expect(filterPeopleByQuery(people, "ankit", nameOf)).toEqual([
      "Ánkit Singh",
    ]);
  });

  it("leaves an Indic name intact while folding Latin accents", () => {
    // Accent-stripping must not reach into Devanagari. `\p{Diacritic}` matches
    // the virama, so it rewrites "झुम्मा" to "झुममा" — a different word, and it
    // undoes the combining-mark handling that makes one-letter search work for
    // these names at all. Only the Latin combining block may be stripped.
    const people = ["झुम्मा", "नीलेश", "अंकित"];

    expect(filterPeopleByQuery(people, "झुम्मा", nameOf)).toEqual(["झुम्मा"]);
    expect(filterPeopleByQuery(people, "न", nameOf)).toEqual(["नीलेश"]);
  });

  it("matches the same name whether it is composed or decomposed", () => {
    // "Á" as one codepoint vs "A" + combining acute. Two different strings for
    // one name, depending on which keyboard or paste produced it.
    const composed = "Ánkit";
    const decomposed = "Ánkit";

    expect(filterPeopleByQuery([composed], decomposed, nameOf)).toEqual([
      composed,
    ]);
    expect(filterPeopleByQuery([decomposed], composed, nameOf)).toEqual([
      decomposed,
    ]);
  });
});

describe("sortPeopleByName feeding filterPeopleByQuery", () => {
  it("keeps word-beginning matches first, and orders A-Z inside each group", () => {
    // This is the whole contract of the pair, and it is why the sort is applied
    // to the SOURCE list rather than to the filtered result. Sorting afterwards
    // would put "Ameena" (a mid-word match) above "Meena Rao" (a real word
    // beginning) purely because A comes before M.
    const people = [
      "Meena Rao",
      "Ameena Khan",
      "Bhavya Mehta",
      "Chetan Meenakshi",
    ];

    const ordered = sortPeopleByName(people, nameOf);

    expect(filterPeopleByQuery(ordered, "mee", nameOf)).toEqual([
      // begins a word, A-Z
      "Chetan Meenakshi",
      "Meena Rao",
      // merely contains it, A-Z
      "Ameena Khan",
    ]);
  });

  it("shows an alphabetical list before anything is typed", () => {
    const people = ["Neelesh Meena", "Ankit Kumar Singh"];

    expect(filterPeopleByQuery(sortPeopleByName(people, nameOf), "", nameOf)).toEqual([
      "Ankit Kumar Singh",
      "Neelesh Meena",
    ]);
  });

  it("still narrows to one person from a single typed letter", () => {
    // Ordering must not undo the fix that made one-letter search usable:
    // both names contain an "n", only one begins a word with it.
    const people = sortPeopleByName(
      ["Neelesh Meena", "Ankit Kumar Singh"],
      nameOf,
    );

    expect(filterPeopleByQuery(people, "n", nameOf)).toEqual(["Neelesh Meena"]);
  });
});
