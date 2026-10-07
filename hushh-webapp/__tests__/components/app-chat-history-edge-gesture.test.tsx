// @vitest-environment jsdom
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { AppChatHistoryEdgeGesture } from "@/components/app-ui/app-chat-history-edge-gesture";

const native = vi.hoisted(() => ({ blocked: false, dragging: false }));
vi.mock("@/lib/capacitor/native-navigation", () => ({
  nativeShellOverlayBlocked: () => native.blocked,
  useNativeNavigationBlocked: (dragging: boolean) => { native.dragging = dragging; },
}));

// A finger moves through time: every event lands 120 ms after the previous
// one, so a short pull is slow (no velocity commit) and a long one commits
// on distance.
let clock = 0;
function touch(type: string, x: number, y: number, target: EventTarget = document.body) {
  clock += 120;
  const point = { identifier: 1, clientX: x, clientY: y, target } as unknown as Touch;
  const event = new Event(type, { bubbles: true, cancelable: true }) as TouchEvent;
  Object.defineProperty(event, "touches", { value: type === "touchend" ? [] : [point] });
  Object.defineProperty(event, "changedTouches", { value: [point] });
  Object.defineProperty(event, "timeStamp", { value: clock });
  act(() => { target.dispatchEvent(event); });
}

function mountChat() {
  document.body.innerHTML =
    '<div class="agent-chat-workspace" data-agent-chat-route="root">' +
    '<button aria-label="Open chat history">history</button>' +
    '<section data-transcript>transcript</section>' +
    "</div>" +
    // The scrim and panel are portalled to <body>, outside the workspace, so
    // they can stack above the fixed bottom bar (founder direction, 2026-09-28).
    '<div data-agent-history-scrim class="fixed invisible"></div>' +
    '<div role="dialog" data-agent-history-drawer aria-label="Agent chat history" aria-hidden="true" style="width: 320px"></div>';
  const drawer = document.querySelector<HTMLElement>('[role="dialog"]')!;
  Object.defineProperty(drawer, "offsetWidth", { value: 320 });
  return {
    drawer,
    overlay: document.querySelector<HTMLElement>("[data-agent-history-scrim]")!,
    toggle: document.querySelector<HTMLButtonElement>("button")!,
    transcript: document.querySelector<HTMLElement>("[data-transcript]")!,
  };
}

function mountGesture(open = false) {
  const nodes = mountChat();
  const onOpen = vi.fn();
  const onClose = vi.fn();
  nodes.drawer.setAttribute("aria-hidden", String(!open));
  const view = render(<AppChatHistoryEdgeGesture enabled open={open} onOpen={onOpen} onClose={onClose}
    surfaceRef={{ current: nodes.transcript }} drawerRef={{ current: nodes.drawer }} scrimRef={{ current: nodes.overlay }} />);
  return { ...nodes, onOpen, onClose, view };
}

