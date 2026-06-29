import { beforeEach, describe, expect, it } from "vitest";

import {
  removeSessionItemsByPrefix,
} from "@/lib/utils/session-storage";

describe("session storage", () => {
  beforeEach(() => {
    sessionStorage.clear();
  });

  it("removes only keys with the requested prefix", () => {
    sessionStorage.setItem("kai-user", "1");
    sessionStorage.setItem("kai-token", "2");
    sessionStorage.setItem("profile", "3");

    removeSessionItemsByPrefix("kai");

    expect(sessionStorage.getItem("kai-user")).toBeNull();
    expect(sessionStorage.getItem("kai-token")).toBeNull();
    expect(sessionStorage.getItem("profile")).toBe("3");
  });

  it("does nothing when no keys match", () => {
    sessionStorage.setItem("profile", "1");

    removeSessionItemsByPrefix("kai");

    expect(sessionStorage.getItem("profile")).toBe("1");
  });

  it("handles empty storage", () => {
    expect(() => removeSessionItemsByPrefix("kai")).not.toThrow();
  });
});
