import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import {
  OneHomeGreeting,
  friendlyFirstName,
  timeOfDayGreeting,
} from "@/components/dashboard/one-home-greeting";

describe("friendlyFirstName", () => {
  it("takes the first token of a full name", () => {
    expect(friendlyFirstName("Manish Sainani")).toBe("Manish");
  });

  it("derives a capitalized first name from an email local part", () => {
    expect(friendlyFirstName("manish.sainani@gmail.com")).toBe("Manish");
    expect(friendlyFirstName("jane_doe@x.io")).toBe("Jane");
  });

  it("falls back to 'there' for empty/nullish input", () => {
    expect(friendlyFirstName("")).toBe("there");
    expect(friendlyFirstName("   ")).toBe("there");
    expect(friendlyFirstName(null)).toBe("there");
    expect(friendlyFirstName(undefined)).toBe("there");
  });
});

describe("timeOfDayGreeting", () => {
  it("maps hours to morning/afternoon/evening", () => {
    expect(timeOfDayGreeting(new Date(2026, 0, 1, 8, 0))).toBe("Good morning");
    expect(timeOfDayGreeting(new Date(2026, 0, 1, 13, 0))).toBe("Good afternoon");
    expect(timeOfDayGreeting(new Date(2026, 0, 1, 21, 0))).toBe("Good evening");
  });
});

describe("OneHomeGreeting", () => {
  it("renders the personal, time-of-day greeting with the first name", () => {
    render(<OneHomeGreeting displayName="Manish Sainani" />);
    // Greeting resolves to a time-of-day heading ending in the first name.
    expect(
      screen.getByRole("heading", { level: 1 }).textContent,
    ).toMatch(/^(Good morning|Good afternoon|Good evening|Welcome back), Manish\.$/);
  });

  it("greets 'there' when no name is available", () => {
    render(<OneHomeGreeting displayName={null} />);
    expect(screen.getByRole("heading", { level: 1 }).textContent).toMatch(
      /, there\.$/,
    );
  });
});
