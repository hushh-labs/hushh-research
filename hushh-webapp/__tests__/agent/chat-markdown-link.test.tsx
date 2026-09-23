import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const push = vi.hoisted(() => vi.fn());

vi.mock("next/navigation", () => ({ useRouter: () => ({ push }) }));

import { ChatMarkdownLink } from "@/components/agent/chat-markdown-link";

describe("ChatMarkdownLink", () => {
  beforeEach(() => push.mockClear());

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
    const link = screen.getByRole("link", { name: "Source" });
    expect(link).toHaveAttribute("target", "_blank");
    expect(link).toHaveAttribute("rel", "noopener noreferrer");
    fireEvent.click(link);
    expect(push).not.toHaveBeenCalled();

    rerender(<ChatMarkdownLink href="javascript:alert(1)">Unsafe</ChatMarkdownLink>);
    expect(screen.queryByRole("link", { name: "Unsafe" })).toBeNull();
    expect(screen.getByText("Unsafe")).toBeInTheDocument();
  });
});
