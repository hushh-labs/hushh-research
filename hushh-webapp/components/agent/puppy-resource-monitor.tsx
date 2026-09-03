"use client";

import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { AlertTriangle, Cloud, Cpu, Loader2 } from "lucide-react";

import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet";
import { Switch } from "@/components/ui/switch";
import { formatRelativeTime } from "@/lib/format/relative-time";
import { usePuppyLink } from "@/lib/hermes/use-puppy-link";
import {
  fetchPuppyJobs,
  fetchPuppyResources,
  setPuppyJobPaused,
  type PuppyJob,
  type PuppyJobs,
  type PuppyLink,
  type PuppyResidentModel,
  type PuppyResourceLink,
  type PuppyResources,
} from "@/lib/services/puppy-one-service";
import { cn } from "@/lib/utils";

/**
 * The machine Puppy One runs on, read live -- ON DEMAND.
 *
 * The readings are the owner's to ask for, not a permanent fixture above the
 * conversation: `PuppyMachineSheet` is a quiet control that opens them in a
 * panel, and nothing repeats while that panel is shut.
 *
 * The panel follows the viewport rather than the phone. Under 640px it is the
 * app's bottom sheet, where a thumb already is. At 640px and up it is the
 * centred dialog, because a bottom sheet on a desktop slides a strip across
 * the foot of a large window to show a small amount of text -- see
 * `PuppyMachineSheet` for why a dialog and not an anchored popover.
 *
 * ONE reading refuses to wait for a tap. A broken link to Hussh One stays
 * inline, always, above the control. Enrolment outlives login, so a machine
 * whose session died stays trusted and keeps answering locally while One has
 * not seen it for weeks -- and every OTHER reading still says "healthy" while
 * that is true. It is not a statistic; it is the only place the owner learns
 * the machine is signed out. Hiding it behind a tap would hide it from the one
 * person who has no reason to tap.
 *
 * The statistics behind the control answer four questions, in the order an
 * owner asks them:
 *
 *   1. Is this answer generated here? The whole product claim. It is NOT one
 *      bit: a local provider with the on-device gate off still sends auxiliary
 *      work (compression, summarisation) to a vendor, so that state is worded
 *      as its own thing rather than collapsed into "on-device".
 *   2. Is there room for another model?
 *   3. Will this machine survive tonight -- memory, disk, power.
 *   4. Is the scheduled work landing?
 *
 * Everything here renders ONLY what the payload contains. The gateway omits a
 * section whose probe could not answer, and an omission means "not readable",
 * never zero. A desktop reports {present: false} for its battery with no
 * percent, and rendering that as 0% would be a lie about a machine that cannot
 * run out of power.
 *
 * The loopback key never reaches this component: it reads our own origin
 * through the service layer, and a Next route handler on this machine holds
 * the key.
 */

/**
 * Slow enough to be free, fast enough that a model load shows up WHILE THE
 * OWNER IS LOOKING. It never runs against a shut sheet: a repeating request to
 * the local gateway that nobody can see is work the machine did for nothing.
 */
const POLL_MS = 20_000;

/**
 * How often the link is re-checked with nothing open.
 *
 * The statistics are opt-in; being signed out of Hussh One is not, and the
 * banner is the only place the owner would learn it while every local surface
 * still reads healthy. Five minutes is slow enough to cost nothing and far
 * short of never, which is what checking only on mount means for a page that
 * stays open.
 */
const LINK_POLL_MS = 300_000;

/**
 * Under this width the panel is a bottom sheet; at it and above, a dialog.
 *
 * 639.98px rather than 640px so the sheet and `sm:` hand over at exactly the
 * same place: a device landing on 639.6px must not get the sheet's geometry
 * and the dialog's breakpoint at once. Exported so a test can answer this one
 * query without having to guess the number.
 */
export const MACHINE_PANEL_SHEET_QUERY = "(max-width: 639.98px)";

/** Disk this full is the thing that stops an overnight job. */
const DISK_WARNING_PCT = 90;

/** Below this and discharging, the machine may not see the morning. */
const BATTERY_WARNING_PCT = 20;

type Tone = "success" | "warning" | "danger";

const TONE_CHIP: Record<Tone, string> = {
  success:
    "bg-[color:var(--app-success-tint)] text-[color:var(--app-success-deep)] dark:text-[color:var(--app-success-bright)]",
  warning:
    "bg-[color:var(--app-warning-tint)] text-[color:var(--app-warning-deep)] dark:text-[color:var(--app-warning-bright)]",
  danger:
    "bg-[color:var(--app-destructive-tint)] text-[color:var(--app-destructive-deep)] dark:text-[color:var(--app-destructive-bright)]",
};

/**
 * One reading of the machine, and the policy for when to take another.
 *
 * `live` is the sheet being open. Shut, this takes exactly one reading, on
 * mount, because the link banner has to be able to announce a dead session
 * without the owner opening anything and the gateway offers no cheaper
 * question than the whole reading. Open, it keeps that reading current.
 *
 * Two links are read, from two authorities. The bridge's `payload.link` is the
 * device's own view of its session with One, readable only on the machine the
 * page is served from. `link` is One's own view of the device, readable from
 * anywhere. On a deployed origin the bridge is a container and never the
 * owner's Mac, so the second is the only one a deployed viewer ever has.
 */
function useMachineReading(live: boolean): {
  payload: PuppyResources | null;
  readAt: number;
  link: PuppyLink | null;
} {
  const [payload, setPayload] = useState<PuppyResources | null>(null);
  // One's record of the device, from the store every Puppy surface shares:
  // one poll for the page, and one moment of change for every reader of it.
  const link = usePuppyLink();
  // Epoch ms of the last successful read, used only when the gateway did not
  // stamp the payload. Preferring the gateway's own clock keeps "in 14 min"
  // free of skew between this browser and the machine.
  const [readAt, setReadAt] = useState(0);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const read = useCallback(async () => {
    const next = await fetchPuppyResources();
    // An in-flight read outlives the component it was started for. Dropping it
    // on the floor is the point: `fetchPuppyResources` never rejects, so this
    // is the only guard there is.
    if (!mounted.current) return;
    setPayload(next);
    setReadAt(Date.now());
  }, []);

  // The link check runs whether or not anything is open, and keeps running.
  //
  // The statistics are opt-in; being signed out of Hussh One is not. A session
  // can expire while the owner is sitting on this page, and the banner is the
  // only place they would learn it, because everything else on the machine
  // still looks healthy. Checking once per mount would mean noticing on the
  // next reload, which for a page left open is never.
  //
  // Slow on purpose: a link state does not change on a 20-second timescale, so
  // this is one request every five minutes rather than the fifteen per minute
  // the always-on monitor used to make.
  useEffect(() => {
    void read();
    const timer = setInterval(() => void read(), LINK_POLL_MS);
    return () => clearInterval(timer);
  }, [read]);

  // Polling is what opening the sheet buys, and it stops when it closes.
  useEffect(() => {
    if (!live) return;
    void read();
    const timer = setInterval(() => void read(), POLL_MS);
    return () => clearInterval(timer);
  }, [live, read]);

  return { payload, readAt, link };
}