describe("chat history body gesture", () => {
  afterEach(() => {
    cleanup();
    native.blocked = false;
    document.documentElement.classList.remove("kb-open");
    document.body.innerHTML = "";
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("tracks the finger with the portalled panel and visible scrim without moving the body; commits through the owner", () => {
    const { drawer, overlay, transcript, onOpen } = mountGesture();

    touch("touchstart", 80, 300, transcript);
    touch("touchmove", 140, 302, transcript);
    expect(drawer.style.transform).toBe("translate3d(-260px, 0, 0)");
    expect(drawer.style.transition).toBe("none");
    expect(Number(overlay.style.opacity)).toBeCloseTo(60 / 320, 3);
    expect(overlay.style.visibility).toBe("visible");
    expect(native.dragging).toBe(true);
    expect(transcript.style.transform).toBe("");
    expect(document.body.style.transform).toBe("");

    touch("touchend", 170, 303, transcript);
    expect(onOpen).toHaveBeenCalledTimes(1);
    expect(drawer.style.transform).toBe("translate3d(0px, 0, 0)");
    touch("touchend", 170, 303, transcript);
    expect(onOpen).toHaveBeenCalledTimes(1);
  });

  it("lets a short pull go back and never starts on the composer or with the drawer open", () => {
    const { drawer, transcript, onOpen, view } = mountGesture();

    touch("touchstart", 80, 300, transcript);
    touch("touchmove", 100, 301, transcript);
    touch("touchend", 100, 301, transcript);
    expect(onOpen).not.toHaveBeenCalled();
    expect(drawer.style.transform).toBe("translate3d(-320px, 0, 0)");
    view.unmount();
    expect(drawer.style.transform).toBe("");
    const next = render(<AppChatHistoryEdgeGesture enabled onOpen={onOpen} onClose={vi.fn()}
      surfaceRef={{ current: transcript }} drawerRef={{ current: drawer }} scrimRef={{ current: document.querySelector<HTMLElement>("[data-agent-history-scrim]") }} />);

    const textarea = document.createElement("textarea");
    transcript.append(textarea);
    touch("touchstart", 80, 300, textarea);
    touch("touchmove", 200, 300, textarea);
    touch("touchend", 200, 300, textarea);
    expect(onOpen).not.toHaveBeenCalled();

    drawer.setAttribute("aria-hidden", "false");
    drawer.style.transform = "";
    touch("touchstart", 80, 300, transcript);
    touch("touchmove", 200, 300, transcript);
    expect(drawer.style.transform).toBe("");
    next.unmount();
  });

  it("preserves vertical scroll, horizontal tables, edge-back and overlay ownership, and cancels partial drags", () => {
    const { drawer, overlay, transcript, toggle, onOpen, view } = mountGesture();
    touch("touchstart", 80, 300, toggle); // Outside the bound body.
    touch("touchmove", 200, 300, toggle);
    touch("touchstart", 20, 300, transcript); // Edge-back lane.
    touch("touchmove", 200, 300, transcript);
    touch("touchstart", 80, 300, transcript);
    touch("touchmove", 85, 400, transcript);
    touch("touchend", 200, 400, transcript);
    expect(drawer.style.transform).toBe("");
    const table = document.createElement("div");
    table.style.overflowX = "auto";
    Object.defineProperty(table, "scrollWidth", { value: 600 });
    Object.defineProperty(table, "clientWidth", { value: 200 });
    transcript.append(table);
    touch("touchstart", 80, 300, table);
    touch("touchmove", 200, 300, table);
    native.blocked = true;
    touch("touchstart", 80, 300, transcript);
    touch("touchmove", 200, 300, transcript);
    native.blocked = false;
    document.documentElement.classList.add("kb-open");
    touch("touchstart", 80, 300, transcript);
    touch("touchmove", 200, 300, transcript);
    document.documentElement.classList.remove("kb-open");
    expect(onOpen).not.toHaveBeenCalled();
    expect(drawer.style.transform).toBe("");
    touch("touchstart", 80, 300, transcript);
    touch("touchmove", 200, 300, transcript);
    touch("touchcancel", 200, 300, transcript);
    touch("touchend", 220, 300, transcript);
    expect(onOpen).not.toHaveBeenCalled();
    expect(drawer.style.transform).toBe("translate3d(-320px, 0, 0)");
    view.unmount();
    expect(drawer.style.transform).toBe("");
    expect(overlay.style.visibility).toBe("");
    expect(drawer.style.willChange).toBe("");
  });
  it("reconciles an immediate owner close instead of pinning the opening presentation", () => {
    vi.useFakeTimers();
    const nodes = mountChat();
    const refs = { surfaceRef: { current: nodes.transcript }, drawerRef: { current: nodes.drawer }, scrimRef: { current: nodes.overlay } };
    const onOpen = vi.fn();
    const onClose = vi.fn();
    const view = render(<AppChatHistoryEdgeGesture enabled open={false} onOpen={onOpen} onClose={onClose} {...refs} />);
    touch("touchstart", 80, 300, nodes.transcript);
    touch("touchmove", 200, 300, nodes.transcript);
    touch("touchend", 200, 300, nodes.transcript);
    expect(onOpen).toHaveBeenCalledOnce();
    view.rerender(<AppChatHistoryEdgeGesture enabled open onOpen={onOpen} onClose={onClose} {...refs} />);
    view.rerender(<AppChatHistoryEdgeGesture enabled open={false} onOpen={onOpen} onClose={onClose} {...refs} />);
    expect(nodes.drawer.style.transform).toBe("translate3d(-320px, 0, 0)");
    act(() => { vi.runAllTimers(); });
    expect(nodes.drawer.style.transform).toBe("");
    expect(nodes.overlay.style.visibility).toBe("");
    expect(native.dragging).toBe(false);
    view.unmount();
    vi.useRealTimers();
  });

  it("tracks closing from a chat row without selecting it or moving the page, and commits once", () => {
    const { drawer, overlay, transcript, onOpen, onClose } = mountGesture(true);
    native.blocked = true; // The open drawer itself owns native isolation.
    const row = document.createElement("button");
    drawer.append(row);
    const select = vi.fn();
    row.addEventListener("click", select);
    touch("touchstart", 250, 300, row);
    touch("touchmove", 190, 302, row);
    expect(drawer.style.transform).toBe("translate3d(-60px, 0, 0)");
    expect(drawer.style.transition).toBe("none");
    expect(Number(overlay.style.opacity)).toBeCloseTo(260 / 320, 3);
    expect(transcript.style.transform).toBe("");
    expect(document.body.style.transform).toBe("");
    expect(onClose).not.toHaveBeenCalled();
    touch("touchend", 100, 303, row);
    touch("touchend", 100, 303, row);
    expect(onClose).toHaveBeenCalledOnce();
    expect(onOpen).not.toHaveBeenCalled();
    expect(drawer.style.transform).toBe("translate3d(-320px, 0, 0)");
    row.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, detail: 1 }));
    expect(select).not.toHaveBeenCalled();
  });

  it("restores an incomplete close; retains vertical scrolling, taps and nested-overlay ownership", () => {
    vi.useFakeTimers();
    const { drawer, overlay, onClose } = mountGesture(true);
    const backdropClick = vi.fn();
    overlay.addEventListener("click", backdropClick);
    touch("touchstart", 350, 300, overlay);
    touch("touchmove", 330, 300, overlay);
    touch("touchend", 330, 300, overlay);
    expect(drawer.style.transform).toBe("translate3d(0px, 0, 0)");
    expect(onClose).not.toHaveBeenCalled();
    overlay.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, detail: 1 }));
    expect(backdropClick).not.toHaveBeenCalled();
    // A fresh tap during snap-back is intentional, not the prior drag's click.
    // Do not wait for settlement before checking this regression.
    touch("touchstart", 350, 300, overlay);
    touch("touchend", 350, 300, overlay);
    overlay.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, detail: 1 }));
    expect(backdropClick).toHaveBeenCalledOnce();
    act(() => { vi.runAllTimers(); });
    expect(drawer.style.transform).toBe("");
    expect(native.dragging).toBe(false);
    touch("touchstart", 250, 300, drawer);
    touch("touchmove", 245, 200, drawer);
    touch("touchend", 100, 200, drawer);
    expect(drawer.style.transform).toBe("");
    const row = document.createElement("button");
    drawer.append(row);
    const selected = vi.fn();
    row.addEventListener("click", selected);
    touch("touchstart", 200, 300, row);
    touch("touchend", 200, 300, row);
    row.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, detail: 1 }));
    expect(selected).toHaveBeenCalledOnce();
    const modal = document.createElement("div");
    modal.dataset.slot = "alert-dialog-content";
    modal.dataset.state = "open";
    document.body.append(modal);
    touch("touchstart", 250, 300, drawer);
    touch("touchmove", 100, 300, drawer);
    touch("touchend", 100, 300, drawer);
    expect(drawer.style.transform).toBe("");
    expect(onClose).not.toHaveBeenCalled();
    modal.remove();
    touch("touchstart", 250, 300, drawer);
    touch("touchmove", 100, 300, drawer);
    touch("touchcancel", 100, 300, drawer);
    touch("touchend", 100, 300, drawer);
    expect(drawer.style.transform).toBe("translate3d(0px, 0, 0)");
    expect(onClose).not.toHaveBeenCalled();
  });
});
