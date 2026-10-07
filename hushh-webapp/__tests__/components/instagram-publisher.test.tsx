import React from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const preparePost = vi.hoisted(() => vi.fn());
const containerStatus = vi.hoisted(() => vi.fn());
const publishPost = vi.hoisted(() => vi.fn());

vi.mock("@/lib/services/external-connector-service", () => ({
  ExternalConnectorService: {
    instagramPreparePost: preparePost,
    instagramContainerStatus: containerStatus,
    instagramPublishPost: publishPost,
  },
}));

import { InstagramPublisher } from "@/components/agent/instagram-publisher";

const HANDLE = `igc1.container.${"a".repeat(64)}`;

function enterPhoto() {
  fireEvent.change(screen.getByLabelText("Public photo URL"), {
    target: { value: "https://media.example/photo.jpg" },
  });
  fireEvent.change(screen.getByLabelText("Caption"), {
    target: { value: "Owner approved caption" },
  });
}

describe("InstagramPublisher", () => {
  beforeEach(() => {
    preparePost.mockReset();
    containerStatus.mockReset();
    publishPost.mockReset();
  });
  afterEach(cleanup);

  it("requires separate prepare, readiness, and publish actions", async () => {
    const onPublished = vi.fn();
    preparePost.mockResolvedValue({ containerHandle: HANDLE, kind: "photo" });
    containerStatus
      .mockResolvedValueOnce({ kind: "photo", status: "IN_PROGRESS" })
      .mockResolvedValueOnce({ kind: "photo", status: "FINISHED" });
    publishPost.mockResolvedValue({ mediaId: "123" });

    render(<InstagramPublisher vaultOwnerToken="owner-token" onPublished={onPublished} />);
    expect(screen.queryByRole("button", { name: "Publish now" })).not.toBeInTheDocument();
    enterPhoto();
    fireEvent.click(screen.getByRole("button", { name: "Prepare post" }));
    await waitFor(() => expect(preparePost).toHaveBeenCalledOnce());
    expect(preparePost).toHaveBeenCalledWith(expect.objectContaining({
      vaultOwnerToken: "owner-token",
      kind: "photo",
      mediaUrl: "https://media.example/photo.jpg",
      caption: "Owner approved caption",
      signal: expect.any(AbortSignal),
    }));
    expect(await screen.findByRole("button", { name: "Check readiness" })).toBeInTheDocument();
    expect(publishPost).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Check readiness" }));
    expect(await screen.findByText("Instagram status: IN_PROGRESS")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Publish now" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Check readiness" }));
    expect(await screen.findByRole("button", { name: "Publish now" })).toBeInTheDocument();
    expect(publishPost).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Publish now" }));
    await waitFor(() => expect(publishPost).toHaveBeenCalledOnce());
    expect(publishPost).toHaveBeenCalledWith(expect.objectContaining({
      vaultOwnerToken: "owner-token", containerHandle: HANDLE,
      signal: expect.any(AbortSignal),
    }));
    expect(await screen.findByText("Published on Instagram.")).toBeInTheDocument();
    expect(onPublished).toHaveBeenCalledOnce();
  });

  it("does not publish the same container again after an uncertain outcome or show provider details", async () => {
    const onPublished = vi.fn();
    preparePost.mockResolvedValue({ containerHandle: HANDLE, kind: "photo" });
    containerStatus.mockResolvedValue({ kind: "photo", status: "FINISHED" });
    publishPost.mockRejectedValue(new Error("private-provider-response-and-token"));

    render(<InstagramPublisher vaultOwnerToken="owner-token" onPublished={onPublished} />);
    enterPhoto();
    fireEvent.click(screen.getByRole("button", { name: "Prepare post" }));
    fireEvent.click(await screen.findByRole("button", { name: "Check readiness" }));
    fireEvent.click(await screen.findByRole("button", { name: "Publish now" }));

    expect(await screen.findByText(
      "Publication could not be confirmed. Check Instagram before preparing another item.",
    )).toBeInTheDocument();
    expect(screen.queryByText(/private-provider-response-and-token/)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Publish now" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Check readiness" }));
    await waitFor(() => expect(containerStatus).toHaveBeenCalledTimes(2));
    expect(screen.queryByRole("button", { name: "Publish now" })).not.toBeInTheDocument();
    expect(publishPost).toHaveBeenCalledOnce();
    expect(onPublished).not.toHaveBeenCalled();
  });

  it("prepares a Story without a caption and still requires a separate publish action", async () => {
    preparePost.mockResolvedValue({ containerHandle: HANDLE, kind: "story" });
    render(<InstagramPublisher vaultOwnerToken="owner-token" onPublished={vi.fn()} />);
    fireEvent.change(screen.getByLabelText("Media type"), { target: { value: "story_image" } });
    expect(screen.queryByLabelText("Caption")).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Public photo URL"), {
      target: { value: "https://media.example/story.jpg" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Prepare story" }));
    await waitFor(() => expect(preparePost).toHaveBeenCalledWith(expect.objectContaining({
      kind: "story_image", mediaUrl: "https://media.example/story.jpg", caption: "",
    })));
    expect(screen.getByRole("button", { name: "Check readiness" })).toBeInTheDocument();
    expect(publishPost).not.toHaveBeenCalled();
  });

  it("aborts an in-flight publish on disconnect and ignores its late success", async () => {
    let finishPublish!: (value: { mediaId: string }) => void;
    preparePost.mockResolvedValue({ containerHandle: HANDLE, kind: "photo" });
    containerStatus.mockResolvedValue({ kind: "photo", status: "FINISHED" });
    publishPost.mockImplementationOnce(() => new Promise((resolve) => { finishPublish = resolve; }));
    const onPublished = vi.fn();

    const view = render(<InstagramPublisher vaultOwnerToken="owner-token" onPublished={onPublished} />);
    enterPhoto();
    fireEvent.click(screen.getByRole("button", { name: "Prepare post" }));
    fireEvent.click(await screen.findByRole("button", { name: "Check readiness" }));
    fireEvent.click(await screen.findByRole("button", { name: "Publish now" }));
    await waitFor(() => expect(publishPost).toHaveBeenCalledOnce());
    const signal = publishPost.mock.calls[0][0].signal as AbortSignal;
    expect(signal.aborted).toBe(false);

    view.unmount();
    expect(signal.aborted).toBe(true);
    await act(async () => finishPublish({ mediaId: "123" }));
    expect(onPublished).not.toHaveBeenCalled();
  });

  it("clears the old owner's draft and aborts a pending request on account change", async () => {
    let finishPrepare!: (value: { containerHandle: string; kind: string }) => void;
    preparePost.mockImplementationOnce(() => new Promise((resolve) => { finishPrepare = resolve; }));
    const view = render(<InstagramPublisher vaultOwnerToken="old-owner" onPublished={vi.fn()} />);
    enterPhoto();
    fireEvent.click(screen.getByRole("button", { name: "Prepare post" }));
    await waitFor(() => expect(preparePost).toHaveBeenCalledOnce());
    const oldSignal = preparePost.mock.calls[0][0].signal as AbortSignal;

    view.rerender(<InstagramPublisher vaultOwnerToken="new-owner" onPublished={vi.fn()} />);
    expect(oldSignal.aborted).toBe(true);
    await act(async () => finishPrepare({ containerHandle: HANDLE, kind: "photo" }));
    expect(screen.getByLabelText("Public photo URL")).toHaveValue("");
    expect(screen.queryByRole("button", { name: "Check readiness" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Publish now" })).not.toBeInTheDocument();
  });
});