/**
 * The scheduled jobs, and the switch that turns one off.
 *
 * Read ONLY when the panel is open, and never on a timer. Unlike the readings
 * there is no fact in here that has to reach the owner unasked, so a shut
 * panel costs the local gateway nothing at all.
 *
 * A toggle is single-flight PER JOB and the switch never moves on its own
 * authority: the row keeps rendering the gateway's `paused` until a re-read
 * says otherwise. That is the difference between a switch and a wish. A
 * refusal leaves the job exactly where it was and says so on the row.
 */
function usePuppyScheduledWork(live: boolean): {
  payload: PuppyJobs | null;
  busyIds: ReadonlySet<string>;
  errors: Readonly<Record<string, string>>;
  onToggle: (job: PuppyJob) => void;
} {
  const [payload, setPayload] = useState<PuppyJobs | null>(null);
  const [busyIds, setBusyIds] = useState<ReadonlySet<string>>(
    () => new Set<string>(),
  );
  const [errors, setErrors] = useState<Record<string, string>>({});
  const mounted = useRef(true);
  // The render-visible set lags a microtask behind; the guard cannot. Two taps
  // in the same tick would both read the old state and both fire.
  const inFlight = useRef<Set<string>>(new Set());

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const read = useCallback(async () => {
    const next = await fetchPuppyJobs();
    if (!mounted.current) return;
    setPayload(next);
  }, []);

  // Opening is the whole trigger. No interval: a schedule does not change
  // while someone is looking at it, and the readings' own 20s poll already
  // re-renders this list often enough for "in 14 min" to stay honest.
  useEffect(() => {
    if (!live) return;
    void read();
  }, [live, read]);

  const onToggle = useCallback(
    (job: PuppyJob) => {
      if (inFlight.current.has(job.id)) return;
      inFlight.current = new Set(inFlight.current).add(job.id);
      setBusyIds(inFlight.current);
      setErrors((current) => {
        if (!(job.id in current)) return current;
        const next = { ...current };
        delete next[job.id];
        return next;
      });

      void (async () => {
        const result = await setPuppyJobPaused({
          id: job.id,
          paused: !job.paused,
        });
        if (mounted.current) {
          if (result.ok) {
            // Re-read rather than trusting the local guess. The gateway may
            // have done something other than what was asked -- a job that was
            // deleted underneath us, a resume that a broken schedule refused
            // -- and the list is the only place that knows.
            await read();
          } else {
            setErrors((current) => ({
              ...current,
              [job.id]:
                result.error || "Puppy One could not change that job.",
            }));
          }
        }
        const remaining = new Set(inFlight.current);
        remaining.delete(job.id);
        inFlight.current = remaining;
        if (!mounted.current) return;
        setBusyIds(remaining);
      })();
    },
    [read],
  );

  return { payload, busyIds, errors, onToggle };
}

function panelPresentationSupported(): boolean {
  return (
    typeof window !== "undefined" && typeof window.matchMedia === "function"
  );
}

function subscribeToPanelPresentation(onChange: () => void): () => void {
  if (!panelPresentationSupported()) return () => {};
  const query = window.matchMedia(MACHINE_PANEL_SHEET_QUERY);
  query.addEventListener("change", onChange);
  return () => query.removeEventListener("change", onChange);
}

/**
 * True when this viewport wants the bottom sheet.
 *
 * A subscription rather than a one-shot read, so a window dragged across the
 * boundary is answered instead of being remembered wrongly until the next
 * reload. The server snapshot is `false`, the desktop answer, which costs
 * nothing: neither container mounts its content until the owner asks.
 */
function useSheetPresentation(): boolean {
  return useSyncExternalStore(
    subscribeToPanelPresentation,
    () =>
      panelPresentationSupported() &&
      window.matchMedia(MACHINE_PANEL_SHEET_QUERY).matches,
    () => false,
  );
}

const PANEL_TITLE = "This machine";
const PANEL_DESCRIPTION =
  "What Puppy One is running on, and the work it has scheduled.";

/**
 * The owner's way in: one quiet control, plus the one reading that refuses to
 * hide behind it.
 *
 * The control names what it opens rather than what it is made of. "This
 * machine" is the thing the owner is asking about; "Metrics" or "Debug" would
 * be this code describing itself.
 *
 * A bottom sheet is the phone's answer, not the desktop's, so the container
 * follows the viewport:
 *
 *   under 640px  the app's bottom sheet, dragged and dismissed like every
 *                other sheet here, and where the thumb already is.
 *   640px and up the centred dialog, which is what this repo already reaches
 *                for when the same surface has to be both -- see
 *                `save-location-modal.tsx`. Not an anchored popover: this
 *                panel is a readings card plus a switchable list of eleven
 *                jobs, which is a task and not a menu, and the popover
 *                primitive here is 288px wide with no title, no close
 *                affordance and no focus trap to lend it.
 *
 * ONE panel is built, and exactly one container mounts it. Two mounted copies
 * would be two lists of switches over one machine, and the toggle in the
 * hidden one would still be reachable by a screen reader.
 *
 * The presentation is frozen for the lifetime of an opening. Swapping Sheet
 * for Dialog swaps the parent element, so React remounts everything inside --
 * which mid-toggle would tear down the switch under the hand using it, and
 * lose the row's error with it.
 */
