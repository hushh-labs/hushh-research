/**
 * The Azure hosting card when Microsoft removed the agent's hosting space: one plain
 * sentence, one action (the owner-approved rebuild), and nothing at all otherwise.
 */
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  hosting: vi.fn(),
  rebuild: vi.fn(),
  assign: vi.fn(),
  native: vi.fn(() => false),
}));

vi.mock("@capacitor/core", () => ({ Capacitor: { isNativePlatform: mocks.native } }));
vi.mock("@/lib/utils/browser-navigation", () => ({ assignWindowLocation: mocks.assign }));
vi.mock("@/lib/services/api-service", () => ({
  ApiService: {
    getAzureHosting: mocks.hosting,
    beginAzureByocRebuild: mocks.rebuild,
    beginAzureByocUpgrade: vi.fn(),
    beginAzureByocAuthorize: vi.fn(),
  },
}));

import {
  AzureHostingNotice,
  HOSTING_RECLAIMED_SENTENCE,
  HOSTING_UNCONFIRMED_SENTENCE,
  REBUILDING_SENTENCE,
} from "@/components/profile/azure-hosting-notice";
import { AZURE_SIGN_IN_CHANNEL } from "@/lib/one/azure-sign-in";
import { parseAzureHosting } from "@/lib/services/azure-byoc-contract";

const SIGN_IN = "https://login.microsoftonline.com/tenant/oauth2/v2.0/authorize?state=s";

