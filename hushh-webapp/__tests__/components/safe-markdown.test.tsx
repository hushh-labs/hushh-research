import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { SafeMarkdown } from "@/components/profile/safe-markdown";

const links = (container: HTMLElement) => [...container.querySelectorAll("a")].map((anchor) => ({
  href: anchor.getAttribute("href"),
  target: anchor.getAttribute("target"),
  rel: anchor.getAttribute("rel"),
  text: anchor.textContent,
}));

describe("SafeMarkdown", () => {
  it("internal policy keeps only an app-relative link and turns every other address into text", () => {
    const markdown = [
      "Email: owner@example.test",
      "Site: https://example.test/path",
      "[Profile](/one/profile/my-data) [Outside](https://outside.example) [Protocol](//outside.example)",
      "[Script](javascript:alert(1)) [Data](data:text/html,hi) [Mail](mailto:owner@example.test)",
    ].join("\n\n");
    const { container } = render(<SafeMarkdown markdown={markdown} linkPolicy="internal" />);
    expect(links(container)).toEqual([{ href: "/one/profile/my-data", target: null, rel: null, text: "Profile" }]);
    for (const text of ["owner@example.test", "https://example.test/path", "Outside", "Protocol", "Script", "Data", "Mail"]) {
      expect(container.textContent).toContain(text);
    }
    expect(container.innerHTML).not.toContain("javascript:");
    expect(container.innerHTML).not.toContain("data:");
  });

  it("external policy opens safe links isolated and renders unsafe ones as text", () => {
    const markdown = "[Site](https://example.test) owner@example.test [Script](javascript:alert(1)) [Data](data:text/html,hi)";
    const { container } = render(<SafeMarkdown markdown={markdown} />);
    expect(links(container)).toEqual([
      { href: "https://example.test", target: "_blank", rel: "noopener noreferrer", text: "Site" },
      { href: "mailto:owner@example.test", target: "_blank", rel: "noopener noreferrer", text: "owner@example.test" },
    ]);
    expect(container.textContent).toContain("Script");
    expect(container.textContent).toContain("Data");
    expect(container.innerHTML).not.toContain("javascript:");
    // The explicit policy is the default one.
    expect(render(<SafeMarkdown markdown={markdown} linkPolicy="external" />).container.innerHTML).toBe(container.innerHTML);
  });

  it("renders a GFM table in the swipe-scroll wrapper and never an image or raw HTML", () => {
    const markdown = "| Field | Value |\n| - | - |\n| Name | Owner |\n\n![Photo](https://example.test/tracker)\n\n<script>alert(1)</script>";
    const { container } = render(<SafeMarkdown markdown={markdown} linkPolicy="internal" />);
    const table = container.querySelector("[data-swipe-views-horizontal-scroll] > table");
    expect(table).not.toBeNull();
    expect(table!.textContent).toContain("Owner");
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector("script")).toBeNull();
    expect(container.textContent).toContain("Photo");
    // Negative control: without GFM the same rows stay text.
    const plain = render(<SafeMarkdown markdown={markdown} gfm={false} linkPolicy="internal" />);
    expect(plain.container.querySelector("table")).toBeNull();
    expect(plain.container.textContent).toContain("| Name | Owner |");
  });
});
