import { act, fireEvent, render, screen } from "@testing-library/react";
import { vi, test, expect, beforeEach } from "vitest";
import { CircleChatMessage, type OpenChatMessage } from "../circle-chat-message";
import { ChatSharedFile } from "../circle-chat-media";
import { CircleMembershipEventPill } from "../circle-chat-system-event";

const api = vi.hoisted(() => ({ react: vi.fn(), image: vi.fn() }));
vi.mock("@/lib/services/circle-chat-service", () => ({ CircleChatService: api }));

const session = { circleId: "circle-1", userId: "alice", vaultOwnerToken: "token", vaultKey: "key" };
const message: OpenChatMessage = {
  id: "message-1", sequence: 1, clientMessageId: "client-1", senderUserId: "bob", senderName: "Bob",
  createdAt: "2026-10-10T08:00:00Z", ciphertext: "cipher", iv: "iv", hasImage: false,
  envelope: {} as OpenChatMessage["envelope"], content: { text: "Hello" }, failed: false, reactions: [],
};
beforeEach(() => { api.react.mockReset(); api.image.mockReset(); window.localStorage.clear(); });

test("hides contact-only Circle sender, reply and membership labels without changing identity targets", () => {
  const target = { ...message, id: "original", senderName: "member@example.test", content: { text: "Quoted body" } };
  const onJump = vi.fn();
  const view = render(<>
    <CircleChatMessage message={{ ...message, senderName: "98******10", replyToMessageId: target.id }}
      replyTarget={target} onJump={onJump} session={session} visible layoutBlocked={false}
      scrollRoot={{ current: null }} onMediaError={() => {}} onViewerChange={() => {}} />
    <CircleMembershipEventPill events={[{ id: "event-1", kind: "member_joined", subjectName: "member@example.test", actorName: "98******10", createdAt: message.createdAt }]} />
  </>);
  expect(view.container).not.toHaveTextContent("member@example.test");
  expect(view.container).not.toHaveTextContent("98******10");
  expect(screen.getByText("Hello")).toBeTruthy();
  // Distinct raw identities must not collapse into a self-join after redaction.
  expect(screen.getByText("Hussh member added Hussh member")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "View original message from Hussh member" }));
  expect(onJump).toHaveBeenCalledExactlyOnceWith(target);
});

test("touch actions wait for a stationary hold, cancel on scroll, and retain quick reactions", async () => {
  api.react.mockResolvedValue({ messageId: message.id, reactions: [{ emoji: "❤️", count: 1, reactedByViewer: true }] });
  const props = { message, session, visible: true, layoutBlocked: false, scrollRoot: { current: null }, onMediaError: () => {}, onViewerChange: () => {}, onAction: vi.fn() };
  const view = render(<CircleChatMessage {...props} />);
  const bubble = screen.getByText("Hello");
  const pointer = (type: string, x = 20) => fireEvent(bubble, Object.assign(new Event(type, { bubbles: true }), { pointerType: "touch", button: 0, clientX: x, clientY: 20 }));
  vi.useFakeTimers();
  try {
    pointer("pointerdown"); pointer("pointerup");
    act(() => vi.advanceTimersByTime(1_100));
    expect(screen.queryByRole("menu")).toBeNull();
    pointer("pointerdown"); pointer("pointermove", 40);
    act(() => vi.advanceTimersByTime(1_100));
    expect(screen.queryByRole("menu")).toBeNull();
    pointer("pointerdown");
    act(() => vi.advanceTimersByTime(999));
    expect(screen.queryByRole("menu")).toBeNull();
    act(() => vi.advanceTimersByTime(1));
    expect(screen.getByRole("menu")).toBeTruthy();
    pointer("pointerup");
  } finally { vi.useRealTimers(); }
  await act(async () => fireEvent.click(screen.getByRole("menuitem", { name: "React ❤️" })));
  expect(api.react).toHaveBeenCalledWith(session, message, "❤️", true);
  expect(screen.getByRole("button", { name: "❤️, 1 reactions, you reacted" })).toBeTruthy();
  // Retained panes must discard pending holds before they can open a portal.
  pointer("pointerdown");
  view.rerender(<CircleChatMessage {...props} visible={false} />);
  expect(screen.queryByRole("menu")).toBeNull();
});

