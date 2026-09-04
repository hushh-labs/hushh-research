import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  fetchPuppyResources: vi.fn(),
  fetchPuppyJobs: vi.fn(),
  setPuppyJobPaused: vi.fn(),
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

// One's own record of the device is a separate authority, tested next door
// in `puppy-machine-sheet-remote-reading.test.tsx`. Here it has nothing to
// say, so every assertion in this file is about the device's own report.
vi.mock("@/lib/hermes/use-puppy-link", () => ({
  usePuppyLink: () => null,
}));

import {
  MACHINE_PANEL_SHEET_QUERY,
  PuppyMachineSheet,
} from "@/components/agent/puppy-resource-monitor";
import type {
  PuppyJob,
  PuppyJobs,
  PuppyResources,
} from "@/lib/services/puppy-one-service";

/**
 * The readings are the owner's to ask for.
 *
 * Two promises are load-bearing here and neither is a matter of taste:
 *
 *  1. A dead link to Hussh One is announced WITHOUT asking. Every other
 *     reading keeps saying "healthy" while a machine's login is gone, so the
 *     one fact that cannot be inferred from the rest is the one fact that
 *     cannot be put behind a tap.
 *  2. A shut panel is silent. Nothing repeats against the local gateway while
 *     nobody is looking at the answer.
 *
 * `__tests__/setup.ts` stubs `matchMedia` as permanently non-matching, which
 * is the desktop answer; the phone lane restubs it per test.
 */

/** Answers only the panel's own breakpoint, and only as this test wants. */
function setViewport(kind: "phone" | "desktop") {
  const wantsSheet = kind === "phone";
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches: query === MACHINE_PANEL_SHEET_QUERY ? wantsSheet : false,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  });
}

function mount(payload: PuppyResources) {
  mocks.fetchPuppyResources.mockResolvedValue(payload);
  return render(<PuppyMachineSheet />);
}

function trigger() {
  return screen.getByRole("button", { name: /this machine/i });
}

beforeEach(() => {
  setViewport("desktop");
  mocks.fetchPuppyJobs.mockResolvedValue({
    configured: true,
    reachable: true,
    jobs: [],
  } satisfies PuppyJobs);
});

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

function job(overrides: Partial<PuppyJob> = {}): PuppyJob {
  return {
    id: "job",
    name: "A job",
    schedule: null,
    paused: false,
    nextRunAt: null,
    lastStatus: null,
    lastError: null,
    failureStreak: 0,
    ...overrides,
  };
}

/** An ISO stamp `minutes` from now, nudged so rounding cannot land short. */
function inMinutes(minutes: number): string {
  return new Date(Date.now() + minutes * 60_000 + 2_000).toISOString();
}

async function openWithJobs(jobs: PuppyJob[] | PuppyJobs) {
  mocks.fetchPuppyJobs.mockResolvedValue(
    Array.isArray(jobs) ? { configured: true, reachable: true, jobs } : jobs,
  );
  mount({ configured: true, reachable: true, agent: { model: "m" } });
  fireEvent.click(await screen.findByRole("button", { name: /this machine/i }));
  return screen.findByRole("dialog");
}

/**
 * A bottom sheet is the phone's container, not the desktop's.
 *
 * The assertion is about WHICH surface opened, not how it looks: both are
 * `role="dialog"`, so the data-slot each primitive stamps is the only honest
 * way to tell a sheet from a dialog. And exactly one exists, because two
 * mounted copies would be two lists of switches over one machine.
 */
describe("PuppyMachineSheet container", () => {
  const READINGS: PuppyResources = {
    configured: true,
    reachable: true,
    agent: { model: "m", on_device: true, on_device_gate: true },
    machine: { ram_used_pct: 41.2 },
  };

  it("opens the centred dialog on a desktop, never the bottom sheet", async () => {
    setViewport("desktop");
    mount(READINGS);
    fireEvent.click(
      await screen.findByRole("button", { name: /this machine/i }),
    );

    await screen.findByRole("dialog");
    expect(
      document.querySelectorAll('[data-slot="dialog-content"]'),
    ).toHaveLength(1);
    expect(
      document.querySelectorAll('[data-slot="sheet-content"]'),
    ).toHaveLength(0);
    expect(screen.getByText("On this machine")).toBeInTheDocument();
    expect(screen.getByText("41% used")).toBeInTheDocument();
  });

  it("keeps the bottom sheet on a phone", async () => {
    setViewport("phone");
    mount(READINGS);
    fireEvent.click(
      await screen.findByRole("button", { name: /this machine/i }),
    );

    await screen.findByRole("dialog");
    expect(
      document.querySelectorAll('[data-slot="sheet-content"]'),
    ).toHaveLength(1);
    expect(
      document.querySelectorAll('[data-slot="dialog-content"]'),
    ).toHaveLength(0);
    expect(screen.getByText("On this machine")).toBeInTheDocument();
  });

  it("mounts the panel once, inside one container", async () => {
    setViewport("desktop");
    const panel = await openWithJobs([
      job({ id: "auto-dream", name: "Auto-Dream" }),
    ]);

    expect(
      await within(panel).findAllByRole("switch", { name: "Auto-Dream" }),
    ).toHaveLength(1);
    expect(
      document.querySelectorAll('section[aria-label="Puppy One machine"]'),
    ).toHaveLength(1);
  });
});

