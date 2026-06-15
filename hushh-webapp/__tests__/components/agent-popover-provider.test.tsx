import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AgentPopoverProvider } from "@/components/agent/agent-popover-provider";

const navigationMock = vi.hoisted(() => ({
  pathname: "/profile",
}));

vi.mock("next/navigation", () => ({
  usePathname: () => navigationMock.pathname,
}));

vi.mock("@/hooks/use-auth", () => ({
  useAuth: () => ({
    isAuthenticated: true,
  }),
}));

vi.mock("@/components/agent/agent-chat-workspace", () => ({
  AgentChatWorkspace: () => <div data-testid="agent-chat-workspace" />,
}));

vi.mock("@/components/agent/agent-voice-floating-indicator", () => ({
  AgentVoiceFloatingIndicator: () => null,
}));

function makeRect(input: {
  left: number;
  top: number;
  width: number;
  height: number;
}): DOMRect {
  const rect = {
    x: input.left,
    y: input.top,
    left: input.left,
    top: input.top,
    width: input.width,
    height: input.height,
    right: input.left + input.width,
    bottom: input.top + input.height,
    toJSON: () => rect,
  };
  return rect as DOMRect;
}

function dispatchPointer(
  element: HTMLElement,
  type: "pointerdown" | "pointermove" | "pointerup",
  init: {
    button?: number;
    clientX: number;
    clientY: number;
    pointerId: number;
  }
) {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperties(event, {
    button: { value: init.button ?? 0 },
    clientX: { value: init.clientX },
    clientY: { value: init.clientY },
    pointerId: { value: init.pointerId },
  });
  fireEvent(element, event);
}

describe("AgentPopoverProvider floating trigger", () => {
  let getBoundingClientRectSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    navigationMock.pathname = "/profile";
    window.localStorage.clear();
    Object.defineProperty(window, "innerWidth", {
      configurable: true,
      value: 430,
    });
    Object.defineProperty(window, "innerHeight", {
      configurable: true,
      value: 932,
    });

    Object.defineProperty(HTMLElement.prototype, "setPointerCapture", {
      configurable: true,
      value: vi.fn(),
    });
    Object.defineProperty(HTMLElement.prototype, "releasePointerCapture", {
      configurable: true,
      value: vi.fn(),
    });
    Object.defineProperty(HTMLElement.prototype, "hasPointerCapture", {
      configurable: true,
      value: vi.fn(() => true),
    });

    getBoundingClientRectSpy = vi
      .spyOn(HTMLElement.prototype, "getBoundingClientRect")
      .mockImplementation(function getMockRect(this: HTMLElement) {
        if (this.getAttribute("data-tour-id") === "kai-command-bar") {
          return makeRect({ left: 35, top: 720, width: 360, height: 48 });
        }
        if (this.getAttribute("aria-label") === "Main navigation") {
          return makeRect({ left: 20, top: 812, width: 390, height: 74 });
        }
        if (this.getAttribute("aria-label") === "Open Agent") {
          return makeRect({ left: 366, top: 660, width: 48, height: 44 });
        }
        return makeRect({ left: 0, top: 0, width: 0, height: 0 });
      });
  });

  afterEach(() => {
    getBoundingClientRectSpy.mockRestore();
  });

  it("positions the trigger above the command bar on iPhone-sized viewports", async () => {
    render(
      <div>
        <div data-tour-id="kai-command-bar" />
        <div aria-label="Main navigation" />
        <AgentPopoverProvider>
          <main />
        </AgentPopoverProvider>
      </div>
    );

    const trigger = screen.getByRole("button", { name: "Open Agent" });

    await waitFor(() => {
      expect(trigger.style.left).toBe("366px");
      expect(trigger.style.top).toBe("660px");
    });
    expect(trigger.className).toContain("bg-primary");
  });

  it("does not allow dragging the trigger into the command bar", async () => {
    render(
      <div>
        <div data-tour-id="kai-command-bar" />
        <div aria-label="Main navigation" />
        <AgentPopoverProvider>
          <main />
        </AgentPopoverProvider>
      </div>
    );

    const trigger = screen.getByRole("button", { name: "Open Agent" });

    await waitFor(() => {
      expect(trigger.style.top).toBe("660px");
    });

    dispatchPointer(trigger, "pointerdown", {
      button: 0,
      clientX: 390,
      clientY: 682,
      pointerId: 1,
    });
    dispatchPointer(trigger, "pointermove", {
      clientX: 390,
      clientY: 910,
      pointerId: 1,
    });
    dispatchPointer(trigger, "pointerup", {
      clientX: 390,
      clientY: 910,
      pointerId: 1,
    });

    expect(trigger.style.top).toBe("660px");
  });

  it("keeps horizontal drags on the right-side rail", async () => {
    render(
      <div>
        <div data-tour-id="kai-command-bar" />
        <div aria-label="Main navigation" />
        <AgentPopoverProvider>
          <main />
        </AgentPopoverProvider>
      </div>
    );

    const trigger = screen.getByRole("button", { name: "Open Agent" });

    await waitFor(() => {
      expect(trigger.style.left).toBe("366px");
    });

    dispatchPointer(trigger, "pointerdown", {
      button: 0,
      clientX: 390,
      clientY: 682,
      pointerId: 1,
    });
    dispatchPointer(trigger, "pointermove", {
      clientX: 40,
      clientY: 600,
      pointerId: 1,
    });
    dispatchPointer(trigger, "pointerup", {
      clientX: 40,
      clientY: 600,
      pointerId: 1,
    });

    await waitFor(() => {
      expect(trigger.style.left).toBe("366px");
      expect(trigger.style.top).toBe("578px");
    });
  });

  it("does not allow dragging the trigger into the top chrome", async () => {
    render(
      <div>
        <div data-tour-id="kai-command-bar" />
        <div aria-label="Main navigation" />
        <AgentPopoverProvider>
          <main />
        </AgentPopoverProvider>
      </div>
    );

    const trigger = screen.getByRole("button", { name: "Open Agent" });

    await waitFor(() => {
      expect(trigger.style.top).toBe("660px");
    });

    dispatchPointer(trigger, "pointerdown", {
      button: 0,
      clientX: 390,
      clientY: 682,
      pointerId: 1,
    });
    dispatchPointer(trigger, "pointermove", {
      clientX: 390,
      clientY: 0,
      pointerId: 1,
    });
    dispatchPointer(trigger, "pointerup", {
      clientX: 390,
      clientY: 0,
      pointerId: 1,
    });

    await waitFor(() => {
      expect(trigger.style.top).toBe("104px");
    });
  });

  it("does not render a duplicate floating trigger on Kai command-bar routes", () => {
    navigationMock.pathname = "/kai";

    render(
      <div>
        <div data-tour-id="kai-command-bar" />
        <div aria-label="Main navigation" />
        <AgentPopoverProvider>
          <main />
        </AgentPopoverProvider>
      </div>
    );

    expect(screen.queryByRole("button", { name: "Open Agent" })).toBeNull();
  });
});
