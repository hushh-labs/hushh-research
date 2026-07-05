import { render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  AgentPopoverProvider,
  useOptionalAgentPopover,
} from "@/components/agent/agent-popover-provider";

const navigationMock = vi.hoisted(() => ({
  pathname: "/profile",
}));

const authMock = vi.hoisted(() => ({
  state: {
    isAuthenticated: true,
    loading: false,
    user: { uid: "user-1" },
  },
}));

const vaultMock = vi.hoisted(() => ({
  state: {
    isVaultUnlocked: true,
    vaultOwnerToken: "vault-token",
    tokenExpiresAt: Date.now() + 60_000,
  },
}));

vi.mock("next/navigation", () => ({
  usePathname: () => navigationMock.pathname,
}));

vi.mock("@/hooks/use-auth", () => ({
  useAuth: () => authMock.state,
}));

vi.mock("@/lib/vault/vault-context", () => ({
  useVault: () => vaultMock.state,
}));

vi.mock("@/components/agent/agent-chat-workspace", () => ({
  AgentChatWorkspace: () => <div data-testid="agent-chat-workspace" />,
}));

vi.mock("@/components/agent/agent-voice-floating-indicator", () => ({
  AgentVoiceFloatingIndicator: () => null,
}));

function AgentAvailabilityProbe() {
  const agentPopover = useOptionalAgentPopover();
  return (
    <button type="button" onClick={() => agentPopover?.openAgent()}>
      {agentPopover?.available ? "available" : "blocked"}
    </button>
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

describe("AgentPopoverProvider floating trigger", () => {
  let getBoundingClientRectSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    navigationMock.pathname = "/login";
    authMock.state = {
      isAuthenticated: true,
      loading: false,
      user: { uid: "user-1" },
    };
    vaultMock.state = {
      isVaultUnlocked: true,
      vaultOwnerToken: "vault-token",
      tokenExpiresAt: Date.now() + 60_000,
    };
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
    navigationMock.pathname = "/profile";

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

  it("blocks Agent entrypoints until the vault is unlocked", () => {
    navigationMock.pathname = "/profile";
    vaultMock.state = {
      isVaultUnlocked: false,
      vaultOwnerToken: null,
      tokenExpiresAt: null,
    };

    render(
      <AgentPopoverProvider>
        <AgentAvailabilityProbe />
      </AgentPopoverProvider>
    );

    expect(screen.getByRole("button", { name: "blocked" })).toBeTruthy();
    expect(screen.queryByTestId("agent-chat-workspace")).toBeNull();
  });

  it("exposes Agent entrypoints once auth and vault readiness are complete", () => {
    navigationMock.pathname = "/profile";

    render(
      <AgentPopoverProvider>
        <AgentAvailabilityProbe />
      </AgentPopoverProvider>
    );

    expect(screen.getByRole("button", { name: "available" })).toBeTruthy();
  });
});