export function PuppyMachineSheet({ className }: { className?: string }) {
  const [open, setOpen] = useState(false);
  const { payload, readAt, link } = useMachineReading(open);
  const scheduled = usePuppyScheduledWork(open);
  // This strip speaks for the DEVICE's own account of its session, which
  // knows things One cannot (an expired token on a still-trusted machine).
  // One's record of the device is the chat panel's to explain, directly under
  // this strip, with the way out; saying it here too put the same sentence
  // and the same install link on one screen twice. One fact, one place.
  const linkState = describeLink(payload?.link);
  // "ok" resolves to `healthy` and "not_connected" to null, so what is left is
  // exactly the set the owner cannot be left to discover by tapping.
  const notice = linkState && linkState.kind !== "healthy" ? linkState : null;

  // Re-synced only while the panel is shut, so it always OPENS in the right
  // container and then stops following. Nothing is on screen to flash while
  // it catches up: neither container mounts its content until the owner asks.
  const livePresentation = useSheetPresentation();
  const [asSheet, setAsSheet] = useState(livePresentation);
  useEffect(() => {
    if (!open) setAsSheet(livePresentation);
  }, [livePresentation, open]);

  const trigger = (
    <button
      type="button"
      className="inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-medium text-muted-foreground transition-colors hover:bg-foreground/[0.045] hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      <Cpu className="size-3.5" aria-hidden />
      {PANEL_TITLE}
    </button>
  );

  // The container is already the boundary. A second bordered card inside it
  // would be a box drawn around a box.
  const panel = (
    <PuppyResourceMonitor
      payload={payload}
      readAt={readAt}
      link={link}
      className="rounded-none border-0"
      scheduled={
        <PuppyJobList
          payload={scheduled.payload}
          busyIds={scheduled.busyIds}
          errors={scheduled.errors}
          onToggle={scheduled.onToggle}
        />
      }
    />
  );

  return (
    <div className={cn("flex flex-col gap-2", className)}>
      {notice ? <LinkNotice state={notice} /> : null}
      <div className="flex justify-end">
        {asSheet ? (
          <Sheet open={open} onOpenChange={setOpen} modal>
            <SheetTrigger asChild>{trigger}</SheetTrigger>
            <SheetContent
              side="bottom"
              // The primitive scrolls as a whole; here the HEADER stays put and
              // only the body scrolls, so a machine with forty scheduled jobs
              // still shows its title, and the list scrolls inside the sheet
              // rather than pushing the viewport (founder, 2026-09-03).
              className="flex flex-col gap-0 overflow-hidden p-0"
            >
              <SheetHeader className="shrink-0 px-4 pb-2 pr-12 pt-3 text-left">
                <SheetTitle className="text-base">{PANEL_TITLE}</SheetTitle>
                <SheetDescription>{PANEL_DESCRIPTION}</SheetDescription>
              </SheetHeader>
              {/* No padding of its own: every section inside already carries
                  `px-4`, which is the header's gutter too. */}
              <div
                className="min-h-0 flex-1 overflow-y-auto overscroll-contain pb-[calc(1rem+env(safe-area-inset-bottom,0px))]"
                data-testid="puppy-machine-body"
              >
                {panel}
              </div>
            </SheetContent>
          </Sheet>
        ) : (
          <Dialog open={open} onOpenChange={setOpen} modal>
            <DialogTrigger asChild>{trigger}</DialogTrigger>
            <DialogContent
              // Same pinned-header shape as the sheet: the primitive's own
              // overflow is turned off so the title and close control never
              // scroll away, and the body below is the one scroll region.
              className="gap-0 overflow-hidden p-0 sm:max-w-md"
              // `DialogContent` already renders the one accessible
              // description this dialog is allowed to have; a second
              // `DialogDescription` would collide with it on the same id. So
              // the line below is the SAME sentence, drawn for the eye only,
              // and hidden from the reader that has already been told it.
              srDescription={PANEL_DESCRIPTION}
            >
              <DialogHeader className="shrink-0 px-4 pb-2 pr-12 pt-3 text-left">
                <DialogTitle className="text-base">{PANEL_TITLE}</DialogTitle>
                <p className="text-sm text-muted-foreground" aria-hidden>
                  {PANEL_DESCRIPTION}
                </p>
              </DialogHeader>
              <div
                className="min-h-0 flex-1 overflow-y-auto overscroll-contain pb-4"
                data-testid="puppy-machine-body"
              >
                {panel}
              </div>
            </DialogContent>
          </Dialog>
        )}
      </div>
    </div>
  );
}

/**
 * The link to Hussh One, said out loud on the page itself.
 *
 * Rendered HERE and nowhere else. The sheet does not repeat it: one fact in
 * two places at once is how a reader learns to stop reading either.
 */
function LinkNotice({
  state,
}: {
  state: Extract<LinkState, { kind: "alert" } | { kind: "quiet" }>;
}) {
  if (state.kind === "quiet") {
    return (
      <p className="text-[11px] text-muted-foreground">
        {state.message}
        {state.action ? (
          <>
            {" · "}
            <a
              href={state.action.href}
              target="_blank"
              rel="noopener noreferrer"
              className="underline underline-offset-2 hover:text-foreground"
            >
              {state.action.label}
            </a>
          </>
        ) : null}
      </p>
    );
  }
  return (
    <div
      role="status"
      className={cn(
        "rounded-lg border-l-2 px-3 py-2",
        state.tone === "danger"
          ? "border-l-[color:var(--app-destructive-border)] bg-[color:var(--app-destructive-tint)]"
          : "border-l-[color:var(--app-warning-border)] bg-[color:var(--app-warning-tint)]",
      )}
    >
      <p
        className={cn(
          "flex items-start gap-2 text-xs font-medium",
          state.tone === "danger"
            ? "text-[color:var(--app-destructive-deep)] dark:text-[color:var(--app-destructive-bright)]"
            : "text-[color:var(--app-warning-deep)] dark:text-[color:var(--app-warning-bright)]",
        )}
      >
        <AlertTriangle className="mt-px size-3.5 shrink-0" aria-hidden />
        <span>{state.message}</span>
      </p>
      {state.remedy ? (
        // Verbatim from the payload. The device owns the fix; a command
        // written here would go stale the moment the CLI renames it.
        <p className="mt-1.5 pl-[1.375rem]">
          <code className="rounded bg-foreground/[0.06] px-1.5 py-0.5 font-mono text-[11px] text-foreground">
            {state.remedy}
          </code>
        </p>
      ) : null}
    </div>
  );
}

/**
 * The statistics themselves, given a reading. Presentational on purpose: one
 * owner takes the reading (`useMachineReading`), so opening this in a second
 * place cannot double the requests against the local gateway.
 */
