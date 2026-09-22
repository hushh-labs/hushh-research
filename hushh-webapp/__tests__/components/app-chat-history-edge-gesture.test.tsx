// @vitest-environment jsdom
import { render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { AppChatHistoryEdgeGesture } from "@/components/app-ui/app-chat-history-edge-gesture";

vi.mock("next/navigation", () => ({ usePathname: () => "/" }));

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
  target.dispatchEvent(event);
}

function mountChat() {
  document.body.innerHTML =
    '<div class="agent-chat-workspace" data-agent-chat-route="root">' +
    '<button aria-label="Open chat history">history</button>' +
    '<div data-overlay class="fixed"></div>' +
    '<div role="dialog" aria-label="Agent chat history" aria-hidden="true" style="width: 320px"></div>' +
    '<section data-transcript>transcript</section>' +
    "</div>";
  const drawer = document.querySelector<HTMLElement>('[role="dialog"]')!;
  Object.defineProperty(drawer, "offsetWidth", { value: 320 });
  return {
    drawer,
    overlay: document.querySelector<HTMLElement>("[data-overlay]")!,
    toggle: document.querySelector<HTMLButtonElement>("button")!,
    transcript: document.querySelector<HTMLElement>("[data-transcript]")!,
  };
}

describe("chat history edge gesture", () => {
  afterEach(() => {
    document.body.innerHTML = "";
    vi.restoreAllMocks();
  });

  it("drags the drawer with the finger and opens it through the workspace's toggle on commit", () => {
    const { drawer, overlay, toggle, transcript } = mountChat();
    const click = vi.spyOn(toggle, "click");
    render(<AppChatHistoryEdgeGesture enabled />);

    touch("touchstart", 80, 300, transcript);
    touch("touchmove", 140, 302, transcript);
    expect(drawer.style.transform).toBe("translate3d(-260px, 0, 0)");
    expect(drawer.style.transition).toBe("none");
    expect(Number(overlay.style.opacity)).toBeCloseTo(60 / 320, 3);

    touch("touchend", 170, 303, transcript);
    expect(click).toHaveBeenCalledTimes(1);
    expect(drawer.style.transform).toBe("translate3d(0px, 0, 0)");
  });

  it("lets a short pull go back and never starts on the composer or with the drawer open", () => {
    const { drawer, toggle, transcript } = mountChat();
    const click = vi.spyOn(toggle, "click");
    render(<AppChatHistoryEdgeGesture enabled />);

    touch("touchstart", 80, 300, transcript);
    touch("touchmove", 100, 301, transcript);
    touch("touchend", 100, 301, transcript);
    expect(click).not.toHaveBeenCalled();
    expect(drawer.style.transform).toBe("translate3d(-320px, 0, 0)");

    const textarea = document.createElement("textarea");
    document.querySelector(".agent-chat-workspace")!.append(textarea);
    touch("touchstart", 80, 300, textarea);
    touch("touchmove", 200, 300, textarea);
    touch("touchend", 200, 300, textarea);
    expect(click).not.toHaveBeenCalled();

    drawer.setAttribute("aria-hidden", "false");
    drawer.style.transform = "";
    touch("touchstart", 80, 300, transcript);
    touch("touchmove", 200, 300, transcript);
    expect(drawer.style.transform).toBe("");
  });
});
