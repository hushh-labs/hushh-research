import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const push = vi.hoisted(() => vi.fn());

vi.mock("next/navigation", () => ({ useRouter: () => ({ push }) }));

import { AgentMarkdown } from "@/components/agent/agent-markdown";
import { ChatMarkdownLink } from "@/components/agent/chat-markdown-link";
import {
  chatUrlTransform,
  classifyChatHref,
  findPhoneNumbers,
  formatBareUrlLabel,
} from "@/lib/agent/chat-links";

describe("ChatMarkdownLink", () => {
  beforeEach(() => {
    push.mockClear();
    vi.restoreAllMocks();
  });

  it("keeps relative app links in the current tab", () => {
    render(<ChatMarkdownLink href="/one/profile?profile_pane=1">Profile</ChatMarkdownLink>);
    const link = screen.getByRole("link", { name: "Profile" });
    expect(link).toHaveAttribute("href", "/one/profile?profile_pane=1");
    expect(link).not.toHaveAttribute("target", "_blank");
  });

  it("routes same-origin absolute links without a page reload", () => {
    const href = `${window.location.origin}/one/profile?profile_pane=1`;
    render(<ChatMarkdownLink href={href}>Shared information</ChatMarkdownLink>);
    fireEvent.click(screen.getByRole("link", { name: "Shared information" }));
    expect(push).toHaveBeenCalledWith("/one/profile?profile_pane=1");
  });

  it("keeps external links separate and blocks unsafe schemes", () => {
    const { rerender } = render(<ChatMarkdownLink href="https://example.com">Source</ChatMarkdownLink>);
    const open = vi.spyOn(window, "open").mockReturnValue(null);
    const link = screen.getByRole("link", { name: "Source" });
    expect(link).toHaveAttribute("target", "_blank");
    expect(link).toHaveAttribute("rel", "noopener noreferrer");
    fireEvent.click(link);
    expect(push).not.toHaveBeenCalled();
    // The app's one external opener, which Capacitor hands to the OS.
    expect(open).toHaveBeenCalledWith("https://example.com/", "_blank", "noopener,noreferrer");

    rerender(<ChatMarkdownLink href="javascript:alert(1)">Unsafe</ChatMarkdownLink>);
    expect(screen.queryByRole("link", { name: "Unsafe" })).toBeNull();
    expect(screen.getByText("Unsafe")).toBeInTheDocument();
  });
});
describe("chat link policy", () => {
  it("allows only http, https, mailto, tel, app paths and in-answer anchors", () => {
    expect(classifyChatHref("https://example.com")).toBe("external");
    expect(classifyChatHref("http://example.com")).toBe("external");
    expect(classifyChatHref("mailto:maya@example.org")).toBe("mailto");
    expect(classifyChatHref("tel:+16505550142")).toBe("tel");
    expect(classifyChatHref("/one/profile")).toBe("internal");
    expect(classifyChatHref("#am-r1-fn-1")).toBe("anchor");
    for (const hostile of [
      "javascript:alert(1)",
      "JaVaScRiPt:alert(1)",
      " javascript:alert(1)",
      "java\nscript:alert(1)",
      "java\tscript:alert(1)",
      "data:text/html,<script>alert(1)</script>",
      "vbscript:msgbox(1)",
      "file:///etc/passwd",
      "//evil.example.com",
      "/\\evil.example.com",
      "",
    ]) {
      expect(classifyChatHref(hostile), hostile).toBe("unsafe");
      expect(chatUrlTransform(hostile), hostile).toBe("");
    }
  });

  it("renders a javascript: or data: link in an answer as inert text (negative control: an https link stays a link)", () => {
    render(
      <AgentMarkdown
        text={"[safe](https://example.com) [bad](javascript:alert(1)) [worse](data:text/html,x) [split](java\tscript:alert(1))"}
      />,
    );
    expect(screen.getByRole("link", { name: "safe" })).toHaveAttribute("href", "https://example.com");
    for (const name of ["bad", "worse"]) {
      expect(screen.queryByRole("link", { name })).toBeNull();
      expect(screen.getByText(name)).toBeInTheDocument();
    }
    // A tab inside the destination is not a link at all in CommonMark.
    expect(screen.queryByRole("link", { name: /split/ })).toBeNull();
    expect(document.querySelector("a[href^='javascript' i], a[href^='data:' i]")).toBeNull();
  });

  it("never loads an image an answer mentions; it becomes a link to open", () => {
    render(<AgentMarkdown text={"![receipt](https://tracker.example.com/p.gif?id=42)"} />);
    expect(document.querySelector("img")).toBeNull();
    expect(screen.getByRole("link", { name: "receipt" })).toHaveAttribute(
      "href",
      "https://tracker.example.com/p.gif?id=42",
    );
  });

  it("detects bare URLs without swallowing trailing punctuation or unbalanced parentheses", () => {
    render(
      <AgentMarkdown
        text={
          "See https://example.com/a?b=1&c=2. Then (background: https://en.wikipedia.org/wiki/Lisbon_(disambiguation)), www.example.com/guides/lisbon, and write to maya@example.org."
        }
      />,
    );
    const hrefs = [...document.querySelectorAll("a")].map((a) => a.getAttribute("href"));
    expect(hrefs).toEqual([
      "https://example.com/a?b=1&c=2",
      "https://en.wikipedia.org/wiki/Lisbon_(disambiguation)",
      "http://www.example.com/guides/lisbon",
      "mailto:maya@example.org",
    ]);
    // Bare web URLs become compact chips that name the site; the email stays prose.
    expect(document.querySelectorAll("[data-agent-link-chip]")).toHaveLength(3);
    expect(screen.getByRole("link", { name: "en.wikipedia.org/wiki/Lisbon_(disambigua…" })).toHaveAttribute(
      "title",
      "https://en.wikipedia.org/wiki/Lisbon_(disambiguation)",
    );
    expect(screen.getByRole("link", { name: "maya@example.org" }).closest("[data-agent-link-chip]")).toBeNull();
  });

  it("keeps a written link label as prose rather than a chip", () => {
    render(<AgentMarkdown text={"[her profile](https://stanfordhealthcare.org/doctors/p/maya-patel.html)"} />);
    const link = screen.getByRole("link", { name: "her profile" });
    expect(link.closest("[data-agent-link-chip]")).toBeNull();
    expect(link).toHaveAttribute("title", "https://stanfordhealthcare.org/doctors/p/maya-patel.html");
  });

  it("summarises a long bare URL to its site and a short path", () => {
    expect(
      formatBareUrlLabel("https://www.google.com/travel/flights/search?tfs=CBwQAhoo&hl=en-US"),
    ).toEqual({ host: "google.com", path: "/travel/flights/search…" });
    expect(formatBareUrlLabel("https://example.com/")).toEqual({ host: "example.com", path: "" });
    expect(formatBareUrlLabel("https://example.com/?q=1")).toEqual({ host: "example.com", path: "/…" });
  });

  it("links phone numbers without mistaking dates, amounts or card numbers for one", () => {
    expect(findPhoneNumbers("Call +1 (650) 555-0142 today").map((m) => m.href)).toEqual(["tel:+16505550142"]);
    expect(findPhoneNumbers("Office: (415) 555-0132 or 415.555.0199").map((m) => m.href)).toEqual([
      "tel:4155550132",
      "tel:4155550199",
    ]);
    expect(findPhoneNumbers("London +44 20 7946 0958.").map((m) => m.text)).toEqual(["+44 20 7946 0958"]);
    for (const notAPhone of [
      "Updated 2026-09-29 08:15",
      "Card 4111 1111 1111 1111",
      "Total $1,012.00 across 3 accounts",
      "Ext 555-0142",
      "Order 1234-567-8901",
      "https://example.com/415-555-0132",
    ]) {
      expect(findPhoneNumbers(notAPhone), notAPhone).toEqual([]);
    }
    render(<AgentMarkdown text={"Call +1 (650) 555-0142, not `415-555-0132`."} />);
    expect(screen.getByRole("link", { name: "+1 (650) 555-0142" })).toHaveAttribute("href", "tel:+16505550142");
    expect(screen.queryByRole("link", { name: "415-555-0132" })).toBeNull();
  });
});
