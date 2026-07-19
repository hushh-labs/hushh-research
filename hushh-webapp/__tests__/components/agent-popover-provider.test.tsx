import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  AgentPopoverProvider,
  useAgentPopover,
} from "@/components/agent/agent-popover-provider";

const navigationMock = vi.hoisted(() => ({
  pathname: "/one/profile",
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
  AgentChatWorkspace: ({
    isSurfaceClosing,
    onMinimize,
  }: {
    isSurfaceClosing?: boolean;
    onMinimize?: () => void;
  }) => (
    <div data-testid="agent-chat-workspace" data-closing={isSurfaceClosing || undefined}>
      <textarea aria-label="Message One" />
      <button type="button" onClick={onMinimize}>
        Close One
      </button>
    </div>
  ),
}));

function PopoverControl() {
  const { motionState, openAgent } = useAgentPopover();
  return (
    <>
      <button type="button" onClick={() => openAgent()}>
        Open One
      </button>
      <output data-testid="agent-popover-motion">{motionState}</output>
    </>
  );
}

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

describe("AgentPopoverProvider surface ownership", () => {
  let getBoundingClientRectSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    navigationMock.pathname = "/login";
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
    vi.useRealTimers();
  });

  it("does not render a stray floating trigger when app chrome owns Agent entrypoints", () => {
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

  it("does not render a duplicate floating trigger on Profile command-bar routes", () => {
    navigationMock.pathname = "/one/profile";

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

  it("uses one close path that blurs the composer before starting the sheet exit", () => {
    vi.useFakeTimers();
    navigationMock.pathname = "/one";
    render(
      <AgentPopoverProvider>
        <PopoverControl />
      </AgentPopoverProvider>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Open One" }));
    act(() => vi.advanceTimersByTime(20));

    const composer = screen.getByRole("textbox", { name: "Message One" });
    const blur = vi.spyOn(composer, "blur");
    composer.focus();
    expect(document.activeElement).toBe(composer);

    fireEvent.click(screen.getByRole("button", { name: "Close One" }));

    expect(blur).toHaveBeenCalledOnce();
    expect(document.activeElement).not.toBe(composer);
    expect(screen.getByTestId("agent-popover-motion")).toHaveTextContent("closing");
    expect(screen.getByTestId("agent-chat-workspace")).toHaveAttribute(
      "data-closing",
      "true",
    );
  });
});
