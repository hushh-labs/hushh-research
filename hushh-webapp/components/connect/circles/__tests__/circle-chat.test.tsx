// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ApiError } from "@/lib/services/api-client";
import { appInteractionCoordinator } from "@/lib/interaction/interaction-intent-coordinator";
import { CircleChat } from "../circle-chat";
import * as feedEvents from "@/lib/feed/feed-events";

const api = vi.hoisted(() => ({ initialize: vi.fn(), state: vi.fn(), wait: vi.fn(), messages: vi.fn(), prepare: vi.fn(), send: vi.fn(), open: vi.fn(), read: vi.fn(), mute: vi.fn(), image: vi.fn(), refreshFeedRead: vi.fn() }));
vi.mock("@/lib/services/circle-chat-service", () => ({ CircleChatService: api }));
type Observation = { callback: IntersectionObserverCallback; options?: IntersectionObserverInit; target?: Element };
let observations: Observation[];
const session = { userId: "alice", circleId: "circle", vaultKey: "test-key", vaultOwnerToken: "test-token" };
const message = { id: "m1", sequence: 1, senderUserId: "bob", senderName: "Bob", createdAt: "2026-10-02T10:00:00Z" };

beforeEach(() => {
  vi.clearAllMocks(); observations = [];
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
  api.open.mockImplementation(async (_session, item) => ({ text: `Message ${item.sequence}`, image: null }));
  render(<CircleChat session={session} circleName="Family" initialOpen />);
  await screen.findByText("Message 1");
  api.messages.mockImplementation(async (_session, page) => {
    const after = page.after ?? 0;
    return {
      items: Array.from({ length: Math.min(40, 206 - after) }, (_, i) => ({ ...message, id: `m${after + i + 1}`, sequence: after + i + 1 })),
      hasMore: after + 40 < 206,
    };
  });
  act(() => window.dispatchEvent(new CustomEvent("hushh:circle-chat-changed", { detail: { userId: session.userId, circleId: session.circleId } })));
  await screen.findByText("Message 206", {}, { timeout: 1500 });
  const transcript = screen.getByRole("list");
  expect(transcript.children).toHaveLength(206);
  expect(api.messages).toHaveBeenCalledTimes(7);
});

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
  await screen.findByText("Message 326", {}, { timeout: 2000 });
  observe(true);
  await act(async () => {});
  expect(screen.getByRole("list").children).toHaveLength(300);
  expect(api.read).not.toHaveBeenCalled();
});

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
