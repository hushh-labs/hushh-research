// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ApiError } from "@/lib/services/api-client";
import { appInteractionCoordinator } from "@/lib/interaction/interaction-intent-coordinator";
import { CircleChat } from "../circle-chat";
import { CircleChatMessageActionDialog } from "../circle-chat-message-action-dialog";
import type { OpenChatMessage } from "../circle-chat-message";
import * as feedEvents from "@/lib/feed/feed-events";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));

const api = vi.hoisted(() => ({ initialize: vi.fn(), state: vi.fn(), wait: vi.fn(), messages: vi.fn(), prepare: vi.fn(), send: vi.fn(), open: vi.fn(), read: vi.fn(), mute: vi.fn(), image: vi.fn(), refreshFeedRead: vi.fn(), updates: vi.fn(), resolve: vi.fn(), sealMutation: vi.fn(), edit: vi.fn(), delete: vi.fn() }));
vi.mock("@/lib/services/circle-chat-service", () => ({ CircleChatService: api }));
type Observation = { callback: IntersectionObserverCallback; options?: IntersectionObserverInit; target?: Element };
let observations: Observation[];
const session = { userId: "alice", circleId: "circle", vaultKey: "test-key", vaultOwnerToken: "test-token" };
const message = { id: "m1", sequence: 1, senderUserId: "bob", senderName: "Bob", createdAt: "2026-10-02T10:00:00Z" };

beforeEach(() => {
  vi.resetAllMocks(); observations = [];
  vi.stubGlobal("IntersectionObserver", class {
    entry: Observation;
    constructor(callback: IntersectionObserverCallback, options?: IntersectionObserverInit) { this.entry = { callback, options }; observations.push(this.entry); }
    observe(target: Element) { this.entry.target = target; }
    disconnect() {}
  });
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  vi.spyOn(document, "hasFocus").mockReturnValue(true);
  api.initialize.mockResolvedValue(undefined);
  api.state.mockResolvedValue({ unreadCount: 1, latestSequence: 1, members: [], rosterVersion: "v", muted: false });
  api.wait.mockImplementation(() => new Promise(() => {}));
  api.messages.mockResolvedValue({ items: [message], hasMore: false });
  api.updates.mockResolvedValue({ states: [], unavailableIds: [] });
  api.resolve.mockResolvedValue({ items: [] });
  api.open.mockResolvedValue({ text: "Incoming private message", image: null });
  api.read.mockResolvedValue(undefined);
  appInteractionCoordinator.handleLifecycle("active");
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); appInteractionCoordinator.handleLifecycle("active"); });

function observe(inViewport: boolean) {
  act(() => {
    for (const item of observations) item.callback([{ isIntersecting: item.options?.root ? true : inViewport, target: item.target } as IntersectionObserverEntry], {} as IntersectionObserver);
  });
}

async function attachPhoto() {
  const bytes = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 0]);
  const file = new File([bytes], "photo.png", { type: "image/png" });
  Object.defineProperty(file, "arrayBuffer", { value: async () => bytes.buffer });
  fireEvent.change(screen.getByLabelText("Attach photo, video, or document", { selector: "input" }), { target: { files: [file] } });
  fireEvent.load(await screen.findByAltText("Image ready to send"));
  return file;
}

it("fences an old POST after another device deletes the confirmed message", async () => {
  api.messages.mockResolvedValue({ items: [], hasMore: false });
  const sent = { ...message, senderUserId: "alice", clientMessageId: "stable-client", revision: 0 };
  api.open.mockImplementation(async (_session, row) => ({ text: row.senderUserId === "alice" ? "Do not restore" : "Hello" }));
  api.prepare.mockResolvedValue({ clientMessageId: "stable-client" });
  let finishPost!: (value: unknown) => void;
  api.send.mockImplementation(() => new Promise(resolve => { finishPost = resolve; }));
  render(<CircleChat session={session} circleName="Family" initialOpen />);
  await screen.findByText("Start the conversation. Say hello or share a file.");
  fireEvent.change(screen.getByRole("textbox", { name: "Message" }), { target: { value: "Do not restore" } });
  fireEvent.click(screen.getByRole("button", { name: "Send message" }));
  await waitFor(() => expect(finishPost).toBeDefined());
  api.messages.mockResolvedValue({ items: [sent], hasMore: false });
  const changed = () => window.dispatchEvent(new CustomEvent("hushh:circle-chat-changed", { detail: { userId: session.userId, circleId: session.circleId } }));
  act(changed);
  await screen.findByText("Do not restore");
  api.updates.mockResolvedValue({ states: [{ id: sent.id, revision: 1, hidden: false, deletedForEveryoneAt: "2026-10-16T10:00:00Z" }], unavailableIds: [] });
  act(changed);
  await screen.findByText("This message was deleted.");
  await act(async () => finishPost(sent));
  expect(screen.queryByText("Do not restore")).not.toBeInTheDocument();
  expect(screen.getByText("This message was deleted.")).toBeInTheDocument();
});

