import { describe, expect, it } from "vitest";
import { transitionConnectionsDrawer } from "../agent-connections-drawer";

describe("Connectors drawer state", () => {
  it("returns to chat history after backdrop or Escape closes Connectors", () => {
    const closed = transitionConnectionsDrawer(
      { open: true, mode: "connections" },
      { type: "set-open", open: false },
    );
    expect(closed).toEqual({ open: false, mode: "chats" });
    expect(transitionConnectionsDrawer(closed, { type: "toggle-chats" }))
      .toEqual({ open: true, mode: "chats" });
  });

  it("hamburger closes an open Connectors panel and next opens chats", () => {
    const closed = transitionConnectionsDrawer(
      { open: true, mode: "connections" },
      { type: "toggle-chats" },
    );
    expect(closed).toEqual({ open: false, mode: "chats" });
    expect(transitionConnectionsDrawer(closed, { type: "toggle-chats" }))
      .toEqual({ open: true, mode: "chats" });
  });

  it("preserves an explicit OAuth return to Connectors", () => {
    expect(transitionConnectionsDrawer(
      { open: false, mode: "connections" },
      { type: "set-open", open: true },
    )).toEqual({ open: true, mode: "connections" });
  });
});
