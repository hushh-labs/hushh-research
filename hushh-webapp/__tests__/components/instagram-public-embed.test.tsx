import React from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const apiFetch = vi.hoisted(() => vi.fn());
vi.mock("@/lib/services/api-service", () => ({
  ApiService: {
    apiFetch,
    getAuthHeaders: (token: string) => ({ Authorization: `Bearer ${token}` }),
  },
}));

import { InstagramPublicEmbed } from "@/components/agent/instagram-public-embed";

describe("public Instagram preview", () => {
  beforeEach(() => apiFetch.mockReset());
  afterEach(cleanup);

  it("requests a canonical post and isolates Meta's HTML inside a sandboxed iframe", async () => {
    const html = '<blockquote class="instagram-media">Public post</blockquote>';
    apiFetch.mockResolvedValue(Response.json({ html }));
    render(<InstagramPublicEmbed vaultOwnerToken="owner-token" />);

    fireEvent.change(screen.getByLabelText("Instagram post URL"), {
      target: { value: "https://instagram.com/p/ABC_123/?igsh=share-id" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Preview post" }));

    const frame = await screen.findByTitle("Public Instagram post preview");
    expect(frame).toHaveAttribute("sandbox", "allow-scripts");
    expect(frame).toHaveAttribute("referrerpolicy", "no-referrer");
    expect(frame.getAttribute("srcdoc")).toContain(html);
    expect(frame.getAttribute("srcdoc")).toContain("https://www.instagram.com/embed.js");
    expect(apiFetch).toHaveBeenCalledWith(
      expect.stringMatching(/^\/api\/connectors\/instagram\/oembed\?/),
      expect.objectContaining({
        method: "GET",
        cache: "no-store",
        headers: { Authorization: "Bearer owner-token" },
      }),
    );
    const requested = apiFetch.mock.calls[0]?.[0] as string;
    expect(new URL(requested, "https://one.example").searchParams.get("url"))
      .toBe("https://www.instagram.com/p/ABC_123/");
  });

  it("rejects unsupported URLs locally and clears a stale preview on edits", async () => {
    const html = '<blockquote class="instagram-media">Public post</blockquote>';
    apiFetch.mockResolvedValue(Response.json({ html }));
    render(<InstagramPublicEmbed vaultOwnerToken="owner-token" />);
    const input = screen.getByLabelText("Instagram post URL");

    fireEvent.change(input, { target: { value: "https://www.instagram.com/p/ABC123/" } });
    fireEvent.click(screen.getByRole("button", { name: "Preview post" }));
    await screen.findByTitle("Public Instagram post preview");

    fireEvent.change(input, { target: { value: "https://www.instagram.com/stories/a/123/" } });
    expect(screen.queryByTitle("Public Instagram post preview")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Preview post" }));
    expect(screen.getByRole("status")).toHaveTextContent("Enter a public Instagram post or Reel URL.");
    await waitFor(() => expect(apiFetch).toHaveBeenCalledTimes(1));
  });
});
