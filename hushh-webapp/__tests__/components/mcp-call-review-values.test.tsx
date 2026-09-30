import React from "react";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { ReviewArguments, humanizeKey } from "@/components/agent/mcp-call-review-values";

afterEach(cleanup);

const openDisclosure = (container: HTMLElement) => {
  const disclosure = container.querySelector("details") as HTMLDetailsElement;
  act(() => {
    disclosure.open = true;
    fireEvent(disclosure, new Event("toggle"));
  });
  return disclosure;
};

// The call shown in the HubSpot create-contact review.
const createContact = {
  createRequest: {
    objects: [
      {
        properties: { lastname: "Kai", email: "test.kai@example.com", firstname: "Test" },
        objectType: "CONTACT",
      },
    ],
  },
  confirmationStatus: "CONFIRMED",
};

describe("humanizeKey", () => {
  it.each([
    ["createRequest", "Create request"],
    ["objectType", "Object type"],
    ["confirmationStatus", "Confirmation status"],
    ["first_name", "First name"],
    ["hs_lead_status", "Hs lead status"],
    ["email", "Email"],
    ["firstname", "First name"],
    ["lastname", "Last name"],
    ["jobtitle", "Job title"],
    ["userID", "User ID"],
    ["URLPath", "URL path"],
    ["", ""],
    ["___", "___"],
  ])("%s -> %s", (key, expected) => {
    expect(humanizeKey(key)).toBe(expected);
  });
});

describe("review arguments", () => {
  it("shows a create call as labelled rows, never as raw JSON", () => {
    render(<ReviewArguments args={createContact} />);
    const details = screen.getByRole("group", { name: "Call details" });
    const text = details.textContent ?? "";
    expect(text).not.toMatch(/[{}[\]"]/);
    for (const label of ["Create request", "Objects", "Properties", "Last name", "First name", "Email", "Object type", "Confirmation status"]) {
      expect(within(details).getByText(label)).toBeTruthy();
    }
    for (const value of ["Kai", "Test", "test.kai@example.com", "CONTACT", "CONFIRMED"]) {
      expect(within(details).getByText(value)).toBeTruthy();
    }
  });

  it("does not drop or reorder any value", () => {
    render(<ReviewArguments args={createContact} />);
    const text = screen.getByRole("group", { name: "Call details" }).textContent ?? "";
    for (const value of ["Kai", "Test", "test.kai@example.com", "CONTACT", "CONFIRMED"]) {
      expect(text).toContain(value);
    }
  });

  it("keeps the exact raw form behind a collapsed disclosure", () => {
    const { container } = render(<ReviewArguments args={createContact} />);
    const disclosure = container.querySelector("details");
    expect(disclosure).not.toBeNull();
    expect(disclosure!.hasAttribute("open")).toBe(false);
    expect(within(disclosure as HTMLElement).getByText("Technical details")).toBeTruthy();
    // Closed: no second copy of the values anywhere in the page.
    expect(container.querySelector("pre")).toBeNull();
    expect(screen.getAllByText("test.kai@example.com").length).toBe(1);
    const opened = openDisclosure(container);
    expect(opened.querySelector("pre")!.textContent).toBe(JSON.stringify(createContact, null, 2));
  });

  it("groups several records as separate items", () => {
    render(
      <ReviewArguments
        args={{ objects: [{ properties: { email: "a@example.test" } }, { properties: { email: "b@example.test" } }] }}
      />,
    );
    expect(screen.getByText("Item 1")).toBeTruthy();
    expect(screen.getByText("Item 2")).toBeTruthy();
    expect(screen.getByText("a@example.test")).toBeTruthy();
    expect(screen.getByText("b@example.test")).toBeTruthy();
  });

  it("does not label a single record as item 1", () => {
    render(<ReviewArguments args={{ objects: [{ email: "only@example.test" }] }} />);
    expect(screen.queryByText("Item 1")).toBeNull();
  });

  it("renders plain values readably", () => {
    render(
      <ReviewArguments
        args={{ tags: ["red", "blue"], active: true, archived: false, note: "", missing: null, count: 3, nothing: [] }}
      />,
    );
    const details = screen.getByRole("group", { name: "Call details" });
    expect(within(details).getByText("red, blue")).toBeTruthy();
    expect(within(details).getByText("Yes")).toBeTruthy();
    expect(within(details).getByText("No")).toBeTruthy();
    expect(within(details).getByText("Empty")).toBeTruthy();
    expect(within(details).getByText("3")).toBeTruthy();
    expect(within(details).getAllByText("None").length).toBe(2);
  });

  it("renders provider strings as text, not markup or links", () => {
    const { container } = render(
      <ReviewArguments args={{ message: '<a href="https://unsafe.test">Approve everything</a>' }} />,
    );
    expect(screen.getByText(/Approve everything/)).toBeTruthy();
    expect(container.querySelector("a")).toBeNull();
  });

  it("shows a very deep value compactly instead of nesting forever", () => {
    let deep: unknown = "bottom";
    for (let i = 0; i < 8; i += 1) deep = { level: deep };
    const { container } = render(<ReviewArguments args={{ deep }} />);
    expect(container.querySelector("code")).not.toBeNull();
    // The exact data is still available in full.
    openDisclosure(container);
    expect(container.querySelector("pre")!.textContent).toContain("bottom");
  });

  it("shows nothing extra for empty arguments", () => {
    const { container } = render(<ReviewArguments args={{}} />);
    expect(screen.getByRole("group", { name: "Call details" }).textContent).toBe("");
    openDisclosure(container);
    expect(container.querySelector("pre")!.textContent).toBe("{}");
  });
});
