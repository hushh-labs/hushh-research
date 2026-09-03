import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  fetchPuppyResources: vi.fn(),
}));

vi.mock("@/lib/services/puppy-one-service", async (importOriginal) => {
  const original =
    await importOriginal<typeof import("@/lib/services/puppy-one-service")>();
  return { ...original, fetchPuppyResources: mocks.fetchPuppyResources };
});

import { PuppyMachineSheet } from "@/components/agent/puppy-resource-monitor";
import type { PuppyResources } from "@/lib/services/puppy-one-service";

/**
 * The readings are the owner's to ask for.
 *
 * Two promises are load-bearing here and neither is a matter of taste:
 *
 *  1. A dead link to Hussh One is announced WITHOUT asking. Every other
 *     reading keeps saying "healthy" while a machine's login is gone, so the
 *     one fact that cannot be inferred from the rest is the one fact that
 *     cannot be put behind a tap.
 *  2. A shut sheet is silent. Nothing repeats against the local gateway while
 *     nobody is looking at the answer.
 */

function mount(payload: PuppyResources) {
  mocks.fetchPuppyResources.mockResolvedValue(payload);
  return render(<PuppyMachineSheet />);
}

function trigger() {
  return screen.getByRole("button", { name: /this machine/i });
}

afterEach(() => {
  vi.clearAllMocks();
});

describe("PuppyMachineSheet", () => {
  it("shows no statistics until the owner asks for them", async () => {
    mount({
      configured: true,
      reachable: true,
      agent: { model: "google/gemma-4-26b-a4b-qat", on_device: true, on_device_gate: true },
      machine: { ram_used_pct: 41.2, disk_free_gb: 54.7 },
      jobs: { enabled: 11 },
    });

    // The reading has landed; none of it is on screen.
    await waitFor(() =>
      expect(mocks.fetchPuppyResources).toHaveBeenCalledTimes(1),
    );
    expect(screen.queryByText("On this machine")).not.toBeInTheDocument();
    expect(screen.queryByText("Headroom")).not.toBeInTheDocument();
    expect(screen.queryByText("Scheduled work")).not.toBeInTheDocument();
    expect(screen.queryByText("41% used")).not.toBeInTheDocument();

    // One control, named for what it opens.
    expect(trigger()).toBeInTheDocument();
  });

  it("opens the readings on the control, and puts them away again", async () => {
    mount({
      configured: true,
      reachable: true,
      agent: { model: "m", on_device: true, on_device_gate: true },
      machine: { ram_used_pct: 41.2 },
    });
    const control = await screen.findByRole("button", { name: /this machine/i });

    fireEvent.click(control);

    const sheet = await screen.findByRole("dialog");
    expect(within(sheet).getByText("On this machine")).toBeInTheDocument();
    expect(within(sheet).getByText("41% used")).toBeInTheDocument();

    fireEvent.click(within(sheet).getByRole("button", { name: "Close" }));
    await waitFor(() =>
      expect(screen.queryByText("41% used")).not.toBeInTheDocument(),
    );
  });

  it("carries the calm states into the sheet unchanged", async () => {
    const notConfigured = mount({
      configured: false,
      reason: "not_configured",
      message: "Set HERMES_API_SERVER_KEY to read the machine.",
    });
    fireEvent.click(await screen.findByRole("button", { name: /this machine/i }));
    expect(
      await screen.findByText("Set HERMES_API_SERVER_KEY to read the machine."),
    ).toBeInTheDocument();
    notConfigured.unmount();

    mount({ configured: true, reachable: false });
    fireEvent.click(await screen.findByRole("button", { name: /this machine/i }));
    expect(
      await screen.findByText("Puppy One is not answering on this machine."),
    ).toBeInTheDocument();
  });

  it("announces a signed-out machine without being asked, remedy verbatim", async () => {
    mount({
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
    // Nothing was opened to learn that.
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.queryByText("On this machine")).not.toBeInTheDocument();
  });

  it("invents no remedy when the payload carries none", async () => {
    mount({ configured: true, reachable: true, link: { session: "expired" } });
    expect(
      await screen.findByText(/signed out of Hussh One/),
    ).toBeInTheDocument();
    expect(screen.queryByText(/hussh-one/)).not.toBeInTheDocument();
  });

  it("says a revoked device is sealed, inline", async () => {
    mount({
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

  it("keeps an unreadable link state inline, quiet rather than alarming", async () => {
    mount({
      configured: true,
      reachable: true,
      link: { session: "indeterminate" },
    });
    expect(
      await screen.findByText("Link state could not be checked"),
    ).toBeInTheDocument();
  });

  it("does not resolve an unrecognised session onto a known state", async () => {
    mount({
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

  it("puts no banner on the page for a link that is fine, or was never made", async () => {
    const healthy = mount({
      configured: true,
      reachable: true,
      link: {
        connected: true,
        session: "ok",
        account_email: "owner@example.com",
        environment: "uat",
      },
    });
    await waitFor(() =>
      expect(mocks.fetchPuppyResources).toHaveBeenCalledTimes(1),
    );
    // The account line is a footnote inside the sheet, not a banner outside it.
    expect(screen.queryByText(/Signed in to Hussh One/)).not.toBeInTheDocument();
    healthy.unmount();
    mocks.fetchPuppyResources.mockClear();

    mount({
      configured: true,
      reachable: true,
      link: { connected: false, session: "not_connected" },
    });
    await waitFor(() =>
      expect(mocks.fetchPuppyResources).toHaveBeenCalledTimes(1),
    );
    expect(screen.queryByText(/Hussh One/)).not.toBeInTheDocument();
    expect(
      screen.queryByText("Link state could not be checked"),
    ).not.toBeInTheDocument();
  });

  it("reads the machine once while shut, and keeps reading only while open", async () => {
    vi.useFakeTimers();
    try {
      mocks.fetchPuppyResources.mockResolvedValue({
        configured: true,
        reachable: true,
      });
      render(<PuppyMachineSheet />);

      // The one cheap check: enough to decide whether the banner shows.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(mocks.fetchPuppyResources).toHaveBeenCalledTimes(1);

      // Three poll intervals with the sheet shut, and not one request.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(60_000);
      });
      expect(mocks.fetchPuppyResources).toHaveBeenCalledTimes(1);

      const control = trigger();
      fireEvent.click(control);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      // Opening takes a fresh reading rather than showing a stale one.
      expect(mocks.fetchPuppyResources).toHaveBeenCalledTimes(2);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(20_000);
      });
      expect(mocks.fetchPuppyResources).toHaveBeenCalledTimes(3);

      fireEvent.click(screen.getByRole("button", { name: "Close" }));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(60_000);
      });
      expect(mocks.fetchPuppyResources).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it("stops reading once it is off screen", async () => {
    mocks.fetchPuppyResources.mockResolvedValue({
      configured: true,
      reachable: true,
    });
    const view = render(<PuppyMachineSheet />);
    fireEvent.click(trigger());
    await waitFor(() =>
      expect(mocks.fetchPuppyResources).toHaveBeenCalledTimes(2),
    );
    view.unmount();
    vi.useFakeTimers();
    try {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(60_000);
      });
      expect(mocks.fetchPuppyResources).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });
});