it("repairs a missed edit doorbell for an old sequence, without accepting a stale page", async () => {
  const old = { ...message, revision: 0 };
  const edited = { ...old, revision: 1, editedAt: "2026-10-16T10:00:00Z" };
  api.messages.mockResolvedValue({ items: [old], hasMore: false });
  api.open.mockImplementation(async (_session, row) => ({ text: row.revision === 1 ? "Corrected message" : "Original message" }));
  api.resolve.mockResolvedValue({ items: [edited] });
  render(<CircleChat session={session} circleName="Family" initialOpen />);
  await screen.findByText("Original message");
  api.updates.mockResolvedValue({ states: [{ id: old.id, revision: 1, hidden: false, deletedForEveryoneAt: null }], unavailableIds: [] });
  // Online is the same repair path as the periodic refresh; no mutation event.
  act(() => window.dispatchEvent(new Event("online")));
  await screen.findByText("Corrected message");
  expect(screen.queryByText("Original message")).not.toBeInTheDocument();
  expect(api.resolve).toHaveBeenCalledWith(session, [old.id], expect.any(AbortSignal));
});

it("retains sealed edit retries, rejects empty drafts and prevents double submission", async () => {
  const own = { ...message, senderUserId: "alice", content: { text: "Original" }, failed: false } as OpenChatMessage;
  const mutation = { ciphertext: "sealed", iv: "fresh", expectedRevision: 0 };
  api.sealMutation.mockResolvedValue(mutation);
  let finish!: (value: unknown) => void;
  api.edit.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; })).mockRejectedValueOnce(new ApiError("offline", 504)).mockResolvedValueOnce({ items: [] });
  const onResult = vi.fn(async () => {}), onClose = vi.fn();
  render(<CircleChatMessageActionDialog session={session} message={own} action="edit" onResult={onResult} onClose={onClose} onAccessError={() => {}} />);
  const save = screen.getByRole("button", { name: "Save changes" });
  const editor = screen.getByRole("textbox", { name: "Edit message text" });
  expect(save).toBeDisabled();
  fireEvent.change(editor, { target: { value: "  " } });
  expect(save).toBeDisabled();
  fireEvent.change(editor, { target: { value: "Corrected 👋 مرحبا" } });
  fireEvent.click(save); fireEvent.click(save);
  await waitFor(() => expect(api.edit).toHaveBeenCalledTimes(1));
  expect(save).toBeDisabled();
  await act(async () => finish(Promise.reject(new ApiError("offline", 504))));
  await screen.findByRole("alert");
  fireEvent.click(save);
  await waitFor(() => expect(api.edit).toHaveBeenCalledTimes(2));
  await waitFor(() => expect(save).toBeEnabled());
  fireEvent.click(save);
  await waitFor(() => expect(onResult).toHaveBeenCalledTimes(1));
  expect(api.sealMutation).toHaveBeenCalledTimes(1);
  expect(api.edit.mock.calls.every(call => call[2] === mutation)).toBe(true);
  expect(onClose).toHaveBeenCalledTimes(1);
});

it("keeps the freshest original when jumping and can leave an empty deleted history window", async () => {
  const target = { ...message, id: "original", sequence: 1, revision: 0 };
  const child = { ...message, id: "child", sequence: 100, replyToMessageId: target.id };
  api.messages.mockImplementation(async (_session, cursor) => cursor.before
    ? { items: [target], hasMore: false }
    : { items: cursor.after ? [] : [child], replyTargets: [target], hasMore: false });
  api.open.mockImplementation(async (_session, row) => ({ text: row.id === child.id ? "Reply body" : row.revision === 1 ? "Corrected original" : "Original body" }));
  api.resolve.mockResolvedValue({ items: [{ ...target, revision: 1 }] });
  render(<CircleChat session={session} circleName="Family" initialOpen />);
  const quote = await screen.findByRole("button", { name: "View original message from Bob" });
  api.updates.mockResolvedValue({ states: [{ id: target.id, revision: 1, hidden: false, deletedForEveryoneAt: null }], unavailableIds: [] });
  fireEvent.click(quote);
  await screen.findByText("Corrected original");
  expect(screen.queryByText("Original body")).not.toBeInTheDocument();
  api.updates.mockResolvedValue({ states: [{ id: target.id, revision: 1, hidden: true, deletedForEveryoneAt: null }], unavailableIds: [] });
  act(() => window.dispatchEvent(new Event("online")));
  await waitFor(() => expect(screen.queryByText("Corrected original")).not.toBeInTheDocument());
  const latest = screen.getByRole("button", { name: "Go to latest messages" });
  fireEvent.click(latest);
  await screen.findByText("Reply body");
  expect(screen.getByText("Original message unavailable")).toBeInTheDocument();
});

it("ignores an obsolete decryption failure after private deletion so later reads can advance", async () => {
  api.open.mockRejectedValueOnce(new Error("Missing key"));
  api.delete.mockResolvedValue({ hiddenId: message.id });
  render(<CircleChat session={session} circleName="Family" initialOpen />);
  await screen.findByText("This message could not be opened on this device.");
  let rejectOld!: (error: Error) => void;
  api.open.mockImplementation(async (_session, row) => row.id === message.id
    ? new Promise((_resolve, reject) => { rejectOld = reject; }) : { text: "A later message" });
  api.messages.mockResolvedValue({ items: [message, { ...message, id: "next", sequence: 2 }], hasMore: false });
  act(() => window.dispatchEvent(new Event("online")));
  await waitFor(() => expect(rejectOld).toBeDefined());
  fireEvent.keyDown(screen.getByRole("button", { name: "Message options" }), { key: "ArrowDown" });
  fireEvent.click(await screen.findByRole("menuitem", { name: "Delete for me" }));
  fireEvent.click(await screen.findByRole("button", { name: "Delete message" }));
  await waitFor(() => expect(screen.queryByText("This message could not be opened on this device.")).not.toBeInTheDocument());
  await act(async () => rejectOld(new Error("Late missing key")));
  await screen.findByText("A later message");
  observe(true);
  await waitFor(() => expect(api.read).toHaveBeenCalledWith(session, 2));
});

