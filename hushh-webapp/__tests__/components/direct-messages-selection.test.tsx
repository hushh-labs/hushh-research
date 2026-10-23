import { mocks, visibleMessage, renderConnectionThread, setupDirectMessagePageTests } from "../fixtures/direct-messages-page";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

describe("DirectMessagesPage selection recovery", () => {
  setupDirectMessagePageTests();

  it("recovers a cold failed selection when its inbox row is tapped again", async () => {
    mocks.search = "conversation=conversation-1";
    mocks.getConversationMessages.mockRejectedValueOnce(new TypeError("Offline"));
    renderConnectionThread();
    await screen.findByRole("button", { name: "Try again" });
    expect(screen.getByRole("heading", { name: "Ankit Kumar Singh", exact: true })).toBeVisible();
    expect(screen.getByRole("textbox", { name: "Message Ankit Kumar Singh" })).toBeDisabled();

    mocks.getConversationMessages.mockResolvedValue({ conversation: mocks.conversation, items: [visibleMessage],
      canSend: true, disconnectedNotice: null, nextBefore: null });
    fireEvent.click(within(screen.getByRole("group", { name: "Ankit Kumar Singh chat" })).getByRole("button", { name: /Start a conversation/ }));
    expect(await screen.findByText(visibleMessage.content)).toBeVisible();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Message Ankit Kumar Singh" })).toBeEnabled();
    expect(mocks.router.push).not.toHaveBeenCalled();
  });

  it("keeps the last transcript while reselecting refreshes it to the latest state", async () => {
    mocks.search = "conversation=conversation-1";
    mocks.getConversationMessages.mockResolvedValueOnce({ conversation: mocks.conversation, items: [visibleMessage],
      canSend: true, disconnectedNotice: null, nextBefore: null });
    renderConnectionThread();
    await screen.findByText(visibleMessage.content);
    let finish!: (value: unknown) => void;
    mocks.getConversationMessages.mockReturnValueOnce(new Promise(resolve => { finish = resolve; }));
    fireEvent.click(within(screen.getByRole("group", { name: "Ankit Kumar Singh chat" })).getByRole("button", { name: /Start a conversation/ }));
    await waitFor(() => expect(finish).toBeDefined());
    expect(screen.getByText(visibleMessage.content)).toBeVisible();
    expect(screen.queryByText("Loading messages…")).not.toBeInTheDocument();
    const latest = { ...visibleMessage, id: "latest-message", content: "Latest message after reconnect", createdAt: "2026-10-06T10:02:00.000Z" };
    await act(async () => finish({ conversation: mocks.conversation, items: [visibleMessage, latest],
      canSend: true, disconnectedNotice: null, nextBefore: null }));
    expect(await screen.findByText(latest.content)).toBeVisible();
    expect(mocks.router.push).not.toHaveBeenCalled();
  });

});
