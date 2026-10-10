import { act, fireEvent, render, screen } from "@testing-library/react";
import { vi, test, expect } from "vitest";
import { CircleChatMessage, type OpenChatMessage } from "../circle-chat-message";

const api = vi.hoisted(() => ({ react: vi.fn() }));
vi.mock("@/lib/services/circle-chat-service", () => ({ CircleChatService: api }));

const session = { circleId: "circle-1", userId: "alice", vaultOwnerToken: "token", vaultKey: "key" };
const message: OpenChatMessage = {
  id: "message-1", sequence: 1, clientMessageId: "client-1", senderUserId: "bob", senderName: "Bob",
  createdAt: "2026-10-10T08:00:00Z", ciphertext: "cipher", iv: "iv", hasImage: false,
  envelope: {} as OpenChatMessage["envelope"], content: { text: "Hello" }, failed: false, reactions: [],
};

test("Circle reaction picker saves immediately, toggles a pill, and closes outside", async () => {
  let resolve!: (value: { messageId: string; reactions: NonNullable<OpenChatMessage["reactions"]> }) => void;
  api.react.mockImplementationOnce(() => new Promise((done) => { resolve = done; }));
  render(<CircleChatMessage message={message} session={session} visible layoutBlocked={false}
    scrollRoot={{ current: null }} onMediaError={() => {}} onViewerChange={() => {}} />);
  fireEvent.click(screen.getByRole("button", { name: "React to message" }));
  expect(screen.getByRole("group", { name: "Choose a reaction" })).toBeTruthy();
  fireEvent.pointerDown(document.body);
  expect(screen.queryByRole("group", { name: "Choose a reaction" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "React to message" }));
  fireEvent.click(screen.getByRole("button", { name: "React with ❤️" }));
  expect(screen.getByRole("button", { name: "❤️, 1 reactions, you reacted" })).toBeTruthy();
  expect(api.react).toHaveBeenCalledWith(session, message, "❤️", true);
  await act(async () => resolve({ messageId: message.id, reactions: [{ emoji: "❤️", count: 2, reactedByViewer: true }] }));
  expect(screen.getByRole("button", { name: "❤️, 2 reactions, you reacted" })).toBeTruthy();
  api.react.mockResolvedValueOnce({ messageId: message.id, reactions: [{ emoji: "❤️", count: 1, reactedByViewer: false }] });
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "❤️, 2 reactions, you reacted" })));
  expect(api.react).toHaveBeenLastCalledWith(session, message, "❤️", false);
});