export function PuppyResourceMonitor({
  payload,
  readAt = 0,
  link = null,
  className,
  scheduled,
}: {
  payload: PuppyResources | null;
  /** Epoch ms of that read. 0 means "not stamped": no relative time is shown. */
  readAt?: number;
  /**
   * One's record of the owner's device. Rendered ONLY when the bridge has
   * nothing to say: a live reading from the machine itself is always the
   * better one, and showing both would be two readings of one machine.
   */
  link?: PuppyLink | null;
  className?: string;
  /**
   * The job list, rendered under the "Scheduled work" summary.
   *
   * A slot rather than a fetch, so this component stays presentational: who
   * reads the jobs, and when, is the panel owner's contract -- the same rule
   * that keeps the machine reading out of here.
   */
  scheduled?: ReactNode;
}) {
  // The readings and the scheduled work are SEPARATE probes, so a state that
  // stops one must not silently remove the other. These early returns used to
  // drop the `scheduled` slot with them, which meant the switches disappeared
  // in exactly the states an owner is most likely to be looking for them: while
  // the readings are still loading, or when the readings call failed. The jobs
  // section carries its own calm states and can speak for itself.
  //
  // The two that KNOW the bridge has nothing also carry what One last heard
  // from the machine: on a deployed origin the bridge is a container, so
  // "not answering" is the permanent state there and the heartbeat is the
  // only reading a person will ever get. The loading branch does not: until
  // the bridge answers, showing One's reading would be a second account of
  // the machine that a live bridge is about to replace.
  if (!payload) {
    return (
      <Shell className={className}>
        <p className="flex items-center gap-2 px-4 py-3 text-xs text-muted-foreground">
          <Loader2 className="size-3.5 animate-spin" aria-hidden />
          Reading this machine…
        </p>
        {scheduled}
      </Shell>
    );
  }

  if (payload.configured === false) {
    return (
      <Shell className={className}>
        <p className="px-4 py-3 text-xs text-muted-foreground">
          {payload.message ||
            "Set HERMES_API_SERVER_KEY to read the machine Puppy One runs on."}
        </p>
        <ReportedReading link={link} />
        {scheduled}
      </Shell>
    );
  }

  if (payload.reachable === false) {
    return (
      <Shell className={className}>
        <p className="px-4 py-3 text-xs text-muted-foreground">
          Puppy One is not answering on this machine.
        </p>
        <ReportedReading link={link} />
        {scheduled}
      </Shell>
    );
  }

  const { agent, machine, models, jobs } = payload;
  const linkState = describeLink(payload.link);
  const origin = describeOrigin(agent?.on_device, agent?.on_device_gate);
  const OriginIcon = origin?.icon ?? Cpu;

  const residentGb = finiteNumber(models?.resident_gb);
  const availableGb = finiteNumber(models?.available_gb);
  const modelBudgetGb =
    residentGb !== null && availableGb !== null ? residentGb + availableGb : null;
  const resident = Array.isArray(models?.resident) ? models.resident : [];
  const ramTotalGb = finiteNumber(machine?.ram_total_gb);

  const ramUsedPct = finiteNumber(machine?.ram_used_pct);
  const ramAvailableGb = finiteNumber(machine?.ram_available_gb);
  const diskFreeGb = finiteNumber(machine?.disk_free_gb);
  const diskUsedPct = finiteNumber(machine?.disk_used_pct);
  const battery = machine?.battery;
  const batteryPct = finiteNumber(battery?.percent);
  const batteryDischarging =
    battery?.present === true && !battery.charging && !battery.on_ac;

  const clockBase = finiteNumber(payload.generated_at) ?? readAt;
  const nextJobAt = nonEmpty(jobs?.next?.at);
  const nextJobName = nonEmpty(jobs?.next?.name);
  const nextJobIn = nextJobAt ? relativeTime(clockBase, nextJobAt) : null;
  const jobsEnabled = finiteNumber(jobs?.enabled);
  const jobsDisabled = finiteNumber(jobs?.disabled);
  const completed = finiteNumber(jobs?.last_24h?.completed);
  const failed = finiteNumber(jobs?.last_24h?.failed);

  const hasHeadroom =
    ramUsedPct !== null ||
    diskFreeGb !== null ||
    diskUsedPct !== null ||
    battery !== undefined;
  const hasJobsSummary =
    jobsEnabled !== null ||
    nextJobName !== null ||
    completed !== null ||
    failed !== null;
  // The section also earns its place when the readings said nothing about
  // jobs but the list has something to say -- including "nothing is
  // scheduled", which is an answer and not an empty box.
  const hasJobs = hasJobsSummary || Boolean(scheduled);
  // Only the healthy footnote lives in here; a broken link is said inline by
  // `LinkNotice`, outside this sheet. A healthy link with nothing to name it by
  // renders no line either, so a payload carrying only that would otherwise
  // leave an empty bordered box on screen.
  const healthyLinkLine =
    linkState?.kind === "healthy" ? linkState.message : null;
  const nothingReadable =
    !healthyLinkLine && !agent && !models && !hasHeadroom && !hasJobs;

  if (nothingReadable) {
    return (
      <Shell className={className}>
        <p className="px-4 py-3 text-xs text-muted-foreground">
          This machine did not report anything readable.
        </p>
      </Shell>
    );
  }

  return (
    <Shell className={className}>
      {/* 1. Is the answer generated here? */}
      {agent ? (
        <div className="flex items-start gap-3 px-4 py-3">
          <OriginIcon
            className="mt-0.5 size-4 shrink-0 text-muted-foreground"
            aria-hidden
          />
          <div className="min-w-0 flex-1">
            {nonEmpty(agent.model) ? (
              <p className="truncate text-sm font-medium">{agent.model}</p>
            ) : null}
            {origin ? (
              <span
                className={cn(
                  "mt-1 inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[11px] font-medium",
                  TONE_CHIP[origin.tone],
                )}
              >
                <span className="size-1.5 rounded-full bg-current" />
                {origin.label}
              </span>
            ) : null}
          </div>
          {nonEmpty(agent.version) ? (
            <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground">
              {agent.version}
            </span>
          ) : null}
        </div>
      ) : null}

      {/* 2. Room for another model. */}
      {models ? (
        <Section label="Model memory">
          {residentGb !== null || availableGb !== null ? (
            <p className="text-xs tabular-nums">
              {residentGb !== null ? (
                <span className="font-medium">{formatGb(residentGb)} held</span>
              ) : null}
              {residentGb !== null && availableGb !== null ? (
                <span className="text-muted-foreground"> · </span>
              ) : null}
              {availableGb !== null ? (
                <span className="text-muted-foreground">
                  {formatGb(availableGb)} free for another model
                </span>
              ) : null}
            </p>
          ) : null}

          {residentGb !== null && modelBudgetGb !== null && modelBudgetGb > 0 ? (
            <div
              className="mt-2 h-1 w-full overflow-hidden rounded-full bg-foreground/[0.08]"
              aria-hidden
            >
              <div
                className="h-full rounded-full bg-foreground/30"
                style={{
                  width: `${Math.min(100, (residentGb / modelBudgetGb) * 100)}%`,
                }}
              />
            </div>
          ) : null}

          {resident.length > 0 ? (
            <ul className="mt-2 flex flex-col gap-1">
              {resident.map((model, index) => (
                <ResidentRow key={nonEmpty(model?.id) ?? index} model={model} />
              ))}
            </ul>
          ) : null}

          {ramTotalGb !== null ? (
            <p className="mt-2 text-[11px] tabular-nums text-muted-foreground">
              {formatGb(ramTotalGb)} RAM on this machine
            </p>
          ) : null}
        </Section>
      ) : null}

      {/* 3. Will it survive tonight? */}
      {hasHeadroom ? (
        <Section label="Headroom">
          <div className="grid gap-2 sm:grid-cols-3">
            {ramUsedPct !== null ? (
              <Tile
                label="Memory"
                value={`${formatPct(ramUsedPct)} used`}
                detail={
                  ramAvailableGb !== null
                    ? `${formatGb(ramAvailableGb)} free`
                    : undefined
                }
              />
            ) : null}

            {diskFreeGb !== null || diskUsedPct !== null ? (
              <Tile
                label="Disk"
                value={
                  diskFreeGb !== null ? `${formatGb(diskFreeGb)} free` : "—"
                }
                detail={
                  diskUsedPct !== null
                    ? `${formatPct(diskUsedPct)} used`
                    : undefined
                }
                warning={
                  diskUsedPct !== null && diskUsedPct >= DISK_WARNING_PCT
                    ? "Nearly full"
                    : undefined
                }
              />
            ) : null}

            {battery ? (
              battery.present === false ? (
                // A desktop has no battery. That is not 0%, and showing 0%
                // would read as a machine about to die.
                <Tile label="Power" value="No battery" detail="Mains powered" />
              ) : (
                <Tile
                  label="Battery"
                  value={batteryPct !== null ? formatPct(batteryPct) : "—"}
                  detail={describePower(battery.charging, battery.on_ac)}
                  warning={
                    batteryPct !== null &&
                    batteryPct < BATTERY_WARNING_PCT &&
                    batteryDischarging
                      ? "Running down"
                      : undefined
                  }
                />
              )
            ) : null}
          </div>
        </Section>
      ) : null}

      {/* 4. Is the work landing? */}
      {hasJobs ? (
        <Section label="Scheduled work">
          {/* The headline over the list: the counts, the soonest job, and the
              only fact the list itself cannot carry -- how the last day of
              runs actually went. */}
          {hasJobsSummary ? (
            <div className="flex flex-col gap-1 text-xs">
              {jobsEnabled !== null ? (
                <p className="tabular-nums">
                  <span className="font-medium">{jobsEnabled} scheduled</span>
                  {jobsDisabled !== null && jobsDisabled > 0 ? (
                    <span className="text-muted-foreground">
                      {" "}
                      · {jobsDisabled} off
                    </span>
                  ) : null}
                </p>
              ) : null}
              {nextJobName ? (
                <p className="truncate text-muted-foreground">
                  Next: {nextJobName}
                  {nextJobIn ? (
                    <span className="tabular-nums"> {nextJobIn}</span>
                  ) : null}
                </p>
              ) : null}
              {completed !== null || failed !== null ? (
                <p className="tabular-nums text-muted-foreground">
                  Last 24h:
                  {completed !== null ? ` ${completed} completed` : ""}
                  {completed !== null && failed !== null ? " ·" : ""}
                  {failed !== null ? (
                    <span
                      className={cn(
                        failed > 0 &&
                          "text-[color:var(--app-destructive-deep)] dark:text-[color:var(--app-destructive-bright)]",
                      )}
                    >
                      {" "}
                      {failed} failed
                    </span>
                  ) : null}
                </p>
              ) : null}
            </div>
          ) : null}
          {scheduled ? (
            <div
              className={cn(
                hasJobsSummary && "mt-2.5 border-t border-border/60 pt-2.5",
              )}
            >
              {scheduled}
            </div>
          ) : null}
        </Section>
      ) : null}

      {/* A healthy link needs no card and no banner. It is a footnote, and it
          earns a line only when the payload actually named the account or
          environment. Nothing is wrong, so it waits to be asked for. */}
      {healthyLinkLine ? (
        <p className="truncate px-4 py-2 text-[11px] text-muted-foreground">
          {healthyLinkLine}
        </p>
      ) : null}
    </Shell>
  );
}

