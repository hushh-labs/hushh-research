import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  fetchPuppyResources: vi.fn(),
  fetchPuppyJobs: vi.fn(),
  setPuppyJobPaused: vi.fn(),
  // What the shared link store would hand every surface on the page.
  link: { current: null as unknown },
}));

vi.mock("@/lib/services/puppy-one-service", async (importOriginal) => {
  const original =
    await importOriginal<typeof import("@/lib/services/puppy-one-service")>();
  return {
    ...original,
    fetchPuppyResources: mocks.fetchPuppyResources,
    fetchPuppyJobs: mocks.fetchPuppyJobs,
    setPuppyJobPaused: mocks.setPuppyJobPaused,
  };
});

vi.mock("@/lib/hermes/use-puppy-link", () => ({
  usePuppyLink: () => mocks.link.current,
}));

import { PuppyMachineSheet } from "@/components/agent/puppy-resource-monitor";
import type {
  PuppyJobs,
  PuppyLink,
  PuppyResources,
} from "@/lib/services/puppy-one-service";

/**
 * The machine as One last heard from it, for a viewer the bridge cannot serve.
 *
 * On a deployed origin the bridge is a container and "not answering" is its
 * permanent state, so the heartbeat One holds is the only reading a person
 * gets. It must render in the same rows the live reading uses. The strip above
 * the control speaks ONLY for the device's own report of its session; One's
 * record is the chat panel's to explain, directly under the strip, so the same
 * sentence and the same install link can never appear twice on one screen.
 */

const UNREACHABLE: PuppyResources = { configured: true, reachable: false };
const NOT_CONFIGURED: PuppyResources = {
  configured: false,
  reason: "not_configured",
  message: "Set HERMES_API_SERVER_KEY to read the machine.",
};

function link(overrides: Partial<PuppyLink>): PuppyLink {
  return {
    state: "unavailable",
    device: null,
    activeCount: 0,
    checkedAt: Date.now(),
    ...overrides,
  };
}

function liveWithSnapshot(): PuppyLink {
  const now = Date.now();
  return link({
    state: "live",
    activeCount: 1,
    checkedAt: now,
    device: {
      id: "dev-1",
      name: "Kushal's Mac",
      lastHeartbeatAt: now - 4 * 60_000,
      lastSyncedAt: null,
      heartbeat: {
        current_model: "gemma-4-26b-a4b-qat",
        busy: true,
        active_sessions: 2,
        agent_version: "0.9.1",
        brand: "Apple",
        processor: "Apple M4 Max",
        ram_total_gb: 128,
        ram_used_pct: 41.2,
        battery_pct: 12,
        battery_charging: false,
        on_ac: false,
        next_cron_at: now + 14 * 60_000 + 2_000,
      },
    },
  });
}

async function mount(payload: PuppyResources, value: PuppyLink) {
  mocks.fetchPuppyResources.mockResolvedValue(payload);
  mocks.link.current = value;
  const view = render(<PuppyMachineSheet />);
  await waitFor(() => expect(mocks.fetchPuppyResources).toHaveBeenCalled());
  return view;
}

async function open() {
  fireEvent.click(await screen.findByRole("button", { name: /this machine/i }));
  return screen.findByRole("dialog");
}

