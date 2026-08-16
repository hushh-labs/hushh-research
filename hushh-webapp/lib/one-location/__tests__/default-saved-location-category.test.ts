import { describe, expect, it } from "vitest";

import {
  defaultSavedLocationCategory,
  type SavedLocationCategory,
} from "@/lib/one-location/saved-locations";

const at = (...categories: SavedLocationCategory[]) =>
  categories.map((category) => ({ category }));

describe("defaultSavedLocationCategory", () => {
  it("opens on Home for a first save, so nothing has to be picked", () => {
    // The whole point: the primary button is live on arrival instead of dead
    // behind "Pick Home, Work or Other first."
    expect(defaultSavedLocationCategory([])).toBe("home");
    expect(defaultSavedLocationCategory()).toBe("home");
  });

  it("does not pre-select a label that would overwrite a saved place", () => {
    // Home and Work take fixed ids from `generateId`, so they hold one place
    // each. Pre-selecting an occupied one would replace it on save.
    expect(defaultSavedLocationCategory(at("home"))).toBe("work");
    expect(defaultSavedLocationCategory(at("home", "work"))).toBe("other");
  });

  it("still answers when both singletons are taken", () => {
    // "Other" holds many places, so there is always a free label and the
    // button is never dead.
    expect(defaultSavedLocationCategory(at("home", "work", "other"))).toBe(
      "other",
    );
    expect(defaultSavedLocationCategory(at("other", "other"))).toBe("home");
  });

  it("fills the earlier gap rather than appending", () => {
    // Someone who saved only Work should be offered Home, not Other.
    expect(defaultSavedLocationCategory(at("work"))).toBe("home");
    expect(defaultSavedLocationCategory(at("work", "other"))).toBe("home");
    expect(defaultSavedLocationCategory(at("other"))).toBe("home");
  });

  it("ignores order and duplicates", () => {
    expect(defaultSavedLocationCategory(at("work", "home"))).toBe("other");
    expect(defaultSavedLocationCategory(at("home", "home"))).toBe("work");
  });
});
