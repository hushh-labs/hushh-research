import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { FeedItem } from "@/lib/services/feed-service";

const sound = vi.hoisted(() => ({
  prepare: vi.fn(async () => true),
  play: vi.fn(),
}));

vi.mock("@capacitor/core", () => ({
  Capacitor: { isNativePlatform: () => false },
}));

vi.mock("@/lib/feed/feed-chime", () => ({
  prepareFeedChime: sound.prepare,
  playFeedChime: sound.play,
}));

vi.mock("@/lib/notifications/fcm-service", () => ({
  FCM_MESSAGE_EVENT: "fcm-message",
}));

import { FeedSoundControl } from "@/components/feed/feed-sound-control";

function row(id: string): FeedItem {
  return {
    id,
    source_domain: "connections",
    event_type: "connection_accepted",
    actor_label: "Someone",
    metadata: {},
    read: false,
    created_at: "2026-09-29T00:00:00.000Z",
  };
}

function driveRow(id: string): FeedItem {
  return {
    ...row(id),
    source_domain: "consent",
    event_type: "document_share_outcome",
  };
}

function push(data: Record<string, string>) {
  act(() => {
    window.dispatchEvent(new CustomEvent("fcm-message", { detail: { data } }));
  });
}

describe("Feed sound", () => {
  let now = 100_000;

  beforeEach(() => {
    window.localStorage.clear();
    sound.prepare.mockReset().mockResolvedValue(true);
    sound.play.mockReset();
    now = 100_000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      value: "visible",
    });
  });

  afterEach(() => vi.restoreAllMocks());

  it("sounds for newly confirmed activity including Drive, not hydration, polling or a batch burst", async () => {
    const view = render(<FeedSoundControl userId="owner-a" firstPageItems={[row("5")]} />);
    expect(sound.play).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Feed sound off" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Feed sound on" })).toHaveAttribute("aria-pressed", "true"));
    expect(window.localStorage.getItem("hushh:feed-sound-enabled:owner-a")).toBe("1");
    expect(sound.play).toHaveBeenCalledTimes(1); // explicit gesture preview
    sound.play.mockClear();

    view.rerender(<FeedSoundControl userId="owner-a" firstPageItems={[row("6"), row("5")]} />);
    expect(sound.play).not.toHaveBeenCalled(); // poll or local action

    push({ type: "connection_request", user_id: "owner-a" });
    view.rerender(<FeedSoundControl userId="owner-a" firstPageItems={[row("7"), row("6")]} />);
    expect(sound.play).toHaveBeenCalledTimes(1);

    push({ type: "connection_request", user_id: "owner-a" });
    view.rerender(<FeedSoundControl userId="owner-a" firstPageItems={[row("8"), row("7")]} />);
    expect(sound.play).toHaveBeenCalledTimes(1); // one cue per burst

    now += 11_000;
    push({ type: "document_share_outcome" });
    view.rerender(<FeedSoundControl userId="owner-a" firstPageItems={[driveRow("9"), row("8")]} />);
    expect(sound.play).toHaveBeenCalledTimes(2); // confirmed Drive row gets the opt-in cue
    expect(screen.getByText("Plays while Feed is open. Mac alerts may sound too.")).toBeInTheDocument();

    push({ type: "connection_request", user_id: "someone-else" });
    view.rerender(<FeedSoundControl userId="owner-a" firstPageItems={[row("10"), row("9")]} />);
    expect(sound.play).toHaveBeenCalledTimes(2);

    push({ type: "connection_request", user_id: "owner-a", notification_presentation: "silent" });
    view.rerender(<FeedSoundControl userId="owner-a" firstPageItems={[row("11"), row("10")]} />);
    expect(sound.play).toHaveBeenCalledTimes(2);

    push({ type: "connection_request", user_id: "owner-a" });
    view.rerender(<FeedSoundControl userId="owner-a" firstPageItems={[row("12"), row("11")]} />);
    expect(sound.play).toHaveBeenCalledTimes(2); // coalesced with Drive's cue

    Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
    now += 11_000;
    push({ type: "connection_request", user_id: "owner-a" });
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
    view.rerender(<FeedSoundControl userId="owner-a" firstPageItems={[row("13"), row("12")]} />);
    expect(sound.play).toHaveBeenCalledTimes(2);

    fireEvent.click(screen.getByRole("button", { name: "Feed sound on" }));
    expect(screen.getByRole("button", { name: "Feed sound off" })).toHaveAttribute("aria-pressed", "false");
    expect(window.localStorage.getItem("hushh:feed-sound-enabled:owner-a")).toBeNull();
  });

  it("keeps the preference account scoped and does not chime on a first load after a push", async () => {
    window.localStorage.setItem("hushh:feed-sound-enabled:owner-a", "1");
    const view = render(<FeedSoundControl userId="owner-a" firstPageItems={null} />);
    await waitFor(() => expect(screen.getByRole("button", { name: "Feed sound on" })).toBeInTheDocument());
    push({ type: "connection_request", user_id: "owner-a" });
    view.rerender(<FeedSoundControl userId="owner-a" firstPageItems={[row("5")]} />);
    expect(sound.play).not.toHaveBeenCalled();

    view.unmount();
    render(<FeedSoundControl userId="owner-b" firstPageItems={[row("5")]} />);
    expect(screen.getByRole("button", { name: "Feed sound off" })).toBeInTheDocument();
    expect(window.localStorage.getItem("hushh:feed-sound-enabled:owner-a")).toBe("1");
  });

  it("ignores legacy silent consent doorbells but honors an explicit alert", async () => {
    const view = render(<FeedSoundControl userId="owner-a" firstPageItems={[row("5")]} />);
    fireEvent.click(screen.getByRole("button", { name: "Feed sound off" }));
    await waitFor(() => expect(sound.play).toHaveBeenCalledTimes(1)); // preview
    sound.play.mockClear();

    push({ type: " consent_opened " });
    view.rerender(<FeedSoundControl userId="owner-a" firstPageItems={[row("6"), row("5")]} />);
    push({ type: "CONSENT_RESOLVED" });
    view.rerender(<FeedSoundControl userId="owner-a" firstPageItems={[row("7"), row("6")]} />);
    expect(sound.play).not.toHaveBeenCalled();

    push({ type: "consent_opened", notification_presentation: "alert" });
    view.rerender(<FeedSoundControl userId="owner-a" firstPageItems={[row("8"), row("7")]} />);
    expect(sound.play).toHaveBeenCalledTimes(1);
  });

  it("shows when a saved preference needs a new browser gesture after reload", async () => {
    window.localStorage.setItem("hushh:feed-sound-enabled:owner-a", "1");
    sound.prepare.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    render(<FeedSoundControl userId="owner-a" firstPageItems={[row("5")]} />);

    await waitFor(() => expect(screen.getByRole("button", { name: "Tap to activate" })).toBeInTheDocument());
    expect(sound.play).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Tap to activate" }));
    await waitFor(() => expect(screen.queryByRole("button", { name: "Tap to activate" })).toBeNull());
    expect(sound.play).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("button", { name: "Feed sound on" }));
    expect(window.localStorage.getItem("hushh:feed-sound-enabled:owner-a")).toBeNull();
  });
});
