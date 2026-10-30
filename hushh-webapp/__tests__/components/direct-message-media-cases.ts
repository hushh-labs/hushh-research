import { DirectMessageVoiceRecorder } from "@/components/direct-messages/direct-message-voice-recorder";
import { DirectMessageVoicePlayer } from "@/components/direct-messages/direct-message-voice-player";
import { appInteractionCoordinator } from "@/lib/interaction/interaction-intent-coordinator";
import { act, fireEvent, render, screen, waitFor, within, type RenderResult } from "@testing-library/react";
import { expect, it, vi, type Mock } from "vitest";
import { createElement, type ReactElement } from "react";
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

type VoiceCaseContext = {
  mocks: {
    captureStart: Mock; captureFinish: Mock; captureCancel: Mock;
    captureInstances: unknown[]; morphyToast: { error: Mock };
  };
  validVoiceWav: () => Uint8Array;
};

export function registerDirectMessageVoiceCases({ mocks, validVoiceWav }: VoiceCaseContext) {
  it("reuses a permission-granted capture on retry and discards a late finished recording after backgrounding", async () => {
    mocks.captureStart.mockRejectedValueOnce(new Error("Microphone permission updated. Tap Talk to One to record."));
    const onRecorded = vi.fn(), onRecordingChange = vi.fn();
    render(createElement(DirectMessageVoiceRecorder, { disabled: false, onRecorded, onRecordingChange }));
    fireEvent.click(screen.getByRole("button", { name: "Record voice message" }));
    await waitFor(() => expect(mocks.morphyToast.error).toHaveBeenCalledWith("Microphone enabled. Tap the mic again to record."));
    fireEvent.click(screen.getByRole("button", { name: "Record voice message" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Send voice message" })).toBeEnabled());
    expect(mocks.captureInstances).toHaveLength(1);
    let finish!: (value: unknown) => void;
    mocks.captureFinish.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    fireEvent.click(screen.getByRole("button", { name: "Send voice message" }));
    act(() => appInteractionCoordinator.handleLifecycle("background"));
    await act(async () => { finish({ audioBase64: "invalid-stale-bytes" }); });
    expect(onRecorded).not.toHaveBeenCalled();
    expect(mocks.captureCancel).toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Record voice message" })).toBeEnabled();
  });

  it("never lets a pending voice download supersede a newer recording", async () => {
    let loaded!: (blob: Blob) => void;
    const loadAudio = vi.fn(() => new Promise<Blob>(resolve => { loaded = resolve; }));
    const createObjectURL = vi.fn(); vi.stubGlobal("URL", class extends URL { static createObjectURL = createObjectURL; });
    render(createElement(DirectMessageVoicePlayer, { durationMs: 1000, loadAudio }));
    fireEvent.click(screen.getByRole("button", { name: "Play voice message" }));
    const recording = appInteractionCoordinator.acquireVoiceLease({ owner: "new-recording", onRevoked: vi.fn() });
    await act(async () => { loaded({ arrayBuffer: async () => validVoiceWav().buffer } as Blob); });
    expect(recording.isCurrent()).toBe(true);
    expect(createObjectURL).not.toHaveBeenCalled();
    recording.release();
  });

  it("uses the latest playback speed after a voice download and releases playback resources", async () => {
    let loaded!: (blob: Blob) => void;
    const player = { paused: true, playbackRate: 1, src: "", pause: vi.fn(), play: vi.fn().mockResolvedValue(undefined) };
    const revokeObjectURL = vi.fn();
    vi.stubGlobal("Audio", vi.fn(function () { return player; }));
    vi.stubGlobal("URL", class extends URL {
      static createObjectURL = vi.fn(() => "blob:voice");
      static revokeObjectURL = revokeObjectURL;
    });
    const view = render(createElement(DirectMessageVoicePlayer, { durationMs: 1000, loadAudio: () => new Promise<Blob>(resolve => { loaded = resolve; }) }));
    fireEvent.click(screen.getByRole("button", { name: "Play voice message" }));
    fireEvent.click(screen.getByRole("button", { name: "Playback speed 1x" }));
    fireEvent.click(screen.getByRole("button", { name: "Playback speed 1.5x" }));
    await act(async () => { loaded({ arrayBuffer: async () => validVoiceWav().buffer } as Blob); });
    expect(player.play).toHaveBeenCalledOnce();
    expect(player.playbackRate).toBe(2);
    view.unmount();
    expect(player.pause).toHaveBeenCalledOnce();
    expect(player.src).toBe("");
    expect(revokeObjectURL).toHaveBeenCalledExactlyOnceWith("blob:voice");
  });

  it("validates a bounded WAV before handing it to the send owner and releases the microphone", async () => {
    mocks.captureFinish.mockResolvedValue({ audioBase64: btoa(String.fromCharCode(...validVoiceWav())), mimeType: "audio/wav" });
    const onRecorded = vi.fn(), onRecordingChange = vi.fn();
    render(createElement(DirectMessageVoiceRecorder, { disabled: false, onRecorded, onRecordingChange }));
    fireEvent.click(screen.getByRole("button", { name: "Record voice message" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Send voice message" })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "Send voice message" }));
    await waitFor(() => expect(onRecorded).toHaveBeenCalledOnce());
    expect(onRecorded.mock.calls[0]![0]).toMatchObject({ name: "Voice message.wav", type: "audio/wav", size: 32044 });
    expect(mocks.sendMessage).not.toHaveBeenCalled();
    expect(onRecordingChange).toHaveBeenLastCalledWith(false);
    expect(mocks.captureCancel).toHaveBeenCalled();
  });

  it("returns to idle without sending when the microphone ends unexpectedly", async () => {
    const onRecorded = vi.fn();
    render(createElement(DirectMessageVoiceRecorder, { disabled: false, onRecorded, onRecordingChange: vi.fn() }));
    fireEvent.click(screen.getByRole("button", { name: "Record voice message" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Send voice message" })).toBeEnabled());
    act(() => mocks.captureStart.mock.calls[0]![3]());
    expect(screen.getByRole("button", { name: "Record voice message" })).toBeEnabled();
    expect(mocks.morphyToast.error).toHaveBeenCalledWith("The microphone disconnected. Record your message again.");
    expect(onRecorded).not.toHaveBeenCalled();
    expect(mocks.captureFinish).not.toHaveBeenCalled();
  });

}