/**
 * The machine as it last described itself to Hussh One.
 *
 * Only what the heartbeat carried, in the rows the live reading already uses:
 * the model line, the memory and battery tiles, the next scheduled run. A
 * field the device did not send renders as nothing. A desktop sends no
 * battery, and that is not 0%.
 */
function ReportedReading({ link }: { link: PuppyLink | null }) {
  const device = link?.device ?? null;
  const snapshot = device?.heartbeat ?? null;
  if (!device || !snapshot) return null;

  const model = nonEmpty(snapshot.current_model);
  const version = nonEmpty(snapshot.agent_version);
  const activeSessions = finiteNumber(snapshot.active_sessions);
  const brand = nonEmpty(snapshot.brand);
  const processor = nonEmpty(snapshot.processor);
  const ramTotalGb = finiteNumber(snapshot.ram_total_gb);
  const ramUsedPct = finiteNumber(snapshot.ram_used_pct);
  const batteryPct = finiteNumber(snapshot.battery_pct);
  const batteryDischarging =
    snapshot.battery_charging === false && snapshot.on_ac === false;
  // A run that was due before this read is history the snapshot cannot
  // update, so it is dropped rather than shown as "due now" on a machine that
  // may have been asleep for a day.
  const checkedAt = link?.checkedAt ?? 0;
  const nextCronAt = finiteNumber(snapshot.next_cron_at);
  // Bounded above as well: the backend stores any non-negative integer, and
  // `new Date(n).toISOString()` throws past 8.64e15, which with no boundary
  // between this sheet and the page would replace the page with the error
  // screen for every viewer of that account. No device sends this field
  // today; the row exists for the one that will.
  const nextRun =
    nextCronAt !== null && nextCronAt > checkedAt && nextCronAt <= 8.64e15
      ? relativeTime(checkedAt, new Date(nextCronAt).toISOString())
      : null;

  const hasMachine =
    brand !== null || processor !== null || ramTotalGb !== null;
  const hasTiles = ramUsedPct !== null || batteryPct !== null;
  if (!model && !hasMachine && !hasTiles && !nextRun) return null;

  const activity: string[] = [];
  if (snapshot.busy === true) activity.push("busy");
  if (activeSessions !== null) {
    activity.push(
      `${activeSessions} active ${activeSessions === 1 ? "session" : "sessions"}`,
    );
  }
  const seen =
    device.lastHeartbeatAt !== null
      ? formatRelativeTime(device.lastHeartbeatAt, link?.checkedAt)
      : "";

  return (
    <Section label={seen ? `As reported to Hussh One ${seen}` : "As reported to Hussh One"}>
      {model || activity.length > 0 ? (
        <div className="flex items-start gap-3">
          <Cpu
            className="mt-0.5 size-4 shrink-0 text-muted-foreground"
            aria-hidden
          />
          <div className="min-w-0 flex-1">
            {model ? (
              <p className="truncate text-sm font-medium">{model}</p>
            ) : null}
            {activity.length > 0 ? (
              <p className="text-[11px] tabular-nums text-muted-foreground">
                {activity.join(" · ")}
              </p>
            ) : null}
          </div>
          {version ? (
            <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground">
              {version}
            </span>
          ) : null}
        </div>
      ) : null}

      {brand || processor ? (
        <p
          className={cn(
            "truncate text-xs text-muted-foreground",
            (model || activity.length > 0) && "mt-2",
          )}
        >
          {[brand, processor].filter(Boolean).join(" · ")}
        </p>
      ) : null}

      {hasTiles ? (
        <div className="mt-2 grid gap-2 sm:grid-cols-3">
          {ramUsedPct !== null ? (
            <Tile
              label="Memory"
              value={`${formatPct(ramUsedPct)} used`}
              detail={
                ramTotalGb !== null ? `of ${formatGb(ramTotalGb)}` : undefined
              }
            />
          ) : null}
          {batteryPct !== null ? (
            <Tile
              label="Battery"
              value={formatPct(batteryPct)}
              detail={describePower(snapshot.battery_charging, snapshot.on_ac)}
              warning={
                batteryPct < BATTERY_WARNING_PCT && batteryDischarging
                  ? "Running down"
                  : undefined
              }
            />
          ) : null}
        </div>
      ) : null}

      {ramTotalGb !== null && ramUsedPct === null ? (
        <p className="mt-2 text-[11px] tabular-nums text-muted-foreground">
          {formatGb(ramTotalGb)} RAM on this machine
        </p>
      ) : null}

      {nextRun ? (
        <p className="mt-2 text-xs tabular-nums text-muted-foreground">
          Next scheduled run {nextRun}
        </p>
      ) : null}
    </Section>
  );
}