beforeEach(() => {
  mocks.fetchPuppyJobs.mockResolvedValue({
    configured: true,
    reachable: true,
    jobs: [],
  } satisfies PuppyJobs);
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("PuppyMachineSheet reading from One", () => {
  it("renders the reported snapshot when the bridge is unreachable", async () => {
    await mount(UNREACHABLE, liveWithSnapshot());
    const sheet = await open();

    expect(
      within(sheet).getByText("Puppy One is not answering on this machine."),
    ).toBeInTheDocument();
    expect(
      within(sheet).getByText("As reported to Hussh One 4 minutes ago"),
    ).toBeInTheDocument();
    expect(within(sheet).getByText("gemma-4-26b-a4b-qat")).toBeInTheDocument();
    expect(within(sheet).getByText("busy · 2 active sessions")).toBeInTheDocument();
    expect(within(sheet).getByText("0.9.1")).toBeInTheDocument();
    expect(within(sheet).getByText("Apple · Apple M4 Max")).toBeInTheDocument();
    expect(within(sheet).getByText("41% used")).toBeInTheDocument();
    expect(within(sheet).getByText("of 128 GB")).toBeInTheDocument();
    expect(within(sheet).getByText("12%")).toBeInTheDocument();
    expect(within(sheet).getByText("On battery")).toBeInTheDocument();
    expect(within(sheet).getByText("Running down")).toBeInTheDocument();
    expect(within(sheet).getByText("Next scheduled run in 14 min")).toBeInTheDocument();
    // The jobs slot still renders under it.
    expect(
      within(sheet).getByText("Nothing is scheduled on this machine."),
    ).toBeInTheDocument();
    // A live link is silent on the strip.
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("renders the reported snapshot when the bridge is not configured", async () => {
    await mount(NOT_CONFIGURED, liveWithSnapshot());
    const sheet = await open();
    expect(
      within(sheet).getByText("Set HERMES_API_SERVER_KEY to read the machine."),
    ).toBeInTheDocument();
    expect(within(sheet).getByText("gemma-4-26b-a4b-qat")).toBeInTheDocument();
    expect(within(sheet).getByText("Apple · Apple M4 Max")).toBeInTheDocument();
  });

  it("does not repeat the snapshot when the bridge is answering", async () => {
    await mount(
      {
        configured: true,
        reachable: true,
        agent: { model: "live-model", on_device: true, on_device_gate: true },
        machine: { ram_used_pct: 55 },
      },
      liveWithSnapshot(),
    );
    const sheet = await open();
    expect(within(sheet).getByText("live-model")).toBeInTheDocument();
    expect(within(sheet).queryByText(/As reported to Hussh One/)).not.toBeInTheDocument();
    expect(within(sheet).queryByText("gemma-4-26b-a4b-qat")).not.toBeInTheDocument();
  });

  it("renders nothing reported when the device has no snapshot", async () => {
    await mount(
      UNREACHABLE,
      link({
        state: "quiet",
        activeCount: 1,
        device: {
          id: "dev-1",
          name: "Kushal's Mac",
          lastHeartbeatAt: null,
          lastSyncedAt: null,
          heartbeat: null,
        },
      }),
    );
    const sheet = await open();
    expect(within(sheet).queryByText(/As reported to Hussh One/)).not.toBeInTheDocument();
  });

  it("leaves One's record to the chat panel: no install link, no banner on the strip", async () => {
    // The chat panel directly under this strip explains One's record with
    // the way out. Saying it here too put the same sentence and the same
    // install link on one screen twice, so the strip is silent about One in
    // every state: unlinked, quiet, revoked.
    for (const value of [
      link({ state: "unlinked" }),
      link({ state: "revoked" }),
      link({
        state: "quiet",
        activeCount: 1,
        device: {
          id: "dev-1",
          name: "Kushal's Mac",
          lastHeartbeatAt: Date.now() - 3 * 60 * 60_000,
          lastSyncedAt: null,
          heartbeat: null,
        },
      }),
    ]) {
      const view = await mount(UNREACHABLE, value);
      expect(screen.queryByRole("status"), value.state).not.toBeInTheDocument();
      expect(
        screen.queryByRole("link", { name: "Get Puppy One on GitHub" }),
        value.state,
      ).not.toBeInTheDocument();
      expect(screen.queryByText(/Hussh One/), value.state).not.toBeInTheDocument();
      view.unmount();
      vi.clearAllMocks();
      mocks.fetchPuppyJobs.mockResolvedValue({
        configured: true,
        reachable: true,
        jobs: [],
      } satisfies PuppyJobs);
    }
  });

  it("lets the device's own report speak when the bridge can read it, never both", async () => {
    await mount(
      {
        configured: true,
        reachable: true,
        link: { session: "expired", remedy: "/hussh-one reconnect" },
      },
      link({ state: "unlinked" }),
    );
    expect(
      await screen.findByText(/signed out of Hussh One/),
    ).toBeInTheDocument();
    expect(screen.queryByText(/Not connected to Hussh One yet/)).not.toBeInTheDocument();
    expect(screen.getAllByRole("status")).toHaveLength(1);
  });

  it("stays silent when the bridge says not_connected, whatever One says", async () => {
    await mount(
      {
        configured: true,
        reachable: true,
        link: { connected: false, session: "not_connected" },
      },
      link({ state: "revoked" }),
    );
    await waitFor(() =>
      expect(mocks.fetchPuppyResources).toHaveBeenCalledTimes(1),
    );
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    expect(screen.queryByText(/Hussh One/)).not.toBeInTheDocument();
  });

  it("shows nothing from One while the bridge is still being read", async () => {
    // Until the bridge answers, One's reading would be a second account of
    // the machine that a live bridge is about to replace.
    mocks.fetchPuppyResources.mockReturnValue(new Promise(() => {}));
    mocks.link.current = liveWithSnapshot();
    render(<PuppyMachineSheet />);
    fireEvent.click(await screen.findByRole("button", { name: /this machine/i }));
    const sheet = await screen.findByRole("dialog");
    expect(within(sheet).getByText("Reading this machine…")).toBeInTheDocument();
    expect(within(sheet).queryByText(/As reported to Hussh One/)).not.toBeInTheDocument();
  });
});
