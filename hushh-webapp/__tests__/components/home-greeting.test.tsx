import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import {
  HomeGreeting,
  friendlyFirstName,
  greetingForHour,
} from "@/components/dashboard/home-greeting";

describe("friendlyFirstName", () => {
  it("uses the first name from a display name", () => {
    expect(friendlyFirstName("Manish Sainani")).toBe("Manish");
  });

  it("never greets someone by their raw email address", () => {
    expect(friendlyFirstName("manish.sainani@gmail.com")).toBe("Manish");
    expect(friendlyFirstName("kushal_trivedi@hushh.ai")).toBe("Kushal");
  });

  it("strips trailing digits so nobody is greeted as 'Manish123'", () => {
    expect(friendlyFirstName("manish123")).toBe("Manish");
  });

  it("returns null when there is no usable name, so the greeting stays clean", () => {
    expect(friendlyFirstName(null)).toBeNull();
    expect(friendlyFirstName("")).toBeNull();
    expect(friendlyFirstName("   ")).toBeNull();
    expect(friendlyFirstName("123@example.com")).toBeNull();
  });
});

describe("greetingForHour", () => {
  it("maps the local hour to the right part of day", () => {
    expect(greetingForHour(6)).toBe("Good morning");
    expect(greetingForHour(11)).toBe("Good morning");
    expect(greetingForHour(12)).toBe("Good afternoon");
    expect(greetingForHour(16)).toBe("Good afternoon");
    expect(greetingForHour(17)).toBe("Good evening");
    expect(greetingForHour(23)).toBe("Good evening");
    expect(greetingForHour(2)).toBe("Good evening");
  });
});

describe("HomeGreeting", () => {
  it("greets by first name and shows the honest subline", () => {
    render(
      <HomeGreeting
        displayName="Manish Sainani"
        subline="Everything's ready when you are."
      />,
    );

    expect(
      screen.getByRole("heading", {
        name: /^(Good morning|Good afternoon|Good evening|Welcome back), Manish\.$/,
      }),
    ).toBeTruthy();
    expect(screen.getByText("Everything's ready when you are.")).toBeTruthy();
  });

  it("stays graceful with no name at all", () => {
    render(<HomeGreeting displayName={null} />);

    expect(
      screen.getByRole("heading", {
        name: /^(Good morning|Good afternoon|Good evening|Welcome back)\.$/,
      }),
    ).toBeTruthy();
  });
});
