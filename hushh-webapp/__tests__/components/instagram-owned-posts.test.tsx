import React from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const media = vi.hoisted(() => vi.fn());
vi.mock("@/lib/services/external-connector-service", () => ({
  ExternalConnectorService: { instagramOwnedMedia: media },
}));

import { InstagramOwnedPosts } from "@/components/agent/instagram-owned-posts";

const post = (id: string) => ({
  id,
  caption: `Owner post ${id}`,
  mediaType: "IMAGE",
  permalink: `https://www.instagram.com/p/${id}/`,
});

describe("InstagramOwnedPosts", () => {
  beforeEach(() => media.mockReset());
  afterEach(cleanup);

  it("loads only with the current vault owner token and deduplicates later pages", async () => {
    media
      .mockResolvedValueOnce({ posts: [post("one")], nextCursor: "next_page" })
      .mockResolvedValueOnce({ posts: [post("one"), post("two")], nextCursor: null });
    render(<InstagramOwnedPosts vaultOwnerToken="owner-a-token" />);
    expect(await screen.findByText("Owner post one")).toBeInTheDocument();
    expect(screen.getByText("Media ID: one")).toBeInTheDocument();
    expect(media).toHaveBeenCalledWith(expect.objectContaining({
      vaultOwnerToken: "owner-a-token",
    }));
    fireEvent.click(screen.getByRole("button", { name: "Load more posts" }));
    expect(await screen.findByText("Owner post two")).toBeInTheDocument();
    expect(media).toHaveBeenNthCalledWith(2, expect.objectContaining({
      vaultOwnerToken: "owner-a-token", after: "next_page",
    }));
    expect(screen.getAllByRole("link", { name: "Open on Instagram" })).toHaveLength(2);
    expect(screen.queryByRole("button", { name: "Load more posts" })).not.toBeInTheDocument();
  });

  it("clears old posts and ignores a delayed response when the owner token changes", async () => {
    let finishOld!: (page: { posts: ReturnType<typeof post>[]; nextCursor: null }) => void;
    media
      .mockImplementationOnce(() => new Promise((resolve) => { finishOld = resolve; }))
      .mockResolvedValueOnce({ posts: [post("new")], nextCursor: null });
    const view = render(<InstagramOwnedPosts vaultOwnerToken="old-owner-token" />);
    await waitFor(() => expect(media).toHaveBeenCalledTimes(1));
    const oldSignal = media.mock.calls[0][0].signal as AbortSignal;
    view.rerender(<InstagramOwnedPosts vaultOwnerToken="new-owner-token" />);
    expect(oldSignal.aborted).toBe(true);
    expect(await screen.findByText("Owner post new")).toBeInTheDocument();
    expect(media).toHaveBeenNthCalledWith(2, expect.objectContaining({
      vaultOwnerToken: "new-owner-token",
    }));
    await act(async () => finishOld({ posts: [post("old")], nextCursor: null }));
    expect(screen.queryByText("Owner post old")).not.toBeInTheDocument();
    expect(screen.getByText("Owner post new")).toBeInTheDocument();
  });
});