function hosting(state: string, rebuild: unknown = null) {
  mocks.hosting.mockResolvedValue(
    parseAzureHosting({
      state,
      rebuildable: state === "hosting_reclaimed" || state === "hosting_unconfirmed",
      rebuild,
    }),
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.native.mockReturnValue(false);
  vi.spyOn(window, "open").mockReturnValue(null);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("Azure hosting reclaimed", () => {
  it("says what happened in one sentence and offers one rebuild", async () => {
    hosting("hosting_reclaimed");
    mocks.rebuild.mockResolvedValue({ authorizationUrl: SIGN_IN });
    render(<AzureHostingNotice />);
    expect(await screen.findByText(HOSTING_RECLAIMED_SENTENCE)).toBeTruthy();
    expect(HOSTING_RECLAIMED_SENTENCE).toBe(
      "Microsoft removed your agent’s hosting space after a long idle period. Your memory and keys are safe.",
    );
    const buttons = screen.getAllByRole("button");
    expect(buttons.map((button) => button.textContent)).toEqual(["Rebuild it"]);
    fireEvent.click(buttons[0]);
    await waitFor(() => expect(mocks.assign).toHaveBeenCalledWith(SIGN_IN));
    expect(mocks.rebuild).toHaveBeenCalledOnce();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("offers the same check-and-rebuild when Hussh can no longer see the hosting space", async () => {
    hosting("hosting_unconfirmed");
    render(<AzureHostingNotice />);
    expect(await screen.findByText(HOSTING_UNCONFIRMED_SENTENCE)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Check and rebuild" })).toBeTruthy();
  });

  it.each(["present", "agent_removed", "agent_unreadable", "unknown", "not_azure", "made_up"])(
    "renders nothing for %s",
    async (state) => {
      hosting(state);
      const { container } = render(<AzureHostingNotice />);
      await waitFor(() => expect(mocks.hosting).toHaveBeenCalled());
      expect(container.textContent).toBe("");
    },
  );

  it("renders nothing, never an error, when the hosting read fails", async () => {
    mocks.hosting.mockRejectedValue(new Error("AZURE_HOSTING_UNAVAILABLE"));
    const { container } = render(<AzureHostingNotice />);
    await waitFor(() => expect(mocks.hosting).toHaveBeenCalled());
    expect(container.textContent).toBe("");
  });

  it("shows a failed rebuild's own sentence and lets the owner try again", async () => {
    hosting("hosting_reclaimed", { status: "failed", message: "Part of your agent’s storage is gone." });
    render(<AzureHostingNotice />);
    expect(await screen.findByText("Part of your agent’s storage is gone.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Try again" })).toBeTruthy();
  });

  it("says the agent is still there and does not offer the same check again", async () => {
    hosting("hosting_unconfirmed", {
      status: "failed",
      message: "Your agent is still in your Azure subscription.",
      retryable: false,
    });
    render(<AzureHostingNotice />);
    expect(await screen.findByText("Your agent is still in your Azure subscription.")).toBeTruthy();
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("refreshes the card when adoption moves the rebuilt agent off this card", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const onRebuilt = vi.fn();
    hosting("hosting_reclaimed", { status: "running" });
    render(<AzureHostingNotice onRebuilt={onRebuilt} />);
    expect(await screen.findByText(REBUILDING_SENTENCE)).toBeTruthy();
    hosting("not_azure");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    await waitFor(() => expect(onRebuilt).toHaveBeenCalledOnce());
    expect(screen.queryByTestId("azure-hosting-notice")).toBeNull();
  });

  it("follows a running rebuild until the agent is back, then refreshes the card", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const onRebuilt = vi.fn();
    hosting("hosting_reclaimed", { status: "running" });
    render(<AzureHostingNotice onRebuilt={onRebuilt} />);
    expect(await screen.findByText(REBUILDING_SENTENCE)).toBeTruthy();
    expect(screen.queryByRole("button")).toBeNull();
    hosting("present");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    await waitFor(() => expect(onRebuilt).toHaveBeenCalledOnce());
    expect(screen.queryByText(REBUILDING_SENTENCE)).toBeNull();
  });

  it("keeps following a running rebuild while the agent is not built yet or its grant is settling", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const onRebuilt = vi.fn();
    hosting("hosting_reclaimed", { status: "running" });
    render(<AzureHostingNotice onRebuilt={onRebuilt} />);
    expect(await screen.findByText(REBUILDING_SENTENCE)).toBeTruthy();
    for (const midJob of ["agent_removed", "agent_unreadable", "present"]) {
      hosting(midJob, { status: "running" });
      const before = mocks.hosting.mock.calls.length;
      await act(async () => {
        await vi.advanceTimersByTimeAsync(10_000);
      });
      await waitFor(() => expect(mocks.hosting.mock.calls.length).toBeGreaterThan(before));
      expect(screen.getByText(REBUILDING_SENTENCE)).toBeTruthy();
      expect(onRebuilt).not.toHaveBeenCalled();
    }
    hosting("present");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    await waitFor(() => expect(onRebuilt).toHaveBeenCalledOnce());
    expect(screen.queryByTestId("azure-hosting-notice")).toBeNull();
  });

  it("shows a hand-off refused after the agent was built, with no button and no refresh", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const onRebuilt = vi.fn();
    hosting("hosting_reclaimed", { status: "running" });
    render(<AzureHostingNotice onRebuilt={onRebuilt} />);
    expect(await screen.findByText(REBUILDING_SENTENCE)).toBeTruthy();
    const refused = "Your agent was rebuilt in your subscription, but your Hussh record changed.";
    hosting("agent_unreadable", { status: "failed", message: refused, retryable: true });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    expect(await screen.findByText(refused)).toBeTruthy();
    expect(screen.queryByText(REBUILDING_SENTENCE)).toBeNull();
    expect(screen.queryByRole("button")).toBeNull();
    expect(onRebuilt).not.toHaveBeenCalled();
  });

  it("gives the action back when the server reports a dead rebuild as no longer running", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    hosting("hosting_reclaimed", { status: "running" });
    render(<AzureHostingNotice />);
    expect(await screen.findByText(REBUILDING_SENTENCE)).toBeTruthy();
    hosting("hosting_reclaimed"); // the job stopped heartbeating: the hub drops it
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    expect(await screen.findByRole("button", { name: "Rebuild it" })).toBeTruthy();
    expect(screen.queryByText(REBUILDING_SENTENCE)).toBeNull();
  });

  it("acknowledges the Microsoft popup's hand-back and shows the rebuild running", async () => {
    hosting("hosting_reclaimed");
    render(<AzureHostingNotice />);
    await screen.findByText(HOSTING_RECLAIMED_SENTENCE);
    hosting("hosting_reclaimed", { status: "running" });
    const popup = new BroadcastChannel(AZURE_SIGN_IN_CHANNEL);
    const acked = new Promise<boolean>((resolve) => {
      popup.onmessage = (event) => resolve(event.data?.type === "azure-setup-ack");
    });
    popup.postMessage({ type: "azure-setup-started" });
    expect(await acked).toBe(true);
    expect(await screen.findByText(REBUILDING_SENTENCE)).toBeTruthy();
    popup.close();
  });
});

describe("parseAzureHosting", () => {
  it("never offers a rebuild for a state that is not rebuildable, but keeps a rebuild in flight", () => {
    expect(parseAzureHosting({ state: "present", rebuildable: true, rebuild: { status: "running" } })).toEqual({
      state: "present",
      rebuildable: false,
      rebuild: { status: "running", message: null, retryable: false },
    });
    expect(
      parseAzureHosting({ state: "agent_unreadable", rebuildable: false, rebuild: { status: "failed", retryable: true } })
        .rebuild,
    ).toEqual({ status: "failed", message: null, retryable: false });
    expect(parseAzureHosting({ state: "present", rebuildable: false, rebuild: null }).rebuild).toBeNull();
  });

  it("reads an unrecognised state as unknown", () => {
    expect(parseAzureHosting({ state: "boom", rebuildable: true }).state).toBe("unknown");
  });

  it("drops a message too long to be a sentence written for the person", () => {
    const parsed = parseAzureHosting({
      state: "hosting_reclaimed",
      rebuildable: true,
      rebuild: { status: "failed", message: "x".repeat(500) },
    });
    expect(parsed.rebuild).toEqual({ status: "failed", message: null, retryable: true });
  });
});
