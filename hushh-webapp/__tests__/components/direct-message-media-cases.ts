import { act, fireEvent, screen, waitFor, within, type RenderResult } from "@testing-library/react";
import { expect, it, vi, type Mock } from "vitest";
import type { ReactElement } from "react";
import type { DirectMessage, DirectMessageConversation } from "@/lib/services/direct-messages-service";
import * as fileSharing from "@/lib/share/share-file";

type MediaCaseContext = {
  mocks: {
    conversation: DirectMessageConversation;
    getConversationMessages: Mock;
    getAttachment: Mock;
    morphyToast: { error: Mock };
    search: string;
    user: { uid: string; getIdToken: Mock };
  };
  visibleMessage: DirectMessage;
  renderConnectionThread: () => RenderResult;
  connectionThread: () => ReactElement;
};

// Register at the original positions inside the suite, reusing its setup and cleanup.
export function registerDirectMessageVideoCases({ mocks, visibleMessage, renderConnectionThread, connectionThread }: MediaCaseContext) {
  it("loads videos on request, retries failures, and releases URLs on reload and unmount", async () => {
    const share = vi.spyOn(fileSharing, "shareFile").mockResolvedValue("download");
    const create = vi.fn().mockReturnValueOnce("blob:first-video").mockReturnValueOnce("blob:second-video"), revoke = vi.fn();
    vi.stubGlobal("URL", class extends URL { static createObjectURL = create; static revokeObjectURL = revoke; });
    mocks.getConversationMessages.mockResolvedValue({ conversation: mocks.conversation,
      items: [{ ...visibleMessage, content: "", attachment: { kind: "video", name: "Clip.mp4", mimeType: "video/mp4", size: 24 } }],
      canSend: true, disconnectedNotice: null, nextBefore: null });
    mocks.getAttachment.mockRejectedValueOnce(new Error("Temporary video download failure"))
      .mockResolvedValue(new Blob(["synthetic video"], { type: "video/mp4" }));
    const view = renderConnectionThread();
    const open = await screen.findByRole("button", { name: "Open video", exact: true });
    expect(mocks.getAttachment).not.toHaveBeenCalled();
    expect(screen.queryByLabelText("Video: Clip.mp4")).not.toBeInTheDocument();
    fireEvent.click(open);
    await waitFor(() => expect(mocks.morphyToast.error).toHaveBeenCalledWith("This attachment is unavailable. Try again."));
    await waitFor(() => expect(open).toBeEnabled());
    fireEvent.click(open);
    expect(await screen.findByLabelText("Video: Clip.mp4")).toHaveAttribute("src", "blob:first-video");
    fireEvent.click(screen.getByRole("button", { name: "Reload video", exact: true }));
    await waitFor(() => expect(screen.getByLabelText("Video: Clip.mp4")).toHaveAttribute("src", "blob:second-video"));
    expect(revoke).toHaveBeenCalledWith("blob:first-video");
    fireEvent.click(screen.getByRole("button", { name: "Download Clip.mp4", exact: true }));
    await waitFor(() => expect(share).toHaveBeenCalledWith({
      file: expect.objectContaining({ name: "Clip.mp4", type: "video/mp4" }), title: "Clip.mp4", isEffectCurrent: expect.any(Function),
    }));
    expect(screen.getByLabelText("Video: Clip.mp4")).toHaveAttribute("src", "blob:second-video");
    view.unmount();
    expect(revoke).toHaveBeenCalledWith("blob:second-video");
  });

  it.each(["owner", "conversation", "lane"] as const)("rejects a pending video after its %s changes", async (change) => {
    const create = vi.fn(), revoke = vi.fn();
    vi.stubGlobal("URL", class extends URL { static createObjectURL = create; static revokeObjectURL = revoke; });
    mocks.search = "conversation=conversation-1";
    mocks.getConversationMessages.mockResolvedValue({ conversation: mocks.conversation,
      items: [{ ...visibleMessage, content: "", attachment: { kind: "video", name: "Clip.mp4", mimeType: "video/mp4", size: 24 } }],
      canSend: true, disconnectedNotice: null, nextBefore: null });
    let finish!: (blob: Blob) => void;
    mocks.getAttachment.mockImplementation(() => new Promise<Blob>(resolve => { finish = resolve; }));
    const view = renderConnectionThread();
    fireEvent.click(await screen.findByRole("button", { name: "Open video", exact: true }));
    await waitFor(() => expect(mocks.getAttachment).toHaveBeenCalledOnce());
    const input = mocks.getAttachment.mock.calls[0]![0];
    if (change === "lane") fireEvent.click(screen.getByRole("tab", { name: "Circles 0", exact: true }));
    else {
      if (change === "owner") mocks.user = { uid: "viewer-2", getIdToken: vi.fn().mockResolvedValue("second-token") };
      else mocks.search = "conversation=conversation-2";
      view.rerender(connectionThread());
    }
    expect(input.isEffectCurrent()).toBe(false);
    await act(async () => finish(new Blob(["retired video"], { type: "video/mp4" })));
    expect(create).not.toHaveBeenCalled();
    expect(screen.queryByLabelText("Video: Clip.mp4")).not.toBeInTheDocument();
    view.unmount();
  });

}