function Shell({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <section
      aria-label="Puppy One machine"
      className={cn(
        "divide-y divide-border/60 overflow-hidden rounded-xl border border-border/60",
        className,
      )}
    >
      {children}
    </section>
  );
}

function Section({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  return (
    <div className="px-4 py-3">
      <p className="mb-1.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
        {label}
      </p>
      {children}
    </div>
  );
}

/**
 * One reading, with its state carried in FORM as well as colour: a warning
 * tile grows a left stripe and a labelled chip, so the state survives a
 * greyscale screen and a reader who cannot separate the hues.
 */
function Tile({
  label,
  value,
  detail,
  warning,
}: {
  label: string;
  value: string;
  detail?: string;
  warning?: string;
}) {
  return (
    <div
      className={cn(
        "rounded-lg border-l-2 px-3 py-2",
        warning
          ? "border-l-[color:var(--app-warning-border)] bg-[color:var(--app-warning-tint)]"
          : "border-l-transparent bg-muted/40",
      )}
    >
      <p className="text-[10px] uppercase tracking-wide text-muted-foreground">
        {label}
      </p>
      <p className="text-sm font-medium tabular-nums">{value}</p>
      {detail ? (
        <p className="text-[11px] tabular-nums text-muted-foreground">
          {detail}
        </p>
      ) : null}
      {warning ? (
        <span
          className={cn(
            "mt-1 inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 text-[10px] font-medium",
            TONE_CHIP.warning,
          )}
        >
          <AlertTriangle className="size-3" aria-hidden />
          {warning}
        </span>
      ) : null}
    </div>
  );
}

function ResidentRow({ model }: { model: PuppyResidentModel }) {
  const id = nonEmpty(model?.id);
  const size = finiteNumber(model?.size_gb);
  const status = nonEmpty(model?.status);
  if (!id && size === null) return null;
  return (
    <li className="flex items-baseline gap-2 text-xs">
      <span className="min-w-0 flex-1 truncate">{id ?? "Unnamed model"}</span>
      {size !== null ? (
        <span className="shrink-0 tabular-nums text-muted-foreground">
          {formatGb(size)}
        </span>
      ) : null}
      {status ? (
        <span className="shrink-0 text-[10px] uppercase tracking-wide text-muted-foreground">
          {status}
        </span>
      ) : null}
    </li>
  );
}

/**
 * Every job on this machine, and its switch.
 *
 * Three states are not the list being broken and none of them is an empty
 * box: no key set, a machine that did not answer, and a machine with nothing
 * scheduled are each one sentence.
 */
function PuppyJobList({
  payload,
  busyIds,
  errors,
  onToggle,
}: {
  payload: PuppyJobs | null;
  busyIds: ReadonlySet<string>;
  errors: Readonly<Record<string, string>>;
  onToggle: (job: PuppyJob) => void;
}) {
  if (!payload) {
    return (
      <p className="flex items-center gap-2 text-xs text-muted-foreground">
        <Loader2 className="size-3.5 animate-spin" aria-hidden />
        Reading the scheduled work…
      </p>
    );
  }

  if (payload.configured === false) {
    return (
      <p className="text-xs text-muted-foreground">
        {payload.message ||
          "Set HERMES_API_SERVER_KEY to see Puppy One's scheduled work."}
      </p>
    );
  }

  if (payload.reachable === false) {
    // Worded apart from the readings' own "not answering" line: they are
    // separate probes, and only one of them may have failed.
    return (
      <p className="text-xs text-muted-foreground">
        Puppy One did not answer about its scheduled work.
      </p>
    );
  }

  if (payload.jobs.length === 0) {
    return (
      <p className="text-xs text-muted-foreground">
        Nothing is scheduled on this machine.
      </p>
    );
  }

  return (
    <ul className="flex flex-col gap-1" data-testid="puppy-job-list">
      {orderJobsForReading(payload.jobs).map((job) => (
        <JobRow
          key={job.id}
          job={job}
          pending={busyIds.has(job.id)}
          error={errors[job.id] ?? null}
          onToggle={onToggle}
        />
      ))}
    </ul>
  );
}

/**
 * The order a person reads a long schedule in: what is failing first, then
 * what runs, then what they switched off, and by name within each so the
 * list is stable across refreshes. With forty jobs on a machine the
 * gateway's order (creation, mostly) buried the one that needed a hand.
 * Pure, so a test can pin it.
 */
export function orderJobsForReading(jobs: ReadonlyArray<PuppyJob>): PuppyJob[] {
  const rank = (job: PuppyJob): number => {
    const failing =
      nonEmpty(job.lastStatus)?.toLowerCase() === "error" || job.failureStreak > 0;
    if (failing) return 0;
    return job.paused ? 2 : 1;
  };
  return [...jobs].sort(
    (a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name) || a.id.localeCompare(b.id),
  );
}

/**
 * One job.
 *
 * Three forms, and each carries its state in shape as well as colour so it
 * survives a greyscale screen:
 *
 *   running   no stripe, full-strength name.
 *   paused    a plain grey stripe, a dimmed name, and the WORD "Paused". It
 *             is a deliberate off, not a fault, and it must never wear the
 *             colour that means something went wrong.
 *   failing   a red stripe and a labelled chip with a warning glyph, saying
 *             how many runs in a row went wrong. A paused job that last
 *             failed keeps the paused form and still shows the chip: both
 *             facts are true and neither is allowed to hide the other.
 *
 * The switch renders the GATEWAY's `paused`, never a local guess, so it
 * cannot appear to have flipped before the machine agreed. While a request is
 * in flight the row is busy and the switch refuses a second one.
 */
function JobRow({
  job,
  pending,
  error,
  onToggle,
}: {
  job: PuppyJob;
  pending: boolean;
  error: string | null;
  onToggle: (job: PuppyJob) => void;
}) {
  const nameId = useId();
  // A job is failing when its LAST run failed, or when it has a streak. A
  // lingering `lastError` from a run that has since recovered is history, not
  // a state: treating any non-empty error as failure marked healthy jobs red
  // and suppressed their true "last run ok" line, so the row disagreed with
  // itself. The error text is still shown below when there is one.
  const statusWord = nonEmpty(job.lastStatus)?.toLowerCase();
  const failing =
    job.failureStreak > 0 || statusWord === "error" || statusWord === "failed";

  const detail: string[] = [];
  const schedule = describeSchedule(job.schedule);
  if (schedule) detail.push(schedule);
  if (job.paused) {
    detail.push("Paused");
  } else {
    const next = describeNextRun(job.nextRunAt);
    if (next) detail.push(next);
  }
  const lastStatus = nonEmpty(job.lastStatus);
  if (!failing && lastStatus) detail.push(`last run ${lastStatus}`);

  return (
    <li
      className={cn(
        "rounded-lg border-l-2 px-2.5 py-2",
        job.paused
          ? "border-l-border bg-muted/30"
          : failing
            ? "border-l-[color:var(--app-destructive-border)] bg-[color:var(--app-destructive-tint)]"
            : "border-l-transparent bg-muted/40",
      )}
    >
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <p
            id={nameId}
            className={cn(
              "truncate text-xs font-medium",
              job.paused && "text-muted-foreground",
            )}
          >
            {job.name}
          </p>
          {detail.length > 0 ? (
            <p className="mt-0.5 text-[11px] tabular-nums text-muted-foreground">
              {detail.join(" · ")}
            </p>
          ) : null}
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          {pending ? (
            <Loader2
              className="size-3 animate-spin text-muted-foreground"
              aria-hidden
            />
          ) : null}
          <Switch
            size="sm"
            checked={!job.paused}
            disabled={pending}
            aria-busy={pending || undefined}
            aria-labelledby={nameId}
            onCheckedChange={() => onToggle(job)}
          />
        </div>
      </div>

      {failing ? (
        <span
          className={cn(
            "mt-1.5 inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 text-[10px] font-medium",
            TONE_CHIP.danger,
          )}
        >
          <AlertTriangle className="size-3" aria-hidden />
          {describeFailure(job.failureStreak)}
        </span>
      ) : null}

      {/* Verbatim from the machine. A rewritten error is a different error. */}
      {nonEmpty(job.lastError) ? (
        <p className="mt-1 break-words text-[10px] text-muted-foreground">
          {job.lastError}
        </p>
      ) : null}

      {/* The refusal, said on the row it belongs to. The switch above still
          shows what the job is actually doing.

          `alert` rather than `status`: this node is INSERTED in answer to
          something the owner just did, and an inserted alert is the case
          screen readers actually announce. */}
      {error ? (
        <p
          role="alert"
          className="mt-1 text-[10px] font-medium text-[color:var(--app-destructive-deep)] dark:text-[color:var(--app-destructive-bright)]"
        >
          {error}
        </p>
      ) : null}
    </li>
  );
}

type LinkState =
  | { kind: "alert"; tone: "warning" | "danger"; message: string; remedy?: string }
  | { kind: "quiet"; message: string; action?: { href: string; label: string } }
  | { kind: "healthy"; message: string | null };

/**
 * Read the link to Hussh One.
 *
 * The device is not the authority on this and cannot be: it stays enrolled and
 * fully functional after its login dies, which is the whole failure this
 * section exists to surface. So an unreadable or unrecognised state is said
 * plainly rather than resolved to the nearest healthy-looking one, and a
 * payload with no `session` at all reports nothing rather than guessing.
 */
function describeLink(link: PuppyResourceLink | undefined): LinkState | null {
  const session = nonEmpty(link?.session);
  if (!session) return null;

  if (session === "ok") {
    const account = nonEmpty(link?.account_email);
    const environment = nonEmpty(link?.environment);
    const parts = [account, environment].filter(Boolean) as string[];
    return {
      kind: "healthy",
      message: parts.length ? `Signed in to Hussh One · ${parts.join(" · ")}` : null,
    };
  }

  // Never linked. Nothing is broken, so nothing is announced.
  if (session === "not_connected") return null;

  if (session === "expired") {
    return {
      kind: "alert",
      tone: "warning",
      message:
        "This machine is signed out of Hussh One. It is still trusted; One just cannot see it.",
      remedy: nonEmpty(link?.remedy) ?? undefined,
    };
  }

  if (session === "revoked") {
    return {
      kind: "alert",
      tone: "danger",
      message: "This device was revoked in One. Its local copy is sealed.",
      remedy: nonEmpty(link?.remedy) ?? undefined,
    };
  }

  // "indeterminate", and anything a later gateway invents. Not an alarm: an
  // unchecked link is not a broken one, and dressing it as red would train the
  // owner to ignore the banner that means something.
  return { kind: "quiet", message: "Link state could not be checked" };
}

/**
 * Three states, not two.
 *
 * The gate is what stops auxiliary work (compression, summarisation) resolving
 * a cloud provider behind a local main turn. A pinned local model with the gate
 * off is genuinely different from a machine that keeps everything, and saying
 * "on-device" for both is the one claim this surface must never make.
 */
function describeOrigin(
  onDevice: boolean | undefined,
  gate: boolean | undefined,
): { label: string; tone: Tone; icon: typeof Cpu } | null {
  if (onDevice === true) {
    return gate === true
      ? { label: "On this machine", tone: "success", icon: Cpu }
      : {
          label: "This turn is local; auxiliary work may leave",
          tone: "warning",
          icon: Cpu,
        };
  }
  if (onDevice === false) {
    return { label: "Answers leave this machine", tone: "danger", icon: Cloud };
  }
  // Not reported. Claiming either way would be inventing the product's
  // central fact, so the model name stands alone without a claim.
  return null;
}

function describePower(
  charging: boolean | undefined,
  onAc: boolean | undefined,
): string | undefined {
  if (charging) return "Charging";
  if (onAc) return "On power";
  if (charging === false && onAc === false) return "On battery";
  return undefined;
}

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function nonEmpty(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed || null;
}

function formatGb(value: number): string {
  return `${value >= 100 ? value.toFixed(0) : value.toFixed(1)} GB`;
}

function formatPct(value: number): string {
  return `${Math.round(value)}%`;
}

const WEEKDAYS = [
  "Sundays",
  "Mondays",
  "Tuesdays",
  "Wednesdays",
  "Thursdays",
  "Fridays",
  "Saturdays",
];

/**
 * A schedule, in the words someone would use out loud.
 *
 * "10 3 * * *" is a machine's sentence, not a person's, and an owner deciding
 * whether to switch a job off should not have to parse cron in their head.
 *
 * Translated ONLY for the shapes that translate exactly. Anything else --
 * step lists, ranges, named weekdays, the gateway's own "every 30m" -- is
 * printed verbatim, because a schedule described wrongly is worse than one
 * left in its own notation: it is the sentence the owner would act on.
 *
 * 24-hour time on purpose. It is unambiguous, it needs no locale, and it
 * sorts the way the numbers already read.
 */
function describeSchedule(expression: string | null): string | null {
  const raw = nonEmpty(expression);
  if (!raw) return null;

  const fields = raw.split(/\s+/);
  if (fields.length !== 5) return raw;
  // The defaults are unreachable -- the length is already five -- and exist
  // only so each field is a string rather than `string | undefined`.
  const [minute = "", hour = "", dayOfMonth = "", month = "", dayOfWeek = ""] =
    fields;
  if (month !== "*") return raw;

  const everyMinutes = stepValue(minute);
  if (
    everyMinutes !== null &&
    hour === "*" &&
    dayOfMonth === "*" &&
    dayOfWeek === "*"
  ) {
    return `Every ${everyMinutes} min`;
  }

  const minuteAt = cronNumber(minute, 0, 59);
  if (minuteAt === null) return raw;

  const everyHours = stepValue(hour);
  if (everyHours !== null && dayOfMonth === "*" && dayOfWeek === "*") {
    return `Every ${everyHours} h at :${pad(minuteAt)}`;
  }

  if (hour === "*" && dayOfMonth === "*" && dayOfWeek === "*") {
    return `Hourly at :${pad(minuteAt)}`;
  }

  const hourAt = cronNumber(hour, 0, 23);
  if (hourAt === null) return raw;
  const at = `${pad(hourAt)}:${pad(minuteAt)}`;

  if (dayOfMonth === "*" && dayOfWeek === "*") return `Daily at ${at}`;

  if (dayOfMonth === "*") {
    const weekday = cronNumber(dayOfWeek, 0, 7);
    if (weekday === null) return raw;
    // Cron accepts both 0 and 7 for Sunday.
    const named = WEEKDAYS[weekday % 7];
    if (!named) return raw;
    return `${named} at ${at}`;
  }

  if (dayOfWeek === "*") {
    const day = cronNumber(dayOfMonth, 1, 31);
    if (day === null) return raw;
    return `Monthly on the ${ordinal(day)} at ${at}`;
  }

  return raw;
}

/** A cron step field, star-slash-15, read as 15. Null for anything else. */
function stepValue(field: string): number | null {
  const match = /^\*\/(\d{1,2})$/.exec(field);
  if (!match) return null;
  const value = Number(match[1]);
  return Number.isInteger(value) && value > 0 ? value : null;
}

/** A single plain integer in range. Lists, ranges and names return null. */
function cronNumber(field: string, min: number, max: number): number | null {
  if (!/^\d{1,2}$/.test(field)) return null;
  const value = Number(field);
  return value >= min && value <= max ? value : null;
}

function pad(value: number): string {
  return value < 10 ? `0${value}` : String(value);
}

function ordinal(value: number): string {
  const tens = value % 100;
  if (tens >= 11 && tens <= 13) return `${value}th`;
  const ones = value % 10;
  if (ones === 1) return `${value}st`;
  if (ones === 2) return `${value}nd`;
  if (ones === 3) return `${value}rd`;
  return `${value}th`;
}

/**
 * "next in 14 min", or "due now".
 *
 * Measured against the browser's clock rather than a stamp on the payload,
 * because this route does not carry one -- and it is the same machine: the
 * gateway is reached over loopback from the server this page came from.
 */
function describeNextRun(iso: string | null): string | null {
  const at = nonEmpty(iso);
  if (!at) return null;
  const relative = relativeTime(Date.now(), at);
  if (!relative) return null;
  return relative.startsWith("in ") ? `next ${relative}` : relative;
}

function describeFailure(streak: number): string {
  return streak > 1 ? `Failed ${streak} runs in a row` : "Last run failed";
}

/** "in 14 min". Returns null for a timestamp that cannot be read. */
function relativeTime(baseMs: number, iso: string): string | null {
  const at = Date.parse(iso);
  if (!Number.isFinite(at) || !baseMs) return null;
  const diffMs = at - baseMs;
  if (diffMs <= 0) return "due now";
  const minutes = Math.round(diffMs / 60_000);
  if (minutes < 1) return "in under a minute";
  if (minutes < 60) return `in ${minutes} min`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `in ${hours} h`;
  return `in ${Math.round(hours / 24)} d`;
}