it.each([false, true])("keeps the Alerts switch consistent while saving from muted=%s", async (muted) => {
  api.state.mockResolvedValue({ unreadCount: 1, latestSequence: 1, muted });
  let finish!: (value: { muted: boolean }) => void;
  api.mute.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
  render(<CircleChat session={session} circleName="Family" initialOpen />);
  const toggle = await screen.findByRole("switch", { name: "Chat alerts" });
  expect(toggle).toHaveAttribute("aria-checked", String(!muted));
  fireEvent.click(toggle);
  expect(api.mute).toHaveBeenCalledWith(session, !muted);
  expect(toggle).toBeDisabled();
  expect(toggle).toHaveAttribute("aria-checked", String(!muted));
  fireEvent.click(toggle);
  expect(api.mute).toHaveBeenCalledTimes(1);
  await act(async () => finish({ muted: !muted }));
  expect(toggle).toHaveAttribute("aria-checked", String(muted));
  expect(toggle).toBeEnabled();
});

it("preserves Alerts after a failed save and recovers through Reconnect", async () => {
  api.mute.mockRejectedValueOnce(new ApiError("Unavailable", 500)).mockResolvedValueOnce({ muted: true });
  render(<CircleChat session={session} circleName="Family" initialOpen />);
  const toggle = await screen.findByRole("switch", { name: "Chat alerts" });
  fireEvent.click(toggle);
  await screen.findByRole("alert");
  expect(toggle).toHaveAttribute("aria-checked", "true");
  expect(toggle).toBeEnabled();
  fireEvent.click(screen.getByRole("button", { name: "Reconnect" }));
  await waitFor(() => expect(screen.queryByRole("alert")).not.toBeInTheDocument());
  fireEvent.click(screen.getByRole("switch", { name: "Chat alerts" }));
  await waitFor(() => expect(screen.getByRole("switch", { name: "Chat alerts" })).toHaveAttribute("aria-checked", "false"));
});

