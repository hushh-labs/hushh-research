import { NextRequest } from "next/server";

export const dynamic = "force-dynamic";

import { isSameOriginRequest, resolveHermesBridgeConfig } from "@/lib/hermes/bridge-config";
import { resolveRequestId, withRequestIdJson } from "@/app/api/_utils/request-id";

/**
 * The work Puppy One does on a schedule, and the switch for each one.
 *
 * These are the jobs that run on the owner's machine whether or not anyone is
 * watching: the nightly memory consolidation, the wiki and board syncs, the
 * self-healing doctor. Until now the only way to see or stop one was a slash
 * command, so a job that had started misbehaving overnight could not be turned
 * off from the surface that shows it running.
 *
 * Server-side only, like every route in this folder: the loopback bearer key
 * is host remote-code-execution and never reaches the browser.
 */

export interface PuppyJob {
  id: string;
  name: string;
  schedule: string | null;
  paused: boolean;
  nextRunAt: string | null;
  lastStatus: string | null;
  lastError: string | null;
  failureStreak: number;
}

/** Pausing and resuming only. Deleting or editing a job is not a toggle. */
const ACTIONS = new Set(["pause", "resume"]);

/**
 * A job id as the scheduler writes them: hex, or a dated run id.
 *
 * Validated by shape rather than escaped, because the id becomes a PATH
 * SEGMENT on the local gateway. `encodeURIComponent` leaves `.` untouched, so
 * an id of ".." would still traverse out of `/api/jobs/{id}/{action}` and post
 * to a different endpoint entirely. An allowlist cannot be talked around.
 */
const JOB_ID = /^[A-Za-z0-9_-]{1,64}$/;

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function toJob(raw: unknown): PuppyJob | null {
  const row = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const id = text(row.id);
  if (!id) return null;
  const schedule =
    row.schedule && typeof row.schedule === "object"
      ? (row.schedule as Record<string, unknown>)
      : {};
  return {
    id,
    name: text(row.name) ?? id,
    schedule:
      text(row.schedule_display) ?? text(schedule.display) ?? text(schedule.expr),
    // `state` is the scheduler's own word for it. A job is off when it says
    // paused, not when some other field is falsy.
    paused: text(row.state) === "paused",
    nextRunAt: text(row.next_run_at),
    lastStatus: text(row.last_status),
    // Surfaced because a job that reports "ok" while its delivery fails is the
    // exact case the owner needs to see; both errors are worth showing.
    lastError: text(row.last_error) ?? text(row.last_delivery_error),
    failureStreak:
      typeof row.failure_streak === "number" && row.failure_streak > 0
        ? Math.floor(row.failure_streak)
        : 0,
  };
}

export async function GET(request: NextRequest) {
  const requestId = resolveRequestId(request);
  const config = resolveHermesBridgeConfig();
  if (!config) {
    return withRequestIdJson(
      requestId,
      {
        configured: false,
        reason: "not_configured",
        jobs: [],
        message: "Set HERMES_API_SERVER_KEY to see Puppy One's scheduled work.",
      },
      { status: 200 },
    );
  }

  let upstream: Response;
  try {
    // include_disabled=true is load-bearing, not a nicety. The gateway hides
    // paused jobs by default, so without it a job vanished from this list the
    // moment it was switched off and there was no way left to switch it back
    // on. A control that can only be moved one way is not a switch.
    upstream = await fetch(`${config.baseUrl}/api/jobs?include_disabled=true`, {
      headers: { Authorization: `Bearer ${config.apiKey}` },
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    return withRequestIdJson(
      requestId,
      { configured: true, reachable: false, jobs: [] },
      { status: 200 },
    );
  }
  if (!upstream.ok) {
    return withRequestIdJson(
      requestId,
      { configured: true, reachable: false, jobs: [] },
      { status: 200 },
    );
  }

  const payload = (await upstream.json().catch(() => ({}))) as { jobs?: unknown };
  // Mapped field by field on purpose. The gateway's row carries the job's full
  // prompt, its model credentials and its working directory; none of that is
  // the browser's business, and passing the row through would ship all of it.
  const jobs = (Array.isArray(payload.jobs) ? payload.jobs : [])
    .map(toJob)
    .filter((job): job is PuppyJob => job !== null);

  return withRequestIdJson(
    requestId,
    { jobs, configured: true, reachable: true },
    { status: 200 },
  );
}

export async function POST(request: NextRequest) {
  const requestId = resolveRequestId(request);
  const config = resolveHermesBridgeConfig();
  if (!config) {
    return withRequestIdJson(
      requestId,
      { ok: false, error: "Set HERMES_API_SERVER_KEY to change Puppy One's schedule." },
      { status: 200 },
    );
  }

  if (!isSameOriginRequest(request)) {
    // This route holds the loopback key and changes what the owner's machine
    // does on a schedule. A page they merely visit must not be able to reach it.
    return withRequestIdJson(
      requestId,
      { ok: false, error: "Cross-site requests cannot change Puppy One's schedule." },
      { status: 403 },
    );
  }

  const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
  const id = text(body.id);
  const action = text(body.action)?.toLowerCase();
  if (!id || !JOB_ID.test(id) || !action || !ACTIONS.has(action)) {
    // Both are allowlisted rather than forwarded: each becomes a path segment
    // on the local gateway, so an unrecognised value is a request to somewhere
    // this route does not intend to go.
    return withRequestIdJson(
      requestId,
      { ok: false, error: "Pass a job id and either pause or resume.", accepted: [...ACTIONS] },
      { status: 400 },
    );
  }

  let upstream: Response;
  try {
    upstream = await fetch(
      `${config.baseUrl}/api/jobs/${encodeURIComponent(id)}/${action}`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${config.apiKey}`,
          "Content-Type": "application/json",
        },
        signal: AbortSignal.timeout(15_000),
      },
    );
  } catch {
    return withRequestIdJson(
      requestId,
      { ok: false, error: "Puppy One is not answering on this machine." },
      { status: 200 },
    );
  }
  if (!upstream.ok) {
    return withRequestIdJson(
      requestId,
      { ok: false, error: "Puppy One could not change that job." },
      { status: 200 },
    );
  }

  const result = (await upstream.json().catch(() => ({}))) as Record<string, unknown>;
  // A 2xx is the gateway answering, not the gateway agreeing. It reports a
  // refusal in the body, and reading only the status turned a soft "no" into a
  // success the switch would then render as done.
  if (result.ok === false || text(result.error)) {
    return withRequestIdJson(
      requestId,
      { ok: false, error: text(result.error) ?? "Puppy One did not change that job." },
      { status: 200 },
    );
  }
  return withRequestIdJson(
    requestId,
    { ok: true, id, action, job: toJob(result.job ?? result) },
    { status: 200 },
  );
}
