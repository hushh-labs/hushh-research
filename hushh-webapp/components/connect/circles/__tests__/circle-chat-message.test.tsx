import { act, fireEvent, render, screen } from "@testing-library/react";
import { vi, test, expect, beforeEach } from "vitest";
import { CircleChatMessage, type OpenChatMessage } from "../circle-chat-message";

const api = vi.hoisted(() => ({ react: vi.fn() }));
vi.mock("@/lib/services/circle-chat-service", () => ({ CircleChatService: api }));

const session = { circleId: "circle-1", userId: "alice", vaultOwnerToken: "token", vaultKey: "key" };
const message: OpenChatMessage = {
  id: "message-1", sequence: 1, clientMessageId: "client-1", senderUserId: "bob", senderName: "Bob",
  createdAt: "2026-10-10T08:00:00Z", ciphertext: "cipher", iv: "iv", hasImage: false,
  envelope: {} as OpenChatMessage["envelope"], content: { text: "Hello" }, failed: false, reactions: [],
};
beforeEach(() => { api.react.mockReset(); window.localStorage.clear(); });

test("Circle reaction picker saves immediately, toggles a pill, and closes outside", async () => {
  let resolve!: (value: { messageId: string; reactions: NonNullable<OpenChatMessage["reactions"]> }) => void;
  api.react.mockImplementationOnce(() => new Promise((done) => { resolve = done; }));
  render(<CircleChatMessage message={message} session={session} visible layoutBlocked={false}
    scrollRoot={{ current: null }} onMediaError={() => {}} onViewerChange={() => {}} />);
  fireEvent.click(screen.getByRole("button", { name: "React to message" }));
  expect(screen.getByRole("dialog", { name: "Emoji picker" })).toBeTruthy();
  fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
  expect(screen.queryByRole("dialog", { name: "Emoji picker" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "React to message" }));
  fireEvent.change(screen.getByPlaceholderText("Search emoji"), { target: { value: "❤️" } });
  fireEvent.click(screen.getByRole("button", { name: "Use ❤️", exact: true }));
  expect(screen.getByRole("button", { name: "❤️, 1 reactions, you reacted" })).toBeTruthy();
  expect(api.react).toHaveBeenCalledWith(session, message, "❤️", true);
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