it("shows the photo before preparation, retries identical ciphertext and reconciles a transcript confirmation before POST", async () => {
  const allocate = vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:local-photo");
  const revoke = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
  let prepare!: (value: unknown) => void;
  let finishPost!: (value: unknown) => void;
  api.prepare.mockImplementationOnce(() => new Promise((resolve) => { prepare = resolve; }));
  api.send.mockRejectedValueOnce(new ApiError("Timed out", 504))
    .mockImplementationOnce(() => new Promise((resolve) => { finishPost = resolve; }));
  render(<CircleChat session={session} circleName="Family" initialOpen />);
  await screen.findByText("Incoming private message");
  await attachPhoto();
  fireEvent.change(screen.getByRole("textbox", { name: "Message" }), { target: { value: "Our photo" } });
  fireEvent.click(screen.getByRole("button", { name: "Send message" }));
  expect(screen.getByText("Sending…")).toBeInTheDocument();
  const photo = await screen.findByAltText("Image shared in circle");
  expect(photo).toHaveAttribute("src", "blob:local-photo");
  expect(api.send).not.toHaveBeenCalled();
  expect(api.image).not.toHaveBeenCalled();
  const id = api.prepare.mock.calls[0]![3].clientMessageId;
  const sealed = { clientMessageId: id, ciphertext: "sealed" };
  await act(async () => prepare(sealed));
  await screen.findByText("Delivery unconfirmed");
  fireEvent.click(screen.getByRole("button", { name: "Retry message" }));
  await waitFor(() => expect(finishPost).toBeDefined());
  expect(api.prepare).toHaveBeenCalledTimes(1);
  expect(api.send.mock.calls[1]![1]).toBe(sealed);
  observe(true);
  fireEvent.click(screen.getByRole("button", { name: "Open shared image" }));
  await screen.findByRole("dialog", { name: "Shared image" });
  api.read.mockClear();
  const sent = { ...message, id: "sent-photo", clientMessageId: id, sequence: 2, senderUserId: "alice", hasImage: true };
  api.open.mockImplementation(async (_session, row) => row.id === sent.id
    ? { text: "Our photo", attachment: { kind: "photo", type: "image/png", name: "photo.png" } }
    : { text: "Incoming private message", image: null });
  api.messages.mockResolvedValue({ items: [sent], hasMore: false, receipts: [{ id: sent.id, recipientCount: 1, readCount: 1 }] });
  act(() => window.dispatchEvent(new CustomEvent("hushh:circle-chat-changed", { detail: { userId: session.userId, circleId: session.circleId } })));
  await screen.findByLabelText("Seen by everyone");
  expect(screen.getAllByAltText("Image shared in circle")).toHaveLength(2); // Transcript and the still-open viewer.
  expect(screen.getAllByAltText("Image shared in circle")[0]).toBe(photo);
  expect(screen.getByRole("dialog", { name: "Shared image" })).toBeInTheDocument();
  expect(screen.queryByText("Sending…")).not.toBeInTheDocument();
  expect(api.read).not.toHaveBeenCalled();
  await act(async () => finishPost(sent));
  expect(screen.getByLabelText("Seen by everyone")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Close", exact: true }));
  await waitFor(() => expect(api.read).toHaveBeenCalledWith(session, 2));
  expect(api.image).not.toHaveBeenCalled();
  act(() => appInteractionCoordinator.handleLifecycle("background"));
  expect(screen.queryByAltText("Image shared in circle")).not.toBeInTheDocument();
  expect(revoke).toHaveBeenCalledWith("blob:local-photo");
  expect(allocate).toHaveBeenCalled();
});

it("removes a definitely rejected photo and ignores preparation completing after a session change", async () => {
  vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:local-photo");
  vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
  api.prepare.mockImplementation(async (_session, _text, _file, preview) => ({ clientMessageId: preview.clientMessageId }));
  api.send.mockRejectedValue(new ApiError("Invalid request", 422));
  const view = render(<CircleChat session={session} circleName="Family" initialOpen />);
  await screen.findByText("Incoming private message");
  await attachPhoto();
  fireEvent.click(screen.getByRole("button", { name: "Send message" }));
  await screen.findByText("Invalid request");
  expect(screen.queryByAltText("Image shared in circle")).not.toBeInTheDocument();
  expect(await screen.findByAltText("Image ready to send")).toBeInTheDocument();
  let prepare!: (value: unknown) => void;
  api.prepare.mockImplementationOnce(() => new Promise((resolve) => { prepare = resolve; }));
  fireEvent.load(screen.getByAltText("Image ready to send"));
  fireEvent.click(screen.getByRole("button", { name: "Send message" }));
  await waitFor(() => expect(prepare).toBeDefined());
  view.rerender(<CircleChat session={{ ...session, vaultOwnerToken: "replacement-token" }} circleName="Family" initialOpen />);
  await act(async () => prepare({ clientMessageId: "obsolete" }));
  expect(api.send).toHaveBeenCalledTimes(1);
  expect(screen.queryByAltText("Image shared in circle")).not.toBeInTheDocument();
});

it("renders an encrypted photo preview during download and releases offscreen originals without blanking the preview", async () => {
  vi.spyOn(URL, "createObjectURL").mockReturnValueOnce("blob:thumbnail").mockReturnValue("blob:original");
  const revoke = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
  const thumbnail = { type: "image/jpeg", data: btoa(String.fromCharCode(255, 216, 255, 0, 0, 0, 0, 0, 0, 0, 0, 0)) };
  api.messages.mockResolvedValue({ items: [{ ...message, hasImage: true }], hasMore: false });
  api.open.mockResolvedValue({ text: "", attachment: { kind: "photo", type: "image/png", name: "photo.png", thumbnail } });
  let download!: (value: Blob) => void;
  api.image.mockImplementationOnce(() => new Promise((resolve) => { download = resolve; }));
  render(<CircleChat session={session} circleName="Family" initialOpen />);
  expect(await screen.findByAltText("Image shared in circle")).toHaveAttribute("src", "blob:thumbnail");
  observe(true);
  await waitFor(() => expect(download).toBeDefined());
  expect(screen.getByAltText("Image shared in circle")).toHaveAttribute("src", "blob:thumbnail");
  await act(async () => download(new Blob(["original"], { type: "image/png" })));
  expect(screen.getByAltText("Image shared in circle")).toHaveAttribute("src", "blob:original");
  observe(false);
  expect(screen.getByAltText("Image shared in circle")).toHaveAttribute("src", "blob:thumbnail");
  expect(revoke).toHaveBeenCalledWith("blob:original");
  expect(api.image).toHaveBeenCalledTimes(1);
  act(() => appInteractionCoordinator.handleLifecycle("background"));
  expect(revoke).toHaveBeenCalledWith("blob:original");
  expect(revoke).toHaveBeenCalledWith("blob:thumbnail");
});

it("does not resurrect a confirmed photo when history eviction precedes a delayed POST failure", async () => {
  vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:photo");
  vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
  api.prepare.mockImplementation(async (_session, _text, _file, preview) => ({ clientMessageId: preview.clientMessageId }));
  let rejectPost!: (error: unknown) => void;
  api.send.mockImplementationOnce(() => new Promise((_resolve, reject) => { rejectPost = reject; }));
  render(<CircleChat session={session} circleName="Family" initialOpen />);
  await screen.findByText("Incoming private message");
  await attachPhoto();
  fireEvent.click(screen.getByRole("button", { name: "Send message" }));
  await waitFor(() => expect(rejectPost).toBeDefined());
  const sent = { ...message, id: "confirmed-photo", clientMessageId: api.prepare.mock.calls[0]![3].clientMessageId, sequence: 2, senderUserId: "alice", hasImage: true };
  api.open.mockImplementation(async (_session, row) => row.id === sent.id
    ? { text: "", attachment: { kind: "photo", type: "image/png", name: "photo.png" } }
    : { text: `Message ${row.sequence}`, image: null });
  api.messages.mockResolvedValueOnce({ items: [sent], hasMore: false });
  const refresh = () => window.dispatchEvent(new CustomEvent("hushh:circle-chat-changed", { detail: { userId: session.userId, circleId: session.circleId } }));
  act(refresh);
  await waitFor(() => expect(screen.queryByText("Sending…")).not.toBeInTheDocument());
  api.messages.mockImplementation(async (_session, page) => {
    const after = page.after ?? 2;
    return { items: Array.from({ length: Math.min(40, 310 - after) }, (_, i) => ({ ...message, id: `m${after + i + 1}`, sequence: after + i + 1 })), hasMore: after + 40 < 310 };
  });
  act(refresh);
  // Photo confirmation plus eight catch-up pages can exceed the default CI test budget.
  await screen.findByText("Message 310", {}, { timeout: 8_000 });
  expect(screen.getByRole("list").children).toHaveLength(300);
  expect(document.querySelector('[data-chat-message="confirmed-photo"]')).not.toBeInTheDocument();
  await act(async () => rejectPost(new ApiError("Timed out", 504)));
  expect(screen.queryByText("Delivery unconfirmed")).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Retry message" })).not.toBeInTheDocument();
}, 15_000);

it("revokes a downloaded image even when unmount wins the state commit", async () => {
  const allocate = vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:uncommitted");
  const revoke = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
  api.open.mockResolvedValue({ text: "", image: { type: "image/png", name: "photo.png" } });
  let download!: (value: Blob) => void;
  api.image.mockImplementationOnce(() => new Promise((resolve) => { download = resolve; }));
  const view = render(<CircleChat session={session} circleName="Family" initialOpen />);
  await screen.findByText("Loading image…");
  // The media observer can subscribe after the loading placeholder commits.
  await waitFor(() => {
    observe(true);
    expect(download).toBeDefined();
  });
  await act(async () => {
    download(new Blob(["fixture"]));
    await Promise.resolve(); await Promise.resolve();
    expect(allocate).toHaveBeenCalled();
    view.unmount();
  });
  expect(revoke).toHaveBeenCalledWith("blob:uncommitted");
});

it("keeps an uncertain retry unchanged across collapse and clears plaintext on access loss", async () => {
  const sealed = { clientMessageId: "same-message-uuid", ciphertext: "opaque" };
  api.prepare.mockResolvedValue(sealed);
  api.send.mockRejectedValueOnce(new ApiError("Timed out", 504)).mockResolvedValueOnce({ ...message, id: "sent", sequence: 2, senderUserId: "alice" });
  render(<CircleChat session={session} circleName="Family" initialOpen />);
  await screen.findByText("Incoming private message");
  fireEvent.change(screen.getByRole("textbox", { name: "Message" }), { target: { value: "my draft" } });
  fireEvent.click(screen.getByRole("button", { name: "Send message" }));
  await screen.findByText(/Delivery is unconfirmed/);
  fireEvent.click(screen.getByRole("button", { name: /Circle chat/ }));
  fireEvent.click(screen.getByRole("button", { name: /Circle chat/ }));
  fireEvent.click(screen.getByRole("button", { name: "Retry message" }));
  await waitFor(() => expect(api.send).toHaveBeenCalledTimes(2));
  expect(api.prepare).toHaveBeenCalledTimes(1);
  expect(api.send.mock.calls[0]![1]).toBe(api.send.mock.calls[1]![1]);
  api.messages.mockRejectedValue(new ApiError("No longer available", 404, { detail: { code: "CIRCLE_CHAT_UNAVAILABLE" } }));
  act(() => window.dispatchEvent(new CustomEvent("hushh:circle-chat-changed", { detail: { userId: session.userId, circleId: session.circleId } })));
  await screen.findByText("You no longer have access to this circle chat.");
  expect(screen.queryByText("Incoming private message")).not.toBeInTheDocument();
});

it("acknowledges only a visible conversation in the foreground", async () => {
  render(<CircleChat session={session} circleName="Family" initialOpen />);
  await screen.findByText("Incoming private message");
  observe(false);
  await act(async () => {});
  expect(api.read).not.toHaveBeenCalled();
  act(() => appInteractionCoordinator.handleLifecycle("background"));
  observe(true);
  await act(async () => {});
  expect(api.read).not.toHaveBeenCalled();
  act(() => appInteractionCoordinator.handleLifecycle("active"));
  await waitFor(() => expect(api.read).toHaveBeenCalledWith(session, 1));
});

it("reconciles reactions on loaded messages and interleaves membership events", async () => {
  render(<CircleChat session={session} circleName="Family" initialOpen />);
  await screen.findByText("Incoming private message");
  api.messages.mockResolvedValueOnce({ items: [], hasMore: false,
    reactionUpdates: [{ id: "m1", reactions: [{ emoji: "❤️", count: 1, reactedByViewer: false }] }],
    events: [{ id: "joined-1", kind: "member_joined", subjectName: "Bob", actorName: "Alice", createdAt: "2026-10-02T10:00:30Z" }],
  });
  act(() => window.dispatchEvent(new CustomEvent("hushh:circle-chat-changed", { detail: { userId: session.userId, circleId: session.circleId } })));
  await screen.findByText("Alice added Bob");
  await screen.findByRole("button", { name: /❤️, 1 reactions/ });
  const rows = screen.getByRole("log", { name: "Circle message history" }).querySelectorAll("li[data-chat-message], li[data-circle-membership-event]");
  expect([...rows].map((row) => row.getAttribute("data-chat-message") ?? row.getAttribute("data-circle-membership-event")))
    .toEqual(["m1", "joined-1"]);
});

it("shows one named activity line for each new group add and keeps old actions separate", async () => {
  const at = (second: number) => `2026-10-02T10:00:${String(second).padStart(2, "0")}Z`;
  api.messages.mockResolvedValue({ items: [], hasMore: false, events: [
    { id: "old-1", kind: "member_joined", subjectName: "Asha", actorName: "Jhumma", createdAt: at(1) },
    { id: "old-2", kind: "member_joined", subjectName: "Bina", actorName: "Jhumma", createdAt: at(2) },
    ...["Divya", "Ms Divya 2", "Roopman", "Smrithi", "Smritika"].map((subjectName, index) => ({
      id: `group-a-${index}`, kind: "member_joined", batchId: "group-a", subjectName,
      actorName: "Jhumma", createdAt: at(3 + index),
    })),
    { id: "group-b-1", kind: "member_joined", batchId: "group-b", subjectName: "Nina", actorName: "Jhumma", createdAt: at(8) },
    { id: "group-b-2", kind: "member_joined", batchId: "group-b", subjectName: "Omar", actorName: "Jhumma", createdAt: at(9) },
  ] });
  render(<CircleChat session={session} circleName="Family" initialOpen />);
  await screen.findByText("Divya, Ms Divya 2, Roopman, Smrithi and Smritika were added");
  expect(screen.getByText("Jhumma added Asha")).toBeInTheDocument();
  expect(screen.getByText("Jhumma added Bina")).toBeInTheDocument();
  expect(screen.getByText("Nina and Omar were added")).toBeInTheDocument();
  expect(screen.queryByText("Jhumma added Divya")).not.toBeInTheDocument();
  expect(screen.getByRole("log", { name: "Circle message history" }).querySelectorAll("li[data-circle-membership-event]")).toHaveLength(4);
});

it("does not restore unread from a state response started before a successful read", async () => {
  render(<CircleChat session={session} circleName="Family" initialOpen />);
  await screen.findByText("Incoming private message");
  let settle!: (value: unknown) => void;
  api.state.mockImplementationOnce(() => new Promise((resolve) => { settle = resolve; }));
  act(() => window.dispatchEvent(new CustomEvent("hushh:circle-chat-changed", { detail: { userId: session.userId, circleId: session.circleId } })));
  await waitFor(() => expect(settle).toBeDefined());
  observe(true);
  await waitFor(() => expect(api.read).toHaveBeenCalledWith(session, 1));
  await act(async () => settle({ unreadCount: 1, latestSequence: 1, members: [], rosterVersion: "v", muted: false }));
  expect(screen.queryByLabelText("1 unread messages")).not.toBeInTheDocument();
});

it("unlocks the unchanged draft after a definite validation rejection", async () => {
  api.prepare.mockResolvedValue({ clientMessageId: "rejected", ciphertext: "opaque" });
  api.send.mockRejectedValue(new ApiError("Invalid request", 422));
  render(<CircleChat session={session} circleName="Family" initialOpen />);
  await screen.findByText("Incoming private message");
  fireEvent.change(screen.getByRole("textbox", { name: "Message" }), { target: { value: "editable draft" } });
  fireEvent.click(screen.getByRole("button", { name: "Send message" }));
  await screen.findByText("Invalid request");
  await waitFor(() => expect(screen.getByRole("textbox", { name: "Message" })).toBeEnabled());
  expect(screen.getByRole("textbox", { name: "Message" })).toHaveValue("editable draft");
  expect(screen.queryByText(/Delivery is unconfirmed/)).not.toBeInTheDocument();
});

it("coalesces matching busy doorbells into an immediate trailing transcript and state refresh", async () => {
  api.open.mockImplementation(async (_session, item) => ({ text: `Message ${item.sequence}`, image: null }));
  render(<CircleChat session={session} circleName="Family" initialOpen />);
  await screen.findByText("Message 1");
  let settleMessages!: (value: unknown) => void;
  let settleState!: (value: unknown) => void;
  api.messages.mockImplementationOnce(() => new Promise((resolve) => { settleMessages = resolve; }))
    .mockResolvedValue({ items: [{ ...message, id: "m3", sequence: 3 }], hasMore: false });
  api.state.mockImplementationOnce(() => new Promise((resolve) => { settleState = resolve; }))
    .mockResolvedValue({ unreadCount: 3, latestSequence: 3, members: [], rosterVersion: "v", muted: false });
  const doorbell = () => window.dispatchEvent(new CustomEvent("hushh:circle-chat-changed", { detail: { userId: session.userId, circleId: session.circleId } }));
  act(doorbell);
  await waitFor(() => expect(settleMessages).toBeDefined());
  await waitFor(() => expect(settleState).toBeDefined());
  act(() => {
    for (let i = 0; i < 8; i++) doorbell();
    window.dispatchEvent(new CustomEvent("hushh:circle-chat-changed", { detail: { userId: "outsider", circleId: session.circleId } }));
  });
  await act(async () => {
    settleMessages({ items: [{ ...message, id: "m2", sequence: 2 }], hasMore: false });
    settleState({ unreadCount: 2, latestSequence: 2, members: [], rosterVersion: "v", muted: false });
  });
  await screen.findByText("Message 3", {}, { timeout: 1000 });
  await screen.findByLabelText("3 unread messages", {}, { timeout: 1000 });
  expect(api.messages).toHaveBeenCalledTimes(3);
  expect(api.state).toHaveBeenCalledTimes(3);
});

it("acknowledges a message arriving during an outstanding read without another focus event", async () => {
  let settle!: () => void;
  api.read.mockImplementationOnce(() => new Promise<void>((resolve) => { settle = resolve; }));
  api.open.mockImplementation(async (_session, item) => ({ text: `Message ${item.sequence}`, image: null }));
  render(<CircleChat session={session} circleName="Family" initialOpen />);
  await screen.findByText("Message 1");
  observe(true);
  await waitFor(() => expect(api.read).toHaveBeenCalledWith(session, 1));
  api.messages.mockResolvedValue({ items: [{ ...message, id: "m2", sequence: 2 }], hasMore: false });
  act(() => window.dispatchEvent(new CustomEvent("hushh:circle-chat-changed", { detail: { userId: session.userId, circleId: session.circleId } })));
  await screen.findByText("Message 2");
  expect(api.read).toHaveBeenCalledTimes(1);
  await act(async () => settle());
  await waitFor(() => expect(api.read).toHaveBeenLastCalledWith(session, 2));
});

it("keeps a non-cancelable wait single-flight through rapid pause/resume and reconnects when it settles", async () => {
  let settle!: (value: unknown) => void;
  api.wait.mockImplementationOnce(() => new Promise((resolve) => { settle = resolve; }));
  render(<CircleChat session={session} circleName="Family" initialOpen />);
  await screen.findByText("Incoming private message");
  act(() => {
    for (let i = 0; i < 5; i++) {
      appInteractionCoordinator.handleLifecycle("background");
      appInteractionCoordinator.handleLifecycle("active");
    }
  });
  expect(api.wait).toHaveBeenCalledTimes(1);
  await act(async () => settle({ latestSequence: 1, changed: false }));
  await waitFor(() => expect(api.wait).toHaveBeenCalledTimes(2), { timeout: 1000 });
});

it("continues reconnect catch-up beyond the first five pages without waiting for a fallback timer", async () => {
  // The five-second fallback must not supply any of the catch-up pages.
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
  try {
    api.open.mockImplementation(async (_session, item) => ({ text: `Message ${item.sequence}`, image: null }));
    render(<CircleChat session={session} circleName="Family" initialOpen />);
    await screen.findByText("Message 1");
    // Mount also queues a visibility refresh. Drain it before measuring the
    // explicit reconnect, regardless of full-suite scheduling.
    await waitFor(() => expect(api.messages).toHaveBeenCalledTimes(2));
    api.messages.mockClear();
    api.messages.mockImplementation(async (_session, page) => {
      const after = page.after ?? 0;
      return {
        items: Array.from({ length: Math.min(40, 206 - after) }, (_, i) => ({ ...message, id: `m${after + i + 1}`, sequence: after + i + 1 })),
        hasMore: after + 40 < 206,
      };
    });
    act(() => window.dispatchEvent(new CustomEvent("hushh:circle-chat-changed", { detail: { userId: session.userId, circleId: session.circleId } })));
    await screen.findByText("Message 206", {}, { timeout: 8_000 });
    expect(screen.getByRole("list").children).toHaveLength(206);
    expect(api.messages.mock.calls.map(([, page]) => page.after)).toEqual([1, 41, 81, 121, 161, 201]);
  } finally {
    cleanup();
    vi.useRealTimers();
  }
}, 15_000);

it("retains a newer receipt when the committed send response arrives late", async () => {
  const own = { ...message, id: "own", sequence: 2, senderUserId: "alice", receipt: { recipientCount: 1, readCount: 0 } };
  let settle!: (value: unknown) => void;
  api.prepare.mockResolvedValue({ clientMessageId: "held" });
  api.send.mockImplementationOnce(() => new Promise((resolve) => { settle = resolve; }));
  render(<CircleChat session={session} circleName="Family" initialOpen />);
  await screen.findByText("Incoming private message");
  fireEvent.change(screen.getByRole("textbox", { name: "Message" }), { target: { value: "hello" } });
  fireEvent.click(screen.getByRole("button", { name: "Send message" }));
  await waitFor(() => expect(settle).toBeDefined());
  api.messages.mockResolvedValue({ items: [own], hasMore: false, receipts: [{ id: "own", recipientCount: 1, readCount: 1 }] });
  act(() => window.dispatchEvent(new CustomEvent("hushh:circle-chat-changed", { detail: { userId: session.userId, circleId: session.circleId } })));
  await screen.findByLabelText("Seen by everyone");
  await act(async () => settle(own));
  expect(screen.getByLabelText("Seen by everyone")).toBeInTheDocument();
});

it("keeps a failed incoming read boundary after more than 300 later messages", async () => {
  api.open.mockImplementation(async (_session, item) => {
    if (item.sequence === 1) throw new Error("Missing key");
    return { text: `Message ${item.sequence}`, image: null };
  });
  render(<CircleChat session={session} circleName="Family" initialOpen />);
  await screen.findByText(/could not be opened/i);
  observe(true);
  api.messages.mockImplementation(async (_session, page) => {
    const after = page.after ?? 0;
    return { items: Array.from({ length: Math.min(40, 326 - after) }, (_, i) => ({ ...message, id: `m${after + i + 1}`, sequence: after + i + 1 })), hasMore: after + 40 < 326 };
  });
  act(() => window.dispatchEvent(new CustomEvent("hushh:circle-chat-changed", { detail: { userId: session.userId, circleId: session.circleId } })));
  // Nine pages and 326 rendered rows need the same shared-runner allowance as the catch-up test above.
  await screen.findByText("Message 326", {}, { timeout: 8_000 });
  observe(true);
  await act(async () => {});
  expect(screen.getByRole("list").children).toHaveLength(300);
  expect(api.read).not.toHaveBeenCalled();
}, 15_000);

it("blocks read acknowledgements while an owned sheet is open and resumes on close", async () => {
  const view = render(<CircleChat session={session} circleName="Family" initialOpen readingBlocked />);
  await screen.findByText("Incoming private message");
  observe(true);
  await act(async () => {});
  expect(api.read).not.toHaveBeenCalled();
  view.rerender(<CircleChat session={session} circleName="Family" initialOpen readingBlocked={false} />);
  await waitFor(() => expect(api.read).toHaveBeenCalledWith(session, 1));
});

it("shows authoritative receipts immediately when loading earlier messages", async () => {
  api.messages.mockImplementation(async (_session, page) => page.before
    ? { items: [{ ...message, id: "older-own", senderUserId: "alice" }], hasMore: false,
        receipts: [{ id: "older-own", recipientCount: 2, readCount: 2 }] }
    : { items: page.after ? [] : [{ ...message, sequence: 2 }], hasMore: !page.after });
  render(<CircleChat session={session} circleName="Family" initialOpen />);
  await screen.findByText("Incoming private message");
  await waitFor(() => expect(screen.getByRole("button", { name: "Load earlier messages" })).toBeEnabled());
  fireEvent.click(screen.getByRole("button", { name: "Load earlier messages" }));
  await screen.findByLabelText("Seen by everyone");
  expect(api.messages).toHaveBeenCalledWith(session, { before: 2 });
});

it("does not send an empty draft through the desktop Enter shortcut", async () => {
  vi.stubGlobal("matchMedia", () => ({ matches: true }));
  render(<CircleChat session={session} circleName="Family" initialOpen />);
  await screen.findByText("Incoming private message");
  fireEvent.keyDown(screen.getByRole("textbox", { name: "Message" }), { key: "Enter" });
  await act(async () => {});
  expect(api.prepare).not.toHaveBeenCalled();
});

it("refreshes Feed when a receipt doorbell also carries a newer message revision", async () => {
  const changed = vi.spyOn(feedEvents, "dispatchFeedStateChanged");
  const waits: ((value: unknown) => void)[] = [];
  api.wait.mockImplementation(() => new Promise((resolve) => { waits.push(resolve); }));
  render(<CircleChat session={session} circleName="Family" initialOpen />);
  await screen.findByText("Incoming private message");
  await act(async () => waits[0]!({ latestSequence: 1, changed: false }));
  await waitFor(() => expect(waits).toHaveLength(2));
  changed.mockClear();
  await act(async () => waits[1]!({ latestSequence: 1, changed: true, receiptsChanged: true }));
  await waitFor(() => expect(waits).toHaveLength(3));
  expect(changed).not.toHaveBeenCalled();
  await act(async () => waits[2]!({ latestSequence: 2, changed: true, receiptsChanged: true }));
  await waitFor(() => expect(changed).toHaveBeenCalledWith("arrived"));
});

it("blocks undecodable image bytes until removed, keeping the text draft available", async () => {
  vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:fixture-preview");
  vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
  render(<CircleChat session={session} circleName="Family" initialOpen />);
  await screen.findByText("Incoming private message");
  fireEvent.change(screen.getByRole("textbox", { name: "Message" }), { target: { value: "Photo caption" } });
  const bytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 0]);
  const brokenFile = new File([bytes], "broken.png", { type: "image/png" });
  Object.defineProperty(brokenFile, "arrayBuffer", { value: async () => bytes.buffer });
  fireEvent.change(screen.getByLabelText("Attach photo, video, or document", { selector: "input" }), { target: { files: [brokenFile] } });
  fireEvent.error(await screen.findByAltText("Image ready to send"));
  expect(screen.getByRole("button", { name: "Send message" })).toBeDisabled();
  expect(api.prepare).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Remove attached image" }));
  expect(screen.getByRole("textbox", { name: "Message" })).toHaveValue("Photo caption");
  expect(screen.getByRole("button", { name: "Send message" })).toBeEnabled();
});
