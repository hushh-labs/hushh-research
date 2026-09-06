import type * as React from "react";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  AgentPopoverProvider,
  useAgentPopover,
} from "@/components/agent/agent-popover-provider";

const navigationMock = vi.hoisted(() => ({
  pathname: "/one/profile",
  push: vi.fn(),
  replace: vi.fn(),
  back: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  usePathname: () => navigationMock.pathname,
  useRouter: () => ({
    push: navigationMock.push,
    replace: navigationMock.replace,
    back: navigationMock.back,
  }),
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
    // The real workspace renders the popover's own window controls in its
    // header. Rendering them here is what lets a test reach Minimize and
    // Maximize -- the two controls #6134 asked about.
    windowControls,
  }: {
    isSurfaceClosing?: boolean;
    onMinimize?: () => void;
    windowControls?: React.ReactNode;
  }) => (
    <div data-testid="agent-chat-workspace" data-closing={isSurfaceClosing || undefined}>
      <textarea aria-label="Message One" />
      {windowControls}
      <button type="button" onClick={onMinimize}>
        Dismiss One
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
    navigationMock.push.mockClear();
    navigationMock.replace.mockClear();
    navigationMock.back.mockClear();
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

    fireEvent.click(screen.getByRole("button", { name: "Dismiss One" }));

    expect(blur).toHaveBeenCalledOnce();
    expect(document.activeElement).not.toBe(composer);
    expect(screen.getByTestId("agent-popover-motion")).toHaveTextContent("closing");
    expect(screen.getByTestId("agent-chat-workspace")).toHaveAttribute(
      "data-closing",
      "true",
    );
    const closingDialog = screen.getByRole("dialog", { hidden: true });
    expect(closingDialog.parentElement).toHaveClass("opacity-0");
    expect(closingDialog).toHaveClass(
      "ease-[cubic-bezier(0.64,0,0.78,0)]",
    );
    expect(closingDialog.className).not.toContain("sm:ring-1");
  });

  /**
   * The second half of #6134.
   *
   * The route half was real: the full-page `/agent` screen read
   * `document.referrer`, which App Router never sets, so minimize always fell
   * through to One home. The report also showed the URL bar reading
   * `/one/gmail` with the chat maximized -- that is the POPOVER, whose window
   * controls only move local state. If minimizing there had navigated too, it
   * would have been a second, separate defect.
   *
   * It does not, and these two tests hold that: the popover never navigates,
   * at either size. So a future "minimize took me to /one" from a popover
   * surface is something else moving the page underneath it -- a guard, a
   * redirect -- and not this control.
   */
  it("minimizes the popover without navigating away from the page", () => {
    vi.useFakeTimers();
    navigationMock.pathname = "/one/gmail";
    render(
      <AgentPopoverProvider>
        <PopoverControl />
      </AgentPopoverProvider>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Open One" }));
    act(() => vi.advanceTimersByTime(20));
    fireEvent.click(screen.getByRole("button", { name: "Minimize One" }));

    expect(screen.getByTestId("agent-popover-motion")).toHaveTextContent(
      "closing",
    );
    expect(navigationMock.push).not.toHaveBeenCalled();
    expect(navigationMock.replace).not.toHaveBeenCalled();
    expect(navigationMock.back).not.toHaveBeenCalled();
  });

  it("changes size and minimizes from the window controls without navigating", () => {
    // The state the report was filed from: maximized, URL still on the feature
    // page. Size is a stored preference, not a route change -- so neither the
    // toggle nor the minimize beside it may move the page.
    vi.useFakeTimers();
    navigationMock.pathname = "/one/gmail";
    render(
      <AgentPopoverProvider>
        <PopoverControl />
      </AgentPopoverProvider>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Open One" }));
    act(() => vi.advanceTimersByTime(20));

    // This viewport opens fullscreen, so the toggle offers Restore first.
    const sizeToggle =
      screen.queryByRole("button", { name: "Restore One" }) ??
      screen.getByRole("button", { name: "Maximize One" });
    fireEvent.click(sizeToggle);
    expect(
      screen.queryByRole("button", { name: "Maximize One" }) ??
        screen.queryByRole("button", { name: "Restore One" }),
    ).toBeInTheDocument();
    expect(navigationMock.push).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Minimize One" }));

    expect(screen.getByTestId("agent-popover-motion")).toHaveTextContent(
      "closing",
    );
    expect(navigationMock.push).not.toHaveBeenCalled();
    expect(navigationMock.replace).not.toHaveBeenCalled();
    expect(navigationMock.back).not.toHaveBeenCalled();
  });
});
