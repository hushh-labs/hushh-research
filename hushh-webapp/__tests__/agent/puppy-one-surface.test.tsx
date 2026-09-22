import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  fetchPuppyStatus: vi.fn(),
  fetchPuppyResources: vi.fn(),
  fetchPuppyJobs: vi.fn(),
  setPuppyJobPaused: vi.fn(),
  link: { current: null as unknown },
}));

vi.mock("@/lib/services/puppy-one-service", async (importOriginal) => {
  const original =
    await importOriginal<typeof import("@/lib/services/puppy-one-service")>();
  return {
    ...original,
    fetchPuppyStatus: mocks.fetchPuppyStatus,
    fetchPuppyResources: mocks.fetchPuppyResources,
    fetchPuppyJobs: mocks.fetchPuppyJobs,
    setPuppyJobPaused: mocks.setPuppyJobPaused,
  };
});

vi.mock("@/lib/hermes/use-puppy-link", () => ({
  usePuppyLink: () => mocks.link.current,
}));

vi.mock("@/components/agent/puppy-model-picker", () => ({
  PuppyModelPicker: () => null,
}));

import { PuppyOneSurface } from "@/components/agent/puppy-one-surface";
import type { PuppyLink } from "@/lib/services/puppy-one-service";

/**
 * The Puppy One mode, as the workspace mounts it.
 *
 * Two things are load-bearing. Somebody who has never installed anything must
 * be told what this is, once, before being handed an install link. And the
 * mode is kept MOUNTED and hidden when the reader looks at One, so a local
 * answer that takes tens of seconds is not destroyed by the glance, which
 * means `active` has to be what stops it polling and what closes its machine
 * panel: that panel is a portal on document.body, and a `hidden` class on this
 * surface's root cannot reach it.
 */

function link(overrides: Partial<PuppyLink>): PuppyLink {
  return {
    state: "unavailable",
    device: null,
    activeCount: 0,
    checkedAt: Date.now(),
    ...overrides,
  };
}

function reporting(): PuppyLink {
  const now = Date.now();
  return link({
    state: "live",
    activeCount: 1,
    device: {
      id: "dev-1",
      name: "Kushal's Mac",
      lastHeartbeatAt: now - 60_000,
      lastSyncedAt: null,
      heartbeat: { current_model: "gemma-4-26b-a4b-qat", busy: false },
    },
  });
}

beforeEach(() => {
  mocks.fetchPuppyStatus.mockResolvedValue({ connected: false });
  mocks.fetchPuppyResources.mockResolvedValue({
    configured: true,
    reachable: true,
    agent: { model: "m", on_device: true, on_device_gate: true },
  });
  mocks.fetchPuppyJobs.mockResolvedValue({
    configured: true,
    reachable: true,
    jobs: [],
  });
  mocks.link.current = null;
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("PuppyOneSurface identity", () => {
  it("says what Puppy One is to someone who has never connected one", async () => {
    mocks.link.current = link({ state: "unlinked" });
    render(<PuppyOneSurface />);
    expect(
      await screen.findByText(
        /A personal supercomputer you own\. Pin a model to this machine and answers never leave it\./,
      ),
    ).toBeInTheDocument();
  });

  it("does not repeat it to an owner whose machine is already reporting", async () => {
    mocks.link.current = reporting();
    render(<PuppyOneSurface />);
    await waitFor(() => expect(mocks.fetchPuppyStatus).toHaveBeenCalled());
    expect(
      screen.queryByText(/A personal supercomputer you own/),
    ).not.toBeInTheDocument();
  });
});

describe("PuppyOneSurface when it is not the surface on screen", () => {
  it("takes no readings at all", async () => {
    mocks.link.current = reporting();
    render(<PuppyOneSurface active={false} />);
    await act(async () => {
      await Promise.resolve();
    });
    expect(mocks.fetchPuppyStatus).not.toHaveBeenCalled();
    expect(mocks.fetchPuppyResources).not.toHaveBeenCalled();
  });

  it("reads again the moment it comes back, rather than showing a stale pill", async () => {
    // Green means "reported inside the freshness window". Coming back after
    // ten minutes hidden to a cached green pill would assert a live machine
    // on stale data, which is the one promise this pill makes.
    mocks.link.current = reporting();
    const view = render(<PuppyOneSurface active={false} />);
    view.rerender(<PuppyOneSurface active />);
    await waitFor(() => expect(mocks.fetchPuppyStatus).toHaveBeenCalledTimes(1));
    await waitFor(() =>
      expect(mocks.fetchPuppyResources).toHaveBeenCalledTimes(1),
    );
  });

  it("closes the machine panel instead of leaving it over One's transcript", async () => {
    mocks.link.current = reporting();
    const view = render(<PuppyOneSurface active />);
    fireEvent.click(await screen.findByRole("button", { name: /this machine/i }));
    expect(await screen.findByRole("dialog")).toBeInTheDocument();

    view.rerender(<PuppyOneSurface active={false} />);
    await waitFor(() =>
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
    );
  });
});
