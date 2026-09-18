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

import {
  orderJobsForReading,
  orderReportedSchedule,
  PuppyMachineSheet,
} from "@/components/agent/puppy-resource-monitor";
import type {
  PuppyJob,
  PuppyJobs,
  PuppyLink,
  PuppyLinkHeartbeat,
  PuppyResources,
} from "@/lib/services/puppy-one-service";

/**
 * The two lists a device reports about itself, seen by someone who is not at
 * the machine.
 *
 * These are LAST REPORTED state. The whole risk this file guards is that a
 * list of jobs, drawn beside the live one, reads as the live one: so every
 * case asserts the lists sit under the "As reported to Hussh One N ago" stamp,
 * and that no switch is offered for a machine the reader cannot reach.
 *
 * The bridge is unreachable throughout, which is its permanent state on a
 * deployed origin and therefore the only state in which these lists are ever
 * the reading a person gets.
 */

const UNREACHABLE: PuppyResources = { configured: true, reachable: false };

const NOW = Date.UTC(2026, 8, 4, 12, 0, 0);
/** Epoch SECONDS, which is the unit both new lists carry on the wire. */
const NOW_S = Math.floor(NOW / 1000);

function link(heartbeat: PuppyLinkHeartbeat | null): PuppyLink {
  return {
    state: "live",
    activeCount: 1,
    checkedAt: NOW,
    device: {
      id: "dev-1",
      name: "Kushal's Mac",
      lastHeartbeatAt: NOW - 4 * 60_000,
      lastSyncedAt: null,
      heartbeat,
    },
  };
}

/** Enough of a machine reading that the reported section exists to hang off. */
const MACHINE: PuppyLinkHeartbeat = {
  current_model: "gemma-4-26b-a4b-qat",
  brand: "Apple",
  processor: "Apple M4 Max",
};

async function mount(heartbeat: PuppyLinkHeartbeat | null) {
  mocks.fetchPuppyResources.mockResolvedValue(UNREACHABLE);
  mocks.link.current = link(heartbeat);
  const view = render(<PuppyMachineSheet />);
  await waitFor(() => expect(mocks.fetchPuppyResources).toHaveBeenCalled());
  return view;
}

async function open() {
  fireEvent.click(await screen.findByRole("button", { name: /this machine/i }));
  return screen.findByRole("dialog");
}