test("deleting or revoking a file while it downloads cancels it and discards late bytes", async () => {
  let finish!: (blob: Blob) => void;
  api.image.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  const allocate = vi.spyOn(URL, "createObjectURL");
  const download = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
  const error = vi.fn();
  const view = render(<ChatSharedFile session={session} message={message} type="application/pdf" name="private.pdf" onError={error} />);
  const button = screen.getByRole("button", { name: "Download document" });
  fireEvent.click(button); fireEvent.click(button);
  expect(api.image).toHaveBeenCalledTimes(1);
  const signal = api.image.mock.calls[0]![3] as AbortSignal;
  view.unmount();
  expect(signal.aborted).toBe(true);
  await act(async () => finish(new Blob(["private bytes"])));
  expect(allocate).not.toHaveBeenCalled();
  expect(download).not.toHaveBeenCalled();
  expect(error).not.toHaveBeenCalled();
  allocate.mockRestore(); download.mockRestore();
});

test("Circle smiley opens the reaction picker, saves immediately, toggles a pill, and closes outside", async () => {
  let resolve!: (value: { messageId: string; reactions: NonNullable<OpenChatMessage["reactions"]> }) => void;
  api.react.mockImplementationOnce(() => new Promise((done) => { resolve = done; }));
  render(<CircleChatMessage message={message} session={session} visible layoutBlocked={false}
    scrollRoot={{ current: null }} onMediaError={() => {}} onViewerChange={() => {}} />);
  const trigger = screen.getByRole("button", { name: "React to message" });
  expect(trigger.textContent).toBe("☺");
  fireEvent.click(trigger);
  expect(screen.getByRole("dialog", { name: "Emoji picker" })).toBeTruthy();
  fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
  expect(screen.queryByRole("dialog", { name: "Emoji picker" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "React to message" }));
  fireEvent.change(screen.getByPlaceholderText("Search emoji"), { target: { value: "❤️" } });
  fireEvent.click(screen.getByRole("button", { name: "Use ❤️", exact: true }));
  expect(screen.getByRole("button", { name: "❤️, 1 reactions, you reacted" })).toBeTruthy();
  expect(api.react).toHaveBeenCalledWith(session, message, "❤️", true);
  expect(trigger.hasAttribute("disabled")).toBe(true);
  fireEvent.click(trigger);
  expect(api.react).toHaveBeenCalledTimes(1);
  await act(async () => resolve({ messageId: message.id, reactions: [{ emoji: "❤️", count: 2, reactedByViewer: true }] }));
  expect(screen.getByRole("button", { name: "❤️, 2 reactions, you reacted" })).toBeTruthy();
  api.react.mockResolvedValueOnce({ messageId: message.id, reactions: [{ emoji: "❤️", count: 1, reactedByViewer: false }] });
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "❤️, 2 reactions, you reacted" })));
  expect(api.react).toHaveBeenLastCalledWith(session, message, "❤️", false);
});

test.each(["💛", "👍🏽", "👩🏽‍💻", "🇮🇳", "1️⃣"])("saves %s from the full picker and restores the previous badge on failure", async (emoji) => {
  api.react.mockResolvedValueOnce({ messageId: message.id, reactions: [{ emoji, count: 1, reactedByViewer: true }] });
  render(<CircleChatMessage message={message} session={session} visible layoutBlocked={false}
    scrollRoot={{ current: null }} onMediaError={() => {}} onViewerChange={() => {}} />);
  fireEvent.click(screen.getByRole("button", { name: "React to message" }));
  fireEvent.change(screen.getByPlaceholderText("Search emoji"), { target: { value: emoji } });
  await act(async () => fireEvent.click(screen.getByRole("button", { name: `Use ${emoji}`, exact: true })));
  expect(api.react).toHaveBeenCalledWith(session, message, emoji, true);
  expect(screen.queryByRole("dialog", { name: "Emoji picker" })).toBeNull();
  const name = `${emoji}, 1 reactions, you reacted`;
  expect(screen.getByRole("button", { name })).toBeTruthy();
  api.react.mockRejectedValueOnce(new Error("offline"));
  await act(async () => fireEvent.click(screen.getByRole("button", { name })));
  expect(screen.getByRole("button", { name })).toBeTruthy();
  expect(screen.getByRole("alert").textContent).toContain("Reaction could not be saved");
});

test("hiding the retained thread closes its portalled picker and blocks reactions", () => {
  const props = { message, session, visible: true, layoutBlocked: false, scrollRoot: { current: null }, onMediaError: () => {}, onViewerChange: () => {} };
  const view = render(<CircleChatMessage {...props} />);
  fireEvent.click(screen.getByRole("button", { name: "React to message" }));
  expect(screen.getByRole("dialog", { name: "Emoji picker" })).toBeTruthy();
  view.rerender(<CircleChatMessage {...props} visible={false} />);
  expect(screen.queryByRole("dialog", { name: "Emoji picker" })).toBeNull();
  expect(screen.getByRole("button", { name: "React to message" }).hasAttribute("disabled")).toBe(true);
  expect(api.react).not.toHaveBeenCalled();
});
