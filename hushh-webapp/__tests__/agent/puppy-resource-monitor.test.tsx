import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  fetchPuppyResources: vi.fn(),
}));

vi.mock("@/lib/services/puppy-one-service", async (importOriginal) => {
  const original =
    await importOriginal<typeof import("@/lib/services/puppy-one-service")>();
  return { ...original, fetchPuppyResources: mocks.fetchPuppyResources };
});

import { PuppyResourceMonitor } from "@/components/agent/puppy-resource-monitor";
import type { PuppyResources } from "@/lib/services/puppy-one-service";

/**
 * What the reader sees, not what the component renders internally.
 *
 * The three origin states are the ones worth defending: "on this machine",
 * "local turn with the gate off", and "answers leave this machine" are three
 * different promises, and collapsing any two of them would make this surface
 * claim something the runtime is not doing.
 */

function show(payload: PuppyResources) {
  mocks.fetchPuppyResources.mockResolvedValue(payload);
  return render(<PuppyResourceMonitor />);
}

afterEach(() => {
  vi.clearAllMocks();
});

describe("PuppyResourceMonitor", () => {
  it("says the answer is generated here only when the gate is on too", async () => {
    show({
      configured: true,
      reachable: true,
      agent: {
        model: "google/gemma-4-26b-a4b-qat",
        on_device: true,
        on_device_gate: true,
      },
    });
    expect(await screen.findByText("On this machine")).toBeInTheDocument();
    expect(
      screen.getByText("google/gemma-4-26b-a4b-qat"),
    ).toBeInTheDocument();
  });

  it("says auxiliary work may leave when the model is local but the gate is off", async () => {
    show({
      configured: true,
      reachable: true,
      agent: { model: "m", on_device: true, on_device_gate: false },
    });
    expect(
      await screen.findByText("This turn is local; auxiliary work may leave"),
    ).toBeInTheDocument();
    expect(screen.queryByText("On this machine")).not.toBeInTheDocument();
  });

  it("does not claim the gate is on when the gate was not reported", async () => {
    show({
      configured: true,
      reachable: true,
      agent: { model: "m", on_device: true },
    });
    expect(
      await screen.findByText("This turn is local; auxiliary work may leave"),
    ).toBeInTheDocument();
  });

  it("says answers leave the machine for a non-local provider", async () => {
    show({
      configured: true,
      reachable: true,
      agent: { model: "gpt-5", provider: "openai", on_device: false },
    });
    expect(
      await screen.findByText("Answers leave this machine"),
    ).toBeInTheDocument();
  });

  it("makes no origin claim at all when on_device was not reported", async () => {
    show({ configured: true, reachable: true, agent: { model: "m" } });
    expect(await screen.findByText("m")).toBeInTheDocument();
    expect(screen.queryByText("On this machine")).not.toBeInTheDocument();
    expect(
      screen.queryByText("Answers leave this machine"),
    ).not.toBeInTheDocument();
  });

  it("shows a desktop's absent battery as 'No battery', never as 0%", async () => {
    show({
      configured: true,
      reachable: true,
      machine: { ram_used_pct: 41.2, battery: { present: false } },
    });
    expect(await screen.findByText("No battery")).toBeInTheDocument();
    expect(screen.queryByText("0%")).not.toBeInTheDocument();
  });

  it("warns in words as well as colour when the disk is nearly full", async () => {
    show({
      configured: true,
      reachable: true,
      machine: { disk_free_gb: 54.7, disk_used_pct: 94.1 },
    });
    expect(await screen.findByText("Nearly full")).toBeInTheDocument();
    expect(screen.getByText("54.7 GB free")).toBeInTheDocument();
    expect(screen.getByText("94% used")).toBeInTheDocument();
  });

  it("warns only when the battery is low AND discharging", async () => {
    const charging = show({
      configured: true,
      reachable: true,
      machine: {
        battery: { present: true, percent: 12, charging: true, on_ac: true },
      },
    });
    expect(await screen.findByText("12%")).toBeInTheDocument();
    expect(screen.queryByText("Running down")).not.toBeInTheDocument();
    charging.unmount();

    show({
      configured: true,
      reachable: true,
      machine: {
        battery: { present: true, percent: 12, charging: false, on_ac: false },
      },
    });
    expect(await screen.findByText("Running down")).toBeInTheDocument();
  });

  it("reads the next job as a relative time off the gateway's own clock", async () => {
    show({
      configured: true,
      reachable: true,
      generated_at: Date.parse("2026-09-02T14:02:51-07:00"),
      jobs: {
        enabled: 11,
        disabled: 2,
        next: { at: "2026-09-02T14:16:51-07:00", name: "Self-Healing Doctor" },
        last_24h: { completed: 150, failed: 3 },
      },
    });
    expect(await screen.findByText("11 scheduled")).toBeInTheDocument();
    expect(screen.getByText("· 2 off")).toBeInTheDocument();
    expect(screen.getByText(/Self-Healing Doctor/)).toBeInTheDocument();
    expect(screen.getByText("in 14 min")).toBeInTheDocument();
    expect(screen.getByText(/150 completed/)).toBeInTheDocument();
    expect(screen.getByText(/3 failed/)).toBeInTheDocument();
  });

  it("leads with a broken Hussh One link, and quotes the remedy verbatim", async () => {
    show({
      configured: true,
      reachable: true,
      link: {
        connected: true,
        account_email: "owner@example.com",
        environment: "uat",
        session: "expired",
        heartbeat_live: true,
        remedy: "/hussh-one reconnect",
      },
      agent: { model: "m", on_device: true, on_device_gate: true },
    });
    expect(
      await screen.findByText(
        "This machine is signed out of Hussh One. It is still trusted; One just cannot see it.",
      ),
    ).toBeInTheDocument();
    expect(screen.getByText("/hussh-one reconnect")).toBeInTheDocument();
    // The local readings are still true, which is exactly the trap: the
    // machine looks healthy while One cannot see it.
    expect(screen.getByText("On this machine")).toBeInTheDocument();
  });

  it("invents no remedy when the payload carries none", async () => {
    show({
      configured: true,
      reachable: true,
      link: { session: "expired" },
    });
    expect(
      await screen.findByText(/signed out of Hussh One/),
    ).toBeInTheDocument();
    expect(screen.queryByText(/hussh-one/)).not.toBeInTheDocument();
  });

  it("says a revoked device is sealed", async () => {
    show({
      configured: true,
      reachable: true,
      link: { session: "revoked", remedy: "/hussh-one enroll" },
    });
    expect(
      await screen.findByText(
        "This device was revoked in One. Its local copy is sealed.",
      ),
    ).toBeInTheDocument();
    expect(screen.getByText("/hussh-one enroll")).toBeInTheDocument();
  });

  it("keeps an unreadable link state quiet rather than alarming", async () => {
    show({
      configured: true,
      reachable: true,
      link: { session: "indeterminate" },
    });
    expect(
      await screen.findByText("Link state could not be checked"),
    ).toBeInTheDocument();
  });

  it("does not resolve an unrecognised session onto a known state", async () => {
    show({
      configured: true,
      reachable: true,
      link: { session: "something-a-later-gateway-invented" },
    });
    expect(
      await screen.findByText("Link state could not be checked"),
    ).toBeInTheDocument();
    expect(screen.queryByText(/signed out of Hussh One/)).not.toBeInTheDocument();
    expect(screen.queryByText(/revoked/)).not.toBeInTheDocument();
  });

  it("gives a healthy link one small line, not a banner", async () => {
    show({
      configured: true,
      reachable: true,
      link: {
        connected: true,
        session: "ok",
        account_email: "owner@example.com",
        environment: "uat",
      },
      agent: { model: "m", on_device: true, on_device_gate: true },
    });
    expect(
      await screen.findByText("Signed in to Hussh One · owner@example.com · uat"),
    ).toBeInTheDocument();
  });

  it("never renders an account email the payload did not carry", async () => {
    show({
      configured: true,
      reachable: true,
      link: { connected: true, session: "ok", environment: "uat" },
      agent: { model: "m" },
    });
    expect(await screen.findByText("m")).toBeInTheDocument();
    expect(screen.getByText("Signed in to Hussh One · uat")).toBeInTheDocument();
    expect(screen.queryByText(/@/)).not.toBeInTheDocument();
  });

  it("says nothing about a machine that was never linked", async () => {
    show({
      configured: true,
      reachable: true,
      link: { connected: false, session: "not_connected" },
      agent: { model: "m", on_device: true, on_device_gate: true },
    });
    expect(await screen.findByText("On this machine")).toBeInTheDocument();
    expect(screen.queryByText(/Hussh One/)).not.toBeInTheDocument();
    expect(
      screen.queryByText("Link state could not be checked"),
    ).not.toBeInTheDocument();
  });

  it("renders with the link section absent, and with it empty", async () => {
    const absent = show({
      configured: true,
      reachable: true,
      agent: { model: "m", on_device: true, on_device_gate: true },
    });
    expect(await screen.findByText("On this machine")).toBeInTheDocument();
    expect(
      screen.queryByText("Link state could not be checked"),
    ).not.toBeInTheDocument();
    absent.unmount();

    // An empty section carries no session, so it makes no claim either way.
    show({
      configured: true,
      reachable: true,
      link: {},
      agent: { model: "m", on_device: true, on_device_gate: true },
    });
    expect(await screen.findByText("On this machine")).toBeInTheDocument();
    expect(
      screen.queryByText("Link state could not be checked"),
    ).not.toBeInTheDocument();
  });

  it("renders only the sections the machine could answer", async () => {
    show({
      configured: true,
      reachable: true,
      agent: { model: "m", on_device: true, on_device_gate: true },
    });
    expect(await screen.findByText("On this machine")).toBeInTheDocument();
    // No models, machine or jobs probe answered, so none of those headings
    // exist. An empty "0 GB free" would be a reading nobody took.
    expect(screen.queryByText("Model memory")).not.toBeInTheDocument();
    expect(screen.queryByText("Headroom")).not.toBeInTheDocument();
    expect(screen.queryByText("Scheduled work")).not.toBeInTheDocument();
  });

  it("renders not-configured and unreachable as calm states, not errors", async () => {
    const notConfigured = show({
      configured: false,
      reason: "not_configured",
      message: "Set HERMES_API_SERVER_KEY to read the machine.",
    });
    expect(
      await screen.findByText("Set HERMES_API_SERVER_KEY to read the machine."),
    ).toBeInTheDocument();
    notConfigured.unmount();

    show({ configured: true, reachable: false });
    expect(
      await screen.findByText("Puppy One is not answering on this machine."),
    ).toBeInTheDocument();
  });

  it("polls the machine rather than reading it once", async () => {
    vi.useFakeTimers();
    try {
      mocks.fetchPuppyResources.mockResolvedValue({
        configured: true,
        reachable: true,
      });
      render(<PuppyResourceMonitor />);
      await vi.advanceTimersByTimeAsync(0);
      expect(mocks.fetchPuppyResources).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(20_000);
      expect(mocks.fetchPuppyResources).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("stops reading once it is off screen", async () => {
    mocks.fetchPuppyResources.mockResolvedValue({
      configured: true,
      reachable: true,
    });
    const view = render(<PuppyResourceMonitor />);
    await waitFor(() =>
      expect(mocks.fetchPuppyResources).toHaveBeenCalledTimes(1),
    );
    view.unmount();
    vi.useFakeTimers();
    try {
      await vi.advanceTimersByTimeAsync(60_000);
      expect(mocks.fetchPuppyResources).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