/** The row a piece of text sits in, which is where the state is drawn. */
function rowFor(node: HTMLElement): HTMLElement {
  const row = node.closest("li");
  if (!row) throw new Error("expected the text to be inside a list row");
  return row;
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

describe("PuppyMachineSheet reported scheduled work and conversations", () => {
  it("renders both lists from one reported snapshot", async () => {
    await mount({
      ...MACHINE,
      scheduled: [
        {
          name: "Doctor page",
          when: "*/15 * * * *",
          paused: false,
          next_at: NOW_S + 14 * 60 + 2,
          last: "ok",
        },
        { name: "Weekly digest", when: "0 5 * * 0", paused: true, last: "ok" },
      ],
      conversations: [
        { title: "Pod migration plan", messages: 42, at: NOW_S - 120 },
        { title: "Grocery list", messages: 1, at: NOW_S - 3 * 3600 },
      ],
    });
    const sheet = await open();

    expect(
      within(sheet).getByText("As reported to Hussh One 4 minutes ago"),
    ).toBeInTheDocument();
    expect(within(sheet).getByText("Scheduled work")).toBeInTheDocument();
    expect(within(sheet).getByText("Recent conversations")).toBeInTheDocument();

    // The schedule, in the words a person would use, with the next run.
    expect(within(sheet).getByText("Doctor page")).toBeInTheDocument();
    expect(
      within(sheet).getByText("Every 15 min · next in 14 min · last run ok"),
    ).toBeInTheDocument();
    expect(within(sheet).getByText("Weekly digest")).toBeInTheDocument();
    expect(
      within(sheet).getByText("Sundays at 05:00 · Paused · last run ok"),
    ).toBeInTheDocument();

    expect(within(sheet).getByText("Pod migration plan")).toBeInTheDocument();
    expect(within(sheet).getByText("42 messages")).toBeInTheDocument();
    expect(within(sheet).getByText("2 minutes ago")).toBeInTheDocument();
    expect(within(sheet).getByText("Grocery list")).toBeInTheDocument();
    // Singular, because "1 messages" is the tell that nobody read the copy.
    expect(within(sheet).getByText("1 message")).toBeInTheDocument();
    expect(within(sheet).getByText("3 hours ago")).toBeInTheDocument();
  });

  it("offers no switch for a machine the reader cannot reach", async () => {
    // The live list draws a switch per job. A reported row must not, because
    // there is nothing behind it: the bridge is a container, not the Mac.
    await mount({
      ...MACHINE,
      scheduled: [{ name: "Doctor page", when: "every 15m", paused: false }],
    });
    const sheet = await open();
    expect(within(sheet).getByText("Doctor page")).toBeInTheDocument();
    expect(within(sheet).queryAllByRole("switch")).toHaveLength(0);
  });

  it("keeps both lists under the reported stamp, never under a heading of their own", async () => {
    // The stamp is what stops a reader taking either list for live. If a list
    // ever moves out from under it, this fails.
    await mount({
      ...MACHINE,
      scheduled: [{ name: "Doctor page", when: "every 15m", paused: false }],
      conversations: [{ title: "Pod migration plan", messages: 3, at: NOW_S }],
    });
    const sheet = await open();
    const stamp = within(sheet).getByText(
      "As reported to Hussh One 4 minutes ago",
    );
    const section = stamp.parentElement;
    expect(section).not.toBeNull();
    expect(within(section as HTMLElement).getByText("Doctor page")).toBeInTheDocument();
    expect(
      within(section as HTMLElement).getByText("Pod migration plan"),
    ).toBeInTheDocument();
  });

  it("draws a paused job as deliberately off and a failed one as wrong", async () => {
    await mount({
      ...MACHINE,
      scheduled: [
        { name: "Quiet job", when: "every 15m", paused: true, last: "ok" },
        { name: "Broken job", when: "every 15m", paused: false, last: "error" },
        { name: "Healthy job", when: "every 15m", paused: false, last: "ok" },
      ],
    });
    const sheet = await open();

    const paused = rowFor(within(sheet).getByText("Quiet job"));
    const failed = rowFor(within(sheet).getByText("Broken job"));
    const healthy = rowFor(within(sheet).getByText("Healthy job"));

    // Shape and colour, so the difference survives a greyscale screen.
    expect(paused.className).toContain("border-l-border");
    expect(paused.className).not.toContain("destructive");
    expect(within(paused).getByText(/Paused/)).toBeInTheDocument();
    expect(within(paused).queryByText("Last run failed")).not.toBeInTheDocument();

    expect(failed.className).toContain("app-destructive-border");
    expect(within(failed).getByText("Last run failed")).toBeInTheDocument();

    expect(healthy.className).toContain("border-l-transparent");
    expect(healthy.className).not.toContain("destructive");
    expect(within(healthy).getByText(/last run ok/)).toBeInTheDocument();
  });

  it("keeps both facts on a paused job whose last run failed", async () => {
    await mount({
      ...MACHINE,
      scheduled: [
        { name: "Nightly dream", when: "0 3 * * *", paused: true, last: "error" },
      ],
    });
    const sheet = await open();
    const row = rowFor(within(sheet).getByText("Nightly dream"));
    // Off on purpose, and the last run still went wrong. Neither hides.
    expect(row.className).toContain("border-l-border");
    expect(within(row).getByText(/Paused/)).toBeInTheDocument();
    expect(within(row).getByText("Last run failed")).toBeInTheDocument();
  });

  it("says nothing at all when the device did not report either list", async () => {
    await mount(MACHINE);
    const sheet = await open();
    expect(
      within(sheet).getByText("As reported to Hussh One 4 minutes ago"),
    ).toBeInTheDocument();
    expect(within(sheet).queryByText("Scheduled work")).not.toBeInTheDocument();
    expect(
      within(sheet).queryByText("Recent conversations"),
    ).not.toBeInTheDocument();
    expect(
      within(sheet).queryByText(/when this machine last reported/),
    ).not.toBeInTheDocument();
  });

  it("says so when the device reported having none", async () => {
    // Absent and empty are different facts, and this is the empty one.
    await mount({ ...MACHINE, scheduled: [], conversations: [] });
    const sheet = await open();
    expect(within(sheet).getByText("Scheduled work")).toBeInTheDocument();
    expect(
      within(sheet).getByText(
        "Nothing was scheduled when this machine last reported.",
      ),
    ).toBeInTheDocument();
    expect(within(sheet).getByText("Recent conversations")).toBeInTheDocument();
    expect(
      within(sheet).getByText(
        "No recent conversations when this machine last reported.",
      ),
    ).toBeInTheDocument();
  });

  it("reports one list and stays silent about the other", async () => {
    await mount({ ...MACHINE, conversations: [] });
    const sheet = await open();
    expect(within(sheet).queryByText("Scheduled work")).not.toBeInTheDocument();
    expect(
      within(sheet).getByText(
        "No recent conversations when this machine last reported.",
      ),
    ).toBeInTheDocument();
  });

  it("shows the lists even when the snapshot carried no machine reading", async () => {
    // A heartbeat can be nothing but these two lists. The stamp still has to
    // reach the reader, because that is the whole not-live guarantee.
    await mount({
      scheduled: [{ name: "Doctor page", when: "every 15m", paused: false }],
    });
    const sheet = await open();
    expect(
      within(sheet).getByText("As reported to Hussh One 4 minutes ago"),
    ).toBeInTheDocument();
    expect(within(sheet).getByText("Doctor page")).toBeInTheDocument();
  });

  it("drops a row it cannot build rather than half-filling it", async () => {
    await mount({
      ...MACHINE,
      scheduled: [
        // No name, no schedule, and an unknown on/off state: each is a row
        // that cannot be built from the permitted fields alone.
        { when: "every 15m", paused: false },
        { name: "No schedule", paused: false },
        { name: "Unknown state", when: "every 15m" },
        { name: "Doctor page", when: "every 15m", paused: false },
      ] as unknown as PuppyLinkHeartbeat["scheduled"],
      conversations: [
        { title: "No count", at: NOW_S },
        { messages: 3, at: NOW_S },
        { title: "Pod migration plan", messages: 3, at: NOW_S },
      ] as unknown as PuppyLinkHeartbeat["conversations"],
    });
    const sheet = await open();
    expect(within(sheet).getByText("Doctor page")).toBeInTheDocument();
    expect(within(sheet).queryByText("No schedule")).not.toBeInTheDocument();
    expect(within(sheet).queryByText("Unknown state")).not.toBeInTheDocument();
    expect(within(sheet).getByText("Pod migration plan")).toBeInTheDocument();
    expect(within(sheet).queryByText("No count")).not.toBeInTheDocument();
  });

  it("does not turn an unreadable list into a claim that there is nothing", async () => {
    await mount({
      ...MACHINE,
      scheduled: [
        { name: "Unknown state", when: "every 15m" },
      ] as unknown as PuppyLinkHeartbeat["scheduled"],
    });
    const sheet = await open();
    expect(within(sheet).queryByText("Scheduled work")).not.toBeInTheDocument();
    expect(
      within(sheet).queryByText(
        "Nothing was scheduled when this machine last reported.",
      ),
    ).not.toBeInTheDocument();
  });

  it("drops a next run that was already due when the machine reported", async () => {
    // The snapshot cannot update, so "due now" would be a claim about a
    // machine that may have been asleep since.
    await mount({
      ...MACHINE,
      scheduled: [
        {
          name: "Doctor page",
          when: "every 15m",
          paused: false,
          next_at: NOW_S - 600,
        },
      ],
    });
    const sheet = await open();
    expect(within(sheet).getByText("every 15m")).toBeInTheDocument();
    expect(within(sheet).queryByText(/due now/)).not.toBeInTheDocument();
  });

  it("lets the reported list speak for the next run instead of saying it twice", async () => {
    await mount({
      ...MACHINE,
      next_cron_at: NOW + 14 * 60_000 + 2_000,
      scheduled: [
        {
          name: "Doctor page",
          when: "every 15m",
          paused: false,
          next_at: NOW_S + 14 * 60 + 2,
        },
      ],
    });
    const sheet = await open();
    expect(
      within(sheet).queryByText("Next scheduled run in 14 min"),
    ).not.toBeInTheDocument();
    expect(
      within(sheet).getByText("every 15m · next in 14 min"),
    ).toBeInTheDocument();
  });

  it("keeps the standalone next-run line for a device that reports no list", async () => {
    await mount({ ...MACHINE, next_cron_at: NOW + 14 * 60_000 + 2_000 });
    const sheet = await open();
    expect(
      within(sheet).getByText("Next scheduled run in 14 min"),
    ).toBeInTheDocument();
  });

  it("draws at most ten rows per list, however many arrive", async () => {
    await mount({
      ...MACHINE,
      scheduled: Array.from({ length: 24 }, (_, index) => ({
        name: `Job ${index}`,
        when: "every 15m",
        paused: false,
      })),
      conversations: Array.from({ length: 24 }, (_, index) => ({
        title: `Chat ${index}`,
        messages: index,
        at: NOW_S - index,
      })),
    });
    const sheet = await open();
    // Soonest and newest first, so the kept half is the useful one.
    expect(within(sheet).getByText("Job 0")).toBeInTheDocument();
    expect(within(sheet).getByText("Job 9")).toBeInTheDocument();
    expect(within(sheet).queryByText("Job 10")).not.toBeInTheDocument();
    expect(within(sheet).getByText("Chat 9")).toBeInTheDocument();
    expect(within(sheet).queryByText("Chat 10")).not.toBeInTheDocument();
  });

  it("truncates a long name and a long title instead of widening the panel", async () => {
    const longName = "Reconcile ".repeat(24).trim();
    const longTitle = "Everything about the pod migration ".repeat(12).trim();
    await mount({
      ...MACHINE,
      scheduled: [
        {
          name: longName,
          when: "every 15 minutes on weekdays and hourly at weekends",
          paused: false,
          last: "ok",
        },
      ],
      conversations: [{ title: longTitle, messages: 99999, at: NOW_S - 60 }],
    });
    const sheet = await open();

    const name = within(sheet).getByText(longName);
    expect(name.className).toContain("truncate");
    // The clipping box, without which `truncate` cannot clip inside a flex row.
    expect((name.parentElement as HTMLElement).className).toContain("min-w-0");
    // A schedule too long to translate is printed verbatim, and clipped.
    const detail = within(sheet).getByText(
      /every 15 minutes on weekdays and hourly at weekends/,
    );
    expect(detail.className).toContain("truncate");

    const title = within(sheet).getByText(longTitle);
    expect(title.className).toContain("truncate");
    expect(title.className).toContain("min-w-0");
    // The count and the time never give up their space to the title.
    const row = rowFor(title);
    expect(within(row).getByText("99999 messages").className).toContain(
      "shrink-0",
    );
  });
});

describe("the reported schedule leads with what needs a hand", () => {
  const job = (
    name: string,
    paused: boolean,
    last?: string,
  ): PuppyHeartbeatScheduledJob => ({
    name,
    when: "every day at 09:00",
    paused,
    ...(last ? { last } : {}),
  });

  const names = (rows: ReadonlyArray<PuppyHeartbeatScheduledJob>) =>
    orderReportedSchedule(rows).map((row) => row.name);

  // Names are chosen so alphabetical order is the REVERSE of rank order. A
  // sort that ignored the rank and fell back to the name would pass these by
  // coincidence otherwise, which is how the first draft of this test lied.
  it("puts failing jobs first, then running, then paused", () => {
    expect(
      names([
        job("aaa paused", true),
        job("mmm healthy", false, "ok"),
        job("zzz broken", false, "error"),
      ]),
    ).toEqual(["zzz broken", "mmm healthy", "aaa paused"]);
  });

  it("treats a failed job as failing even when it is switched off", () => {
    // Same precedence as the live ordering: a paused job that failed is still
    // the thing to look at, so it does not sink to the bottom.
    expect(names([job("running", false, "ok"), job("paused broken", true, "error")])).toEqual([
      "paused broken",
      "running",
    ]);
  });

  it("reads 'failed' as a failure, not only 'error'", () => {
    expect(names([job("aaa fine", false, "ok"), job("zzz bad", false, "failed")])).toEqual([
      "zzz bad",
      "aaa fine",
    ]);
  });

  it("orders by name within a rank so a refresh does not reshuffle", () => {
    expect(names([job("zebra", false), job("apple", false), job("mango", false)])).toEqual([
      "apple",
      "mango",
      "zebra",
    ]);
  });

  it("does not mutate the list it was given", () => {
    const rows = [job("zebra", false), job("apple", false)];
    orderReportedSchedule(rows);
    expect(rows.map((row) => row.name)).toEqual(["zebra", "apple"]);
  });

  it("says nothing about a job whose last run the device did not report", () => {
    // No last result is not a failure. It ranks as running, so a machine that
    // reports no statuses at all stays in name order rather than all-failing.
    expect(names([job("b", false), job("a", false)])).toEqual(["a", "b"]);
  });
});

describe("both schedules agree on which job needs a hand", () => {
  // The live list and the reported list come from different sources and carry
  // different evidence, but a person reads them as one answer. These pin the
  // precedence they share, and the "failed" cases are the ones that were
  // actually wrong: `orderJobsForReading` used to test lastStatus === "error"
  // inline while the row it sorts treated "failed" as a failure too, so a
  // failed job wore the red border and still sorted as healthy.
  const live = (
    name: string,
    paused: boolean,
    lastStatus: string | null,
    failureStreak = 0,
  ): PuppyJob => ({
    id: `id-${name}`,
    name,
    schedule: "0 9 * * *",
    paused,
    nextRunAt: null,
    lastStatus,
    lastError: null,
    failureStreak,
  });

  const liveNames = (jobs: ReadonlyArray<PuppyJob>) =>
    orderJobsForReading(jobs).map((job) => job.name);

  it("leads the live list with a job whose last run FAILED, not only one that errored", () => {
    expect(
      liveNames([live("aaa healthy", false, "ok"), live("zzz failed", false, "failed")]),
    ).toEqual(["zzz failed", "aaa healthy"]);
  });

  it("still leads the live list with an errored job", () => {
    expect(
      liveNames([live("aaa healthy", false, "ok"), live("zzz errored", false, "error")]),
    ).toEqual(["zzz errored", "aaa healthy"]);
  });

  it("leads the live list with a failure streak even when the last run reported fine", () => {
    // The streak is evidence only the live job carries, which is why the two
    // views can legitimately differ on this one row.
    expect(
      liveNames([live("aaa healthy", false, "ok"), live("zzz streak", false, "ok", 3)]),
    ).toEqual(["zzz streak", "aaa healthy"]);
  });

  it("ranks a failing job above a paused one in BOTH lists", () => {
    expect(liveNames([live("aaa paused", true, "ok"), live("zzz failed", false, "failed")])).toEqual(
      ["zzz failed", "aaa paused"],
    );
    expect(
      orderReportedSchedule([
        { name: "aaa paused", when: "daily", paused: true },
        { name: "zzz failed", when: "daily", paused: false, last: "failed" },
      ]).map((row) => row.name),
    ).toEqual(["zzz failed", "aaa paused"]);
  });

  it("sinks a paused job in BOTH lists", () => {
    expect(liveNames([live("aaa paused", true, "ok"), live("zzz running", false, "ok")])).toEqual([
      "zzz running",
      "aaa paused",
    ]);
    expect(
      orderReportedSchedule([
        { name: "aaa paused", when: "daily", paused: true },
        { name: "zzz running", when: "daily", paused: false, last: "ok" },
      ]).map((row) => row.name),
    ).toEqual(["zzz running", "aaa paused"]);
  });
});
