"use client";

/**
 * Hermes console — the app-side surface for the operator's linked Hermes
 * machine.
 *
 * Three panes, in the order a person actually asks the questions:
 *   1. Is my Hermes linked, and is it awake right now?
 *   2. What is it connected to, and what is it scheduled to do?
 *   3. Ask it something and read the answer.
 *
 * Registration truth (the trusted-device registry) and live truth (the machine
 * answering on loopback) are rendered as separate facts on purpose: an enrolled
 * device that is asleep and a running process that is not enrolled are
 * different situations and should never look the same.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Activity,
  Clock,
  Laptop,
  Loader2,
  Plug,
  Send,
  ShieldCheck,
} from "lucide-react";

import {
  AppPageContentRegion,
  AppPageHeaderRegion,
  AppPageShell,
} from "@/components/app-ui/app-page-shell";
import { PageHeader } from "@/components/app-ui/page-sections";
import { Button } from "@/components/ui/button";
import { useAuth } from "@/hooks/use-auth";
import { ApiService } from "@/lib/services/api-service";
import type {
  HermesBridgeStatus,
  HermesJob,
  HermesTrustedDevice,
} from "@/lib/hermes/types";

interface TurnEntry {
  id: string;
  prompt: string;
  answer: string | null;
  failed: boolean;
  pending: boolean;
}

function relativeTime(epochMs: number | null | undefined): string {
  if (!epochMs) return "never";
  const delta = Date.now() - epochMs;
  if (delta < 60_000) return "just now";
  const minutes = Math.floor(delta / 60_000);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

function StatusPill({ tone, label }: { tone: "ok" | "warn" | "off"; label: string }) {
  const palette =
    tone === "ok"
      ? "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
      : tone === "warn"
        ? "bg-amber-500/10 text-amber-600 dark:text-amber-400"
        : "bg-muted text-muted-foreground";
  return (
    <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${palette}`}>
      {label}
    </span>
  );
}

export function HermesConsoleClient() {
  const { user } = useAuth();
  const [bridge, setBridge] = useState<HermesBridgeStatus | null>(null);
  const [devices, setDevices] = useState<HermesTrustedDevice[]>([]);
  const [jobs, setJobs] = useState<HermesJob[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const [prompt, setPrompt] = useState("");
  const [turns, setTurns] = useState<TurnEntry[]>([]);
  const [sending, setSending] = useState(false);
  const sessionRef = useRef<string | null>(null);

  const load = useCallback(async () => {
    if (!user) return;
    setLoading(true);
    try {
      const [statusRes, devicesRes] = await Promise.all([
        ApiService.getHermesStatus(),
        ApiService.listTrustedDevices(),
      ]);

      const statusPayload = await statusRes.json();
      if (statusRes.ok) {
        setBridge(statusPayload as HermesBridgeStatus);
        setError("");
      } else {
        setBridge(null);
        setError(statusPayload?.message || "Hermes status unavailable.");
      }

      const devicePayload = await devicesRes.json();
      setDevices(
        devicesRes.ok && Array.isArray(devicePayload?.devices)
          ? (devicePayload.devices as HermesTrustedDevice[])
          : [],
      );

      // Jobs only exist when the machine is actually answering.
      if (statusRes.ok && (statusPayload as HermesBridgeStatus).reachability === "online") {
        const jobsRes = await ApiService.listHermesJobs();
        const jobsPayload = await jobsRes.json();
        setJobs(
          jobsRes.ok && Array.isArray(jobsPayload?.jobs)
            ? (jobsPayload.jobs as HermesJob[])
            : [],
        );
      } else {
        setJobs([]);
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Hermes is unavailable.");
    } finally {
      setLoading(false);
    }
  }, [user]);

  useEffect(() => {
    void load();
  }, [load]);

  const online = bridge?.reachability === "online";

  /** The registered device this running Hermes proves itself to be. */
  const linkedDevice = useMemo(() => {
    const id = bridge?.identity.deviceId;
    if (!id) return null;
    return devices.find((device) => device.device_id === id) ?? null;
  }, [bridge, devices]);

  const platforms = useMemo(
    () => Object.entries(bridge?.status?.platforms ?? {}),
    [bridge],
  );

  const send = useCallback(async () => {
    const text = prompt.trim();
    if (!text || sending) return;
    const id = `${Date.now()}`;
    setTurns((prior) => [
      ...prior,
      { id, prompt: text, answer: null, failed: false, pending: true },
    ]);
    setPrompt("");
    setSending(true);
    try {
      const response = await ApiService.runHermesTurn(text, sessionRef.current);
      const payload = await response.json();
      if (!response.ok) {
        throw new Error(payload?.message || "Hermes could not answer.");
      }
      if (typeof payload.session_id === "string") sessionRef.current = payload.session_id;
      setTurns((prior) =>
        prior.map((turn) =>
          turn.id === id
            ? {
                ...turn,
                pending: false,
                failed: Boolean(payload.failed),
                answer: payload.failed
                  ? payload.error || payload.content || "Hermes reported a failure."
                  : payload.content || "(no output)",
              }
            : turn,
        ),
      );
    } catch (cause) {
      setTurns((prior) =>
        prior.map((turn) =>
          turn.id === id
            ? {
                ...turn,
                pending: false,
                failed: true,
                answer: cause instanceof Error ? cause.message : "Hermes is unavailable.",
              }
            : turn,
        ),
      );
    } finally {
      setSending(false);
    }
  }, [prompt, sending]);

  return (
    <AppPageShell>
      <AppPageHeaderRegion>
        <PageHeader
          title="Hermes"
          description="Your linked Hussh One Hermes machine — what it is connected to, what it runs on a schedule, and a direct line to ask it something."
        />
      </AppPageHeaderRegion>

      <AppPageContentRegion>
        {loading ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
            Checking your Hermes…
          </div>
        ) : (
          <div className="space-y-6">
            {/* 1. Link + liveness */}
            <section className="rounded-lg border p-4">
              <div className="flex items-start justify-between gap-4">
                <div className="flex items-start gap-3">
                  <Laptop className="mt-0.5 h-5 w-5 text-muted-foreground" aria-hidden />
                  <div>
                    <div className="flex items-center gap-2">
                      <h2 className="font-medium">
                        {linkedDevice?.device_name ?? "Hermes machine"}
                      </h2>
                      <StatusPill
                        tone={online ? "ok" : "off"}
                        label={online ? "Online" : "Offline"}
                      />
                      {linkedDevice ? (
                        <StatusPill
                          tone={linkedDevice.status === "active" ? "ok" : "warn"}
                          label={
                            linkedDevice.status === "active"
                              ? "Trusted device"
                              : "Revoked"
                          }
                        />
                      ) : null}
                    </div>
                    <p className="mt-1 text-sm text-muted-foreground">
                      {linkedDevice
                        ? `${linkedDevice.platform} · last used ${relativeTime(linkedDevice.last_used_at)}`
                        : bridge?.identity.unavailableReason ||
                          "This machine is not enrolled as a trusted device."}
                    </p>
                    {online && bridge?.status ? (
                      <p className="mt-1 text-xs text-muted-foreground">
                        Hermes {bridge.status.version} · gateway{" "}
                        {bridge.status.gateway_state} · readiness{" "}
                        {bridge.status.readiness?.status ?? bridge.status.status}
                      </p>
                    ) : null}
                  </div>
                </div>
                <Button variant="outline" size="sm" onClick={() => void load()}>
                  Refresh
                </Button>
              </div>

              {bridge?.identity.vaultLocked === false && linkedDevice ? (
                <p className="mt-3 flex items-center gap-1.5 text-xs text-muted-foreground">
                  <ShieldCheck className="h-3.5 w-3.5" aria-hidden />
                  Vault unlocked on this machine.
                </p>
              ) : null}

              {!online && (bridge?.error || error) ? (
                <p className="mt-3 text-sm text-muted-foreground">
                  {bridge?.error || error}
                </p>
              ) : null}
            </section>

            {/* 2a. What Hermes is connected to — the linked channels */}
            {online && platforms.length > 0 ? (
              <section className="rounded-lg border p-4">
                <h2 className="mb-3 flex items-center gap-2 font-medium">
                  <Plug className="h-4 w-4 text-muted-foreground" aria-hidden />
                  Connected channels
                </h2>
                <ul className="space-y-2">
                  {platforms.map(([name, link]) => (
                    <li
                      key={name}
                      className="flex items-center justify-between gap-3 text-sm"
                    >
                      <span className="capitalize">{name.replace(/_/g, " ")}</span>
                      <StatusPill
                        tone={link.state === "connected" ? "ok" : "warn"}
                        label={link.state}
                      />
                    </li>
                  ))}
                </ul>
              </section>
            ) : null}

            {/* 2b. Scheduled work */}
            {online ? (
              <section className="rounded-lg border p-4">
                <h2 className="mb-3 flex items-center gap-2 font-medium">
                  <Clock className="h-4 w-4 text-muted-foreground" aria-hidden />
                  Scheduled jobs
                  <span className="text-sm font-normal text-muted-foreground">
                    ({jobs.length})
                  </span>
                </h2>
                {jobs.length === 0 ? (
                  <p className="text-sm text-muted-foreground">
                    No scheduled jobs on this machine.
                  </p>
                ) : (
                  <ul className="space-y-2">
                    {jobs.map((job) => (
                      <li
                        key={job.id}
                        className="flex items-start justify-between gap-3 text-sm"
                      >
                        <div className="min-w-0">
                          <p className="truncate font-medium">{job.name}</p>
                          <p className="text-xs text-muted-foreground">
                            {job.schedule_display || job.schedule}
                            {job.last_status ? ` · last ${job.last_status}` : ""}
                          </p>
                        </div>
                        <StatusPill
                          tone={job.enabled ? "ok" : "off"}
                          label={job.enabled ? "enabled" : "paused"}
                        />
                      </li>
                    ))}
                  </ul>
                )}
              </section>
            ) : null}

            {/* 3. The relay */}
            <section className="rounded-lg border p-4">
              <h2 className="mb-3 flex items-center gap-2 font-medium">
                <Activity className="h-4 w-4 text-muted-foreground" aria-hidden />
                Ask Hermes
              </h2>

              {turns.length > 0 ? (
                <ul className="mb-3 space-y-3">
                  {turns.map((turn) => (
                    <li key={turn.id} className="space-y-1 text-sm">
                      <p className="font-medium">{turn.prompt}</p>
                      {turn.pending ? (
                        <p className="flex items-center gap-2 text-muted-foreground">
                          <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
                          Running on your machine…
                        </p>
                      ) : (
                        <p
                          className={
                            turn.failed
                              ? "whitespace-pre-wrap text-amber-600 dark:text-amber-400"
                              : "whitespace-pre-wrap text-muted-foreground"
                          }
                        >
                          {turn.answer}
                        </p>
                      )}
                    </li>
                  ))}
                </ul>
              ) : null}

              <div className="flex gap-2">
                <input
                  type="text"
                  value={prompt}
                  onChange={(event) => setPrompt(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" && !event.shiftKey) {
                      event.preventDefault();
                      void send();
                    }
                  }}
                  disabled={!online || sending}
                  placeholder={
                    online ? "Ask your machine to do something…" : "Hermes is offline"
                  }
                  aria-label="Message for Hermes"
                  className="flex-1 rounded-md border bg-background px-3 py-2 text-sm disabled:opacity-50"
                />
                <Button onClick={() => void send()} disabled={!online || sending || !prompt.trim()}>
                  {sending ? (
                    <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
                  ) : (
                    <Send className="h-4 w-4" aria-hidden />
                  )}
                  <span className="sr-only">Send to Hermes</span>
                </Button>
              </div>
            </section>
          </div>
        )}
      </AppPageContentRegion>
    </AppPageShell>
  );
}
