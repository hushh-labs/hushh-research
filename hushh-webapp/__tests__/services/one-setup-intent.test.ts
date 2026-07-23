import { beforeEach, describe, expect, it } from "vitest";

import {
  clearSetupIntent,
  hasSetupIntent,
  markSetupIntent,
} from "@/lib/services/one-setup-intent";

describe("one-setup-intent", () => {
  beforeEach(() => {
    clearSetupIntent();
  });

  it("defaults to no deliberate intent", () => {
    expect(hasSetupIntent()).toBe(false);
  });

  it("records a deliberate setup open", () => {
    markSetupIntent();
    expect(hasSetupIntent()).toBe(true);
  });

  it("clears the intent (as the guard does when leaving the setup surface)", () => {
    markSetupIntent();
    clearSetupIntent();
    expect(hasSetupIntent()).toBe(false);
  });
});
