"use client";

import { useEffect, useState, type ReactNode } from "react";
import { AlertTriangle, Cloud, Cpu, Loader2 } from "lucide-react";

import {
  fetchPuppyResources,
  type PuppyResidentModel,
  type PuppyResourceLink,
  type PuppyResources,
} from "@/lib/services/puppy-one-service";
import { cn } from "@/lib/utils";

/**
 * The machine Puppy One runs on, read live.
 *
 * A broken link to Hussh One comes FIRST, above all of it. Enrolment outlives
 * login, so a machine whose session died stays trusted and keeps answering
 * locally while One has not seen it for weeks. Every reading below it would
 * still say "healthy", which is exactly why that one fact cannot wait its turn.
 *
 * Then four questions, in the order an owner asks them:
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

/** Slow enough to be free, fast enough that a model load shows up. */
const POLL_MS = 20_000;

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

export function PuppyResourceMonitor({ className }: { className?: string }) {
  const [payload, setPayload] = useState<PuppyResources | null>(null);
  // Epoch ms of the last successful read, used only when the gateway did not
  // stamp the payload. Preferring the gateway's own clock keeps "in 14 min"
  // free of skew between this browser and the machine.
  const [readAt, setReadAt] = useState(0);

  useEffect(() => {
    let active = true;
    const read = async () => {
      const next = await fetchPuppyResources();
      if (!active) return;
      setPayload(next);
      setReadAt(Date.now());
    };
    void read();
    const timer = setInterval(() => void read(), POLL_MS);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, []);

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
  // A healthy link with nothing to name it by renders no line, so it does not
  // count as something to show. Otherwise a payload carrying only that would
  // leave an empty bordered box on screen.
  const hasLinkLine =
    linkState !== null &&
    (linkState.kind !== "healthy" || Boolean(linkState.message));
  const nothingReadable =
    !hasLinkLine && !agent && !models && !hasHeadroom && !hasJobs;

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
      {/* 0. Can Hussh One still see this machine? Above everything, because
             every reading below it reads "healthy" while this one is broken. */}
      {linkState?.kind === "alert" ? (
        <div
          className={cn(
            "border-l-2 px-4 py-3",
            linkState.tone === "danger"
              ? "border-l-[color:var(--app-destructive-border)] bg-[color:var(--app-destructive-tint)]"
              : "border-l-[color:var(--app-warning-border)] bg-[color:var(--app-warning-tint)]",
          )}
        >
          <p
            className={cn(
              "flex items-start gap-2 text-xs font-medium",
              linkState.tone === "danger"
                ? "text-[color:var(--app-destructive-deep)] dark:text-[color:var(--app-destructive-bright)]"
                : "text-[color:var(--app-warning-deep)] dark:text-[color:var(--app-warning-bright)]",
            )}
          >
            <AlertTriangle className="mt-px size-3.5 shrink-0" aria-hidden />
            <span>{linkState.message}</span>
          </p>
          {linkState.remedy ? (
            // Verbatim from the payload. The device owns the fix; a command
            // written here would go stale the moment the CLI renames it.
            <p className="mt-1.5 pl-[1.375rem]">
              <code className="rounded bg-foreground/[0.06] px-1.5 py-0.5 font-mono text-[11px] text-foreground">
                {linkState.remedy}
              </code>
            </p>
          ) : null}
        </div>
      ) : null}
      {linkState?.kind === "quiet" ? (
        <p className="px-4 py-2 text-[11px] text-muted-foreground">
          {linkState.message}
        </p>
      ) : null}

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

      {/* A healthy link needs no card. It is a footnote, and it earns a line
          only when the payload actually named the account or environment. */}
      {linkState?.kind === "healthy" && linkState.message ? (
        <p className="truncate px-4 py-2 text-[11px] text-muted-foreground">
          {linkState.message}
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
