import React from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const service = vi.hoisted(() => ({
  instagramAccountInsight: vi.fn(),
  instagramMediaInsight: vi.fn(),
  instagramComments: vi.fn(),
  instagramReplyToComment: vi.fn(),
  instagramSetCommentHidden: vi.fn(),
  instagramDeleteComment: vi.fn(),
  instagramTaggedMedia: vi.fn(),
  instagramRecentMessages: vi.fn(),
  instagramSendTextMessage: vi.fn(),
}));
vi.mock("@/lib/services/external-connector-service", () => ({
  ExternalConnectorService: service,
  INSTAGRAM_ACCOUNT_METRICS: ["reach", "views"],
  INSTAGRAM_MEDIA_METRICS: ["reach", "likes"],
  validInstagramNumericId: (value: unknown) => typeof value === "string" && /^[0-9]{1,32}$/.test(value),
}));

import { InstagramManage } from "@/components/agent/instagram-manage";

describe("Instagram management", () => {
  beforeEach(() => {
    for (const mock of Object.values(service)) mock.mockReset();
  });
  afterEach(cleanup);

  it("performs no reads or writes until the owner selects an action", async () => {
    service.instagramAccountInsight.mockResolvedValue({ metric: "reach", available: true, value: 18 });
    service.instagramTaggedMedia.mockResolvedValue({ media: [], nextCursor: null });
    render(<InstagramManage vaultOwnerToken="owner-token" />);
    expect(Object.values(service).every((mock) => mock.mock.calls.length === 0)).toBe(true);

    fireEvent.click(screen.getByText("Insights", { selector: "summary" }));
    fireEvent.click(screen.getByRole("button", { name: "View account insight" }));
    await screen.findByText("reach: 18");
    expect(service.instagramAccountInsight).toHaveBeenCalledWith(expect.objectContaining({ vaultOwnerToken: "owner-token", metric: "reach" }));

    fireEvent.click(screen.getByText("Tagged media", { selector: "summary" }));
    fireEvent.click(screen.getByRole("button", { name: "Load tagged posts" }));
    await screen.findByText("No tagged posts found.");
    expect(service.instagramTaggedMedia).toHaveBeenCalledOnce();
    expect(service.instagramSendTextMessage).not.toHaveBeenCalled();
  });

  it("requires review and confirmation before hiding or replying to a comment", async () => {
    service.instagramComments.mockResolvedValue({
      comments: [{ id: "88", text: "hello", username: "alice", timestamp: "today", hidden: false }], nextCursor: null,
    });
    service.instagramSetCommentHidden.mockResolvedValue({ hidden: true });
    service.instagramReplyToComment.mockResolvedValue({ commentId: "89" });
    render(<InstagramManage vaultOwnerToken="owner-token" />);
    fireEvent.click(screen.getByText("Comments", { selector: "summary" }));
    fireEvent.change(screen.getByLabelText("Owned media ID", { selector: "input#instagram-comments-media-id" }), { target: { value: "42" } });
    fireEvent.click(screen.getByRole("button", { name: "Load comments" }));
    await screen.findByText("alice");

    fireEvent.click(screen.getByRole("button", { name: "Hide" }));
    expect(service.instagramSetCommentHidden).not.toHaveBeenCalled();
    expect(screen.getByLabelText("Confirm Instagram comment action")).toHaveTextContent("Confirm hide for comment 88");
    fireEvent.click(screen.getByRole("button", { name: "Confirm hide" }));
    await waitFor(() => expect(service.instagramSetCommentHidden).toHaveBeenCalledOnce());
    expect(service.instagramSetCommentHidden).toHaveBeenCalledWith(expect.objectContaining({ commentId: "88", hidden: true }));
    await screen.findByText(/Comment visibility updated/);

    fireEvent.click(screen.getByRole("button", { name: "Reply" }));
    fireEvent.change(screen.getByLabelText("Reply text"), { target: { value: "Thanks" } });
    expect(service.instagramReplyToComment).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Confirm reply" }));
    await waitFor(() => expect(service.instagramReplyToComment).toHaveBeenCalledWith(expect.objectContaining({ commentId: "88", message: "Thanks" })));
  });

  it("looks up one numeric recipient and requires a second action to send a message", async () => {
    service.instagramRecentMessages.mockResolvedValue({ messages: [{ id: "mid_1", senderId: "77", text: "Hi", createdTime: "today" }] });
    service.instagramSendTextMessage.mockResolvedValue({ messageId: "mid_2" });
    render(<InstagramManage vaultOwnerToken="owner-token" />);
    fireEvent.click(screen.getByText("Messages", { selector: "summary" }));
    const recipient = screen.getByLabelText("Recipient ID");
    fireEvent.change(recipient, { target: { value: "bad/77" } });
    expect(screen.getByRole("button", { name: "Load conversation" })).toBeDisabled();
    fireEvent.change(recipient, { target: { value: "77" } });
    fireEvent.click(screen.getByRole("button", { name: "Load conversation" }));
    await screen.findByText("Hi");
    expect(service.instagramRecentMessages).toHaveBeenCalledWith(expect.objectContaining({ recipientId: "77" }));

    fireEvent.change(screen.getByLabelText("Text reply"), { target: { value: "Hello back" } });
    fireEvent.click(screen.getByRole("button", { name: "Review reply" }));
    expect(service.instagramSendTextMessage).not.toHaveBeenCalled();
    expect(screen.getByLabelText("Confirm Instagram message")).toHaveTextContent("Hello back");
    fireEvent.click(screen.getByRole("button", { name: "Confirm send" }));
    await waitFor(() => expect(service.instagramSendTextMessage).toHaveBeenCalledWith(expect.objectContaining({ recipientId: "77", message: "Hello back" })));
  });
});