/**
 * The scheduled work, and the switch for each job.
 *
 * The switch is the part that has to be exactly right. It shows what the
 * GATEWAY says the job is doing -- never a local guess -- so it cannot appear
 * to have flipped before the machine agreed, and a refusal leaves the job
 * where it was rather than leaving a lie on the screen.
 */
describe("PuppyMachineSheet scheduled work", () => {
  it("reads the jobs when the panel opens, and never while it is shut", async () => {
    mount({ configured: true, reachable: true, agent: { model: "m" } });
    await waitFor(() =>
      expect(mocks.fetchPuppyResources).toHaveBeenCalledTimes(1),
    );
    // The readings take one shut reading, for the link banner. The jobs have
    // no such duty, so nobody asked the gateway anything about them.
    expect(mocks.fetchPuppyJobs).not.toHaveBeenCalled();

    fireEvent.click(trigger());
    await waitFor(() => expect(mocks.fetchPuppyJobs).toHaveBeenCalledTimes(1));

    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    vi.useFakeTimers();
    try {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(120_000);
      });
      expect(mocks.fetchPuppyJobs).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("says the schedule in words, when it next runs, and that the last run was ok", async () => {
    const panel = await openWithJobs([
      job({
        id: "auto-dream",
        name: "Auto-Dream",
        schedule: "10 3 * * *",
        nextRunAt: inMinutes(13 * 60),
        lastStatus: "ok",
      }),
    ]);

    expect(await within(panel).findByText("Auto-Dream")).toBeInTheDocument();
    expect(
      within(panel).getByText("Daily at 03:10 · next in 13 h · last run ok"),
    ).toBeInTheDocument();
    expect(
      within(panel).getByRole("switch", { name: "Auto-Dream" }),
    ).toBeChecked();
  });

  it("translates only the cron it can translate exactly, and prints the rest verbatim", async () => {
    const panel = await openWithJobs([
      job({ id: "doctor", name: "Doctor", schedule: "*/15 * * * *" }),
      job({ id: "board", name: "Board sync", schedule: "0 9 * * 1" }),
      job({ id: "sheet", name: "Timesheet", schedule: "30 6 1 * *" }),
      job({ id: "wiki", name: "Wiki", schedule: "15 * * * *" }),
      job({ id: "sync", name: "Board sync", schedule: "0 */6 * * *" }),
      // Not five fields, and a shape with more than one reading: each is said
      // as it stands, because a schedule described wrongly is the sentence
      // someone would act on.
      job({ id: "loop", name: "Loop", schedule: "every 30m" }),
      job({ id: "odd", name: "Odd", schedule: "0 9 * * MON-FRI" }),
    ]);

    expect(await within(panel).findByText("Every 15 min")).toBeInTheDocument();
    expect(within(panel).getByText("Mondays at 09:00")).toBeInTheDocument();
    expect(
      within(panel).getByText("Monthly on the 1st at 06:30"),
    ).toBeInTheDocument();
    expect(within(panel).getByText("Hourly at :15")).toBeInTheDocument();
    expect(within(panel).getByText("Every 6 h at :00")).toBeInTheDocument();
    expect(within(panel).getByText("every 30m")).toBeInTheDocument();
    expect(within(panel).getByText("0 9 * * MON-FRI")).toBeInTheDocument();
  });

  it("marks a failing job in words and a glyph, not only in colour", async () => {
    const panel = await openWithJobs([
      job({
        id: "doctor",
        name: "Self-Healing Doctor",
        schedule: "*/15 * * * *",
        nextRunAt: inMinutes(14),
        lastStatus: "error",
        lastError: "gateway timeout after 30s",
        failureStreak: 3,
      }),
      job({ id: "healthy", name: "Board sync", lastStatus: "ok" }),
    ]);

    expect(
      await within(panel).findByText("Failed 3 runs in a row"),
    ).toBeInTheDocument();
    // The machine's own words, not ours.
    expect(
      within(panel).getByText("gateway timeout after 30s"),
    ).toBeInTheDocument();
    expect(
      within(panel).getByText("Every 15 min · next in 14 min"),
    ).toBeInTheDocument();
    // A healthy job wears none of it.
    expect(within(panel).getByText("last run ok")).toBeInTheDocument();
  });

  it("reads a paused job as deliberately off, not as a fault", async () => {
    const panel = await openWithJobs([
      job({
        id: "janitor",
        name: "WhatsApp Janitor",
        schedule: "0 9 * * 1",
        paused: true,
        nextRunAt: inMinutes(60),
      }),
    ]);

    expect(
      await within(panel).findByText("Mondays at 09:00 · Paused"),
    ).toBeInTheDocument();
    expect(
      within(panel).getByRole("switch", { name: "WhatsApp Janitor" }),
    ).not.toBeChecked();
    // Nothing about a paused job is an error.
    expect(within(panel).queryByText(/Failed/)).not.toBeInTheDocument();
    expect(
      within(panel).queryByText("Last run failed"),
    ).not.toBeInTheDocument();
  });

  it("holds the switch at the gateway's answer until the gateway answers", async () => {
    let settle: (value: { ok: boolean }) => void = () => {};
    mocks.setPuppyJobPaused.mockImplementation(
      () =>
        new Promise((resolve) => {
          settle = resolve;
        }),
    );
    const running = job({ id: "auto-dream", name: "Auto-Dream" });
    const panel = await openWithJobs([running]);
    const control = await within(panel).findByRole("switch", {
      name: "Auto-Dream",
    });

    fireEvent.click(control);
    await waitFor(() =>
      expect(mocks.setPuppyJobPaused).toHaveBeenCalledWith({
        id: "auto-dream",
        paused: true,
      }),
    );
    // Still ON, and refusing a second request: nothing has agreed yet.
    expect(control).toBeChecked();
    expect(control).toBeDisabled();
    fireEvent.click(control);
    expect(mocks.setPuppyJobPaused).toHaveBeenCalledTimes(1);

    // The list is re-read rather than guessed at.
    mocks.fetchPuppyJobs.mockResolvedValue({
      configured: true,
      reachable: true,
      jobs: [{ ...running, paused: true }],
    });
    await act(async () => {
      settle({ ok: true });
    });
    await waitFor(() => expect(mocks.fetchPuppyJobs).toHaveBeenCalledTimes(2));
    await waitFor(() =>
      expect(
        screen.getByRole("switch", { name: "Auto-Dream" }),
      ).not.toBeChecked(),
    );
  });

  it("keeps the real state when the machine refuses, and says why", async () => {
    mocks.setPuppyJobPaused.mockResolvedValue({
      ok: false,
      error: "Puppy One is not answering on this machine.",
    });
    const panel = await openWithJobs([
      job({ id: "auto-dream", name: "Auto-Dream" }),
    ]);
    const control = await within(panel).findByRole("switch", {
      name: "Auto-Dream",
    });

    fireEvent.click(control);

    expect(
      await within(panel).findByText(
        "Puppy One is not answering on this machine.",
      ),
    ).toBeInTheDocument();
    // The job never stopped running, so the switch never stopped saying so.
    const after = within(panel).getByRole("switch", { name: "Auto-Dream" });
    expect(after).toBeChecked();
    expect(after).toBeEnabled();
    // A refused change is not a reason to re-read a list that did not change.
    expect(mocks.fetchPuppyJobs).toHaveBeenCalledTimes(1);
  });

  it("says a machine with no key set what to set, rather than showing an empty box", async () => {
    const panel = await openWithJobs({
      configured: false,
      reason: "not_configured",
      message: "Set HERMES_API_SERVER_KEY to see Puppy One's scheduled work.",
      jobs: [],
    });
    expect(
      await within(panel).findByText(
        "Set HERMES_API_SERVER_KEY to see Puppy One's scheduled work.",
      ),
    ).toBeInTheDocument();
  });

  it("says so when the jobs probe did not answer", async () => {
    const panel = await openWithJobs({
      configured: true,
      reachable: false,
      jobs: [],
    });
    expect(
      await within(panel).findByText(
        "Puppy One did not answer about its scheduled work.",
      ),
    ).toBeInTheDocument();
  });

  it("says so when the machine has nothing scheduled", async () => {
    const panel = await openWithJobs([]);
    expect(
      await within(panel).findByText("Nothing is scheduled on this machine."),
    ).toBeInTheDocument();
  });
});