export function registerDirectMessagePhotoPreviewCase({ renderConnectionThread }: Pick<MediaCaseContext, "renderConnectionThread">) {
  it("previews selected photos instead of filenames and releases their local URLs", async () => {
    const create = vi.fn().mockReturnValueOnce("blob:first").mockReturnValueOnce("blob:second"), revoke = vi.fn();
    vi.stubGlobal("URL", class extends URL { static createObjectURL = create; static revokeObjectURL = revoke; });
    const view = renderConnectionThread();
    await screen.findByRole("textbox", { name: "Message Ankit Kumar Singh" });
    const input = document.querySelector('input[accept="image/jpeg,image/png,image/webp"]')!;
    fireEvent.change(input, { target: { files: [new File(["photo"], "private-photo.png", { type: "image/png" })] } });
    expect(await screen.findByRole("img", { name: "Photo ready to send" })).toHaveAttribute("src", "blob:first");
    expect(screen.queryByText(/private-photo.png/)).not.toBeInTheDocument();
    fireEvent.change(input, { target: { files: [new File(["second"], "second.png", { type: "image/png" })] } });
    await waitFor(() => expect(revoke).toHaveBeenCalledWith("blob:first"));
    expect(screen.getByRole("img", { name: "Photo ready to send" })).toHaveAttribute("src", "blob:second");
    fireEvent.click(screen.getByRole("button", { name: "Remove attachment" }));
    await waitFor(() => expect(revoke).toHaveBeenCalledWith("blob:second"));
    expect(screen.queryByRole("img", { name: "Photo ready to send" })).not.toBeInTheDocument();
    view.unmount();
  });

}

export function registerDirectMessageReplyCases({ mocks, visibleMessage, renderConnectionThread }: Pick<MediaCaseContext, "mocks" | "visibleMessage" | "renderConnectionThread">) {
  it("describes attachment-only replies without revealing deleted quote text", async () => {
    vi.spyOn(document, "hasFocus").mockReturnValue(true);
    const original = { ...visibleMessage, content: "", attachment: { kind: "document", name: "Notes.pdf", mimeType: "application/pdf", size: 24 } };
    const reply = { ...visibleMessage, id: "reply", senderIsViewer: true, content: "Thanks",
      replyTo: { id: original.id, content: "", senderIsViewer: false, deletedForEveryoneAt: null } };
    mocks.getConversationMessages.mockResolvedValue({ conversation: mocks.conversation, items: [original, reply], canSend: true, disconnectedNotice: null, nextBefore: null });
    const view = renderConnectionThread();
    const quote = await screen.findByRole("button", { name: "Go to original message from Ankit Kumar Singh" });
    expect(quote).toHaveTextContent("Attachment");
    const row = screen.getByText("Notes.pdf").closest("article")!;
    fireEvent.keyDown(within(row).getByRole("button", { name: "Message options" }), { key: "Enter" });
    fireEvent.click(await screen.findByRole("menuitem", { name: "Reply", exact: true }));
    expect(document.querySelector('[class*="composerReplyPreview"]')).toHaveTextContent("Attachment");
    mocks.getConversationMessages.mockResolvedValue({ conversation: mocks.conversation, items: [original, { ...reply,
      replyTo: { ...reply.replyTo, content: "Deleted private text", deletedForEveryoneAt: "2026-10-06T10:02:00Z" } }], canSend: true, disconnectedNotice: null, nextBefore: null });
    act(() => window.dispatchEvent(new Event("focus")));
    await waitFor(() => expect(quote).toHaveTextContent("This message was deleted."));
    expect(quote).not.toHaveTextContent("Deleted private text");
    view.unmount();
  });

}
