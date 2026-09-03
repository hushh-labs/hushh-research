"use client";

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { AlertTriangle, Cloud, Cpu, Loader2 } from "lucide-react";

import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet";
import {
  fetchPuppyResources,
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
 * sheet, and nothing repeats while that sheet is shut.
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
 */
function useMachineReading(live: boolean): {
  payload: PuppyResources | null;
  readAt: number;
} {
  const [payload, setPayload] = useState<PuppyResources | null>(null);
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

  return { payload, readAt };
}

/**
 * The owner's way in: one quiet control, plus the one reading that refuses to
 * hide behind it.
 *
 * The control names what it opens rather than what it is made of. "This
 * machine" is the thing the owner is asking about; "Metrics" or "Debug" would
 * be this code describing itself.
 */
export function PuppyMachineSheet({ className }: { className?: string }) {
  const [open, setOpen] = useState(false);
  const { payload, readAt } = useMachineReading(open);
  const linkState = describeLink(payload?.link);
  // "ok" resolves to `healthy` and "not_connected" to null, so what is left is
  // exactly the set the owner cannot be left to discover by tapping.
  const notice = linkState && linkState.kind !== "healthy" ? linkState : null;

  return (
    <div className={cn("flex flex-col gap-2", className)}>
      {notice ? <LinkNotice state={notice} /> : null}
      <div className="flex justify-end">
        <Sheet open={open} onOpenChange={setOpen} modal>
          <SheetTrigger asChild>
            <button
              type="button"
              className="inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-medium text-muted-foreground transition-colors hover:bg-foreground/[0.045] hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <Cpu className="size-3.5" aria-hidden />
              This machine
            </button>
          </SheetTrigger>
          <SheetContent
            side="bottom"
            className="gap-0 p-0 sm:mx-auto sm:max-w-md"
          >
            <SheetHeader className="px-4 pb-2 pr-12 pt-3 text-left">
              <SheetTitle className="text-base">This machine</SheetTitle>
              <SheetDescription>
                What Puppy One is running on, read while this is open.
              </SheetDescription>
            </SheetHeader>
            {/* No padding of its own: every section inside already carries
                `px-4`, which is the header's gutter too. */}
            <div className="pb-[calc(1rem+env(safe-area-inset-bottom,0px))]">
              {/* The sheet is already the boundary. A second bordered card
                  inside it would be a box drawn around a box. */}
              <PuppyResourceMonitor
                payload={payload}
                readAt={readAt}
                className="rounded-none border-0"
              />
            </div>
          </SheetContent>
        </Sheet>
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
      <p className="text-[11px] text-muted-foreground">{state.message}</p>
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
  className,
}: {
  payload: PuppyResources | null;
  /** Epoch ms of that read. 0 means "not stamped": no relative time is shown. */
  readAt?: number;
  className?: string;
}) {
  if (!payload) {
    return (
      <Shell className={className}>
        <p className="flex items-center gap-2 px-4 py-3 text-xs text-muted-foreground">
          <Loader2 className="size-3.5 animate-spin" aria-hidden />
          Reading this machine…
        </p>
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
      </Shell>
    );
  }

  if (payload.reachable === false) {
    return (
      <Shell className={className}>
        <p className="px-4 py-3 text-xs text-muted-foreground">
          Puppy One is not answering on this machine.
        </p>
      </Shell>
    );
  }

  const { agent, machine, models, jobs, link } = payload;
  const linkState = describeLink(link);
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
  const hasJobs =
    jobsEnabled !== null || nextJobName !== null || completed !== null;
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

type LinkState =
  | { kind: "alert"; tone: "warning" | "danger"; message: string; remedy?: string }
  | { kind: "quiet"; message: string }
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
