/**
 * Hussh One Hermes bridge — server-side client for the local Hermes API.
 *
 * Transport seam: today the app and Hermes share a machine, so this speaks
 * directly to loopback. When a hosted relay lands (Hermes dials out and holds a
 * socket; the server pushes jobs down it), only this module changes — callers
 * and route handlers keep the same three verbs: status, jobs, runTurn.
 */

import "server-only";

import { resolveHermesBridgeConfig, type HermesBridgeConfig } from "./config";
import { readHermesLocalIdentity } from "./local-identity";
import type {
  HermesBridgeStatus,
  HermesJob,
  HermesStatus,
  HermesTurnResult,
} from "./types";

const STATUS_TIMEOUT_MS = 5_000;
const JOBS_TIMEOUT_MS = 8_000;
/** A Hermes turn runs a real agent; it is slow by nature. */
const TURN_TIMEOUT_MS = 120_000;

/** Bounded so a paste cannot become an unbounded local agent run. */
export const MAX_PROMPT_CHARS = 4_000;

export class HermesBridgeError extends Error {
  constructor(
    message: string,
    readonly reachability: HermesBridgeStatus["reachability"],
  ) {
    super(message);
    this.name = "HermesBridgeError";
  }
}

async function hermesFetch(
  config: HermesBridgeConfig,
  pathname: string,
  init: RequestInit & { timeoutMs: number },
): Promise<Response> {
  const { timeoutMs, ...rest } = init;
  const headers = new Headers(rest.headers);
  headers.set("Authorization", `Bearer ${config.apiKey}`);
  headers.set("Accept", "application/json");

  let response: Response;
  try {
    response = await fetch(`${config.baseUrl}${pathname}`, {
      ...rest,
      headers,
      cache: "no-store",
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (cause) {
    const timedOut = cause instanceof Error && cause.name === "TimeoutError";
    throw new HermesBridgeError(
      timedOut
        ? "Hermes did not respond in time."
        : "Hermes is not reachable on this machine. Is the gateway running?",
      "offline",
    );
  }

  if (response.status === 401 || response.status === 403) {
    throw new HermesBridgeError(
      "Hermes rejected the bridge credential. Check HERMES_LOCAL_API_KEY.",
      "unauthorized",
    );
  }
  return response;
}

function requireEnabled(config: HermesBridgeConfig): void {
  if (!config.enabled) {
    throw new HermesBridgeError(
      config.disabledReason ?? "The Hermes bridge is unavailable.",
      "disabled",
    );
  }
}

/**
 * Registration truth (which device this is) plus live machine truth (is it up),
 * resolved together so the UI never implies a reachable port is an enrolled
 * device.
 */
export async function getHermesBridgeStatus(
  env: NodeJS.ProcessEnv = process.env,
): Promise<HermesBridgeStatus> {
  const config = resolveHermesBridgeConfig(env);
  const identity = await readHermesLocalIdentity(env);

  if (!config.enabled) {
    return {
      reachability: "disabled",
      status: null,
      identity,
      error: config.disabledReason,
    };
  }

  try {
    const response = await hermesFetch(config, "/health/detailed", {
      method: "GET",
      timeoutMs: STATUS_TIMEOUT_MS,
    });
    if (!response.ok) {
      return {
        reachability: "offline",
        status: null,
        identity,
        error: `Hermes returned ${response.status}.`,
      };
    }
    const status = (await response.json()) as HermesStatus;
    return { reachability: "online", status, identity, error: null };
  } catch (cause) {
    if (cause instanceof HermesBridgeError) {
      return {
        reachability: cause.reachability,
        status: null,
        identity,
        error: cause.message,
      };
    }
    throw cause;
  }
}

export async function listHermesJobs(
  env: NodeJS.ProcessEnv = process.env,
): Promise<HermesJob[]> {
  const config = resolveHermesBridgeConfig(env);
  requireEnabled(config);

  const response = await hermesFetch(config, "/api/jobs", {
    method: "GET",
    timeoutMs: JOBS_TIMEOUT_MS,
  });
  if (!response.ok) {
    throw new HermesBridgeError(`Hermes returned ${response.status} for jobs.`, "offline");
  }
  const payload = (await response.json()) as { jobs?: unknown };
  return Array.isArray(payload?.jobs) ? (payload.jobs as HermesJob[]) : [];
}

/**
 * Run one natural-language turn on the Hermes machine.
 *
 * Uses the OpenAI-compatible surface so a session is optional; when the caller
 * supplies a session id Hermes threads the conversation. Hermes reports agent
 * failures in-band (HTTP 200 with an error finish reason), so that case is
 * surfaced as `failed` rather than being mistaken for an answer.
 */
export async function runHermesTurn(
  prompt: string,
  options: { sessionId?: string | null; env?: NodeJS.ProcessEnv } = {},
): Promise<HermesTurnResult> {
  const env = options.env ?? process.env;
  const config = resolveHermesBridgeConfig(env);
  requireEnabled(config);

  const trimmed = prompt.trim();
  if (!trimmed) throw new HermesBridgeError("A prompt is required.", "online");
  if (trimmed.length > MAX_PROMPT_CHARS) {
    throw new HermesBridgeError(
      `Prompts are limited to ${MAX_PROMPT_CHARS} characters.`,
      "online",
    );
  }

  const headers = new Headers({ "Content-Type": "application/json" });
  if (options.sessionId) headers.set("X-Hermes-Session-Id", options.sessionId);

  const response = await hermesFetch(config, "/v1/chat/completions", {
    method: "POST",
    timeoutMs: TURN_TIMEOUT_MS,
    headers,
    body: JSON.stringify({ messages: [{ role: "user", content: trimmed }] }),
  });

  if (!response.ok) {
    throw new HermesBridgeError(`Hermes returned ${response.status}.`, "offline");
  }

  const payload = (await response.json()) as {
    choices?: Array<{ message?: { content?: unknown }; finish_reason?: unknown }>;
    model?: unknown;
    hermes?: { failed?: unknown; error?: unknown; provider?: unknown };
  };

  const choice = payload.choices?.[0];
  const content = typeof choice?.message?.content === "string" ? choice.message.content : "";
  const failed =
    payload.hermes?.failed === true || choice?.finish_reason === "error";

  return {
    content,
    session_id: response.headers.get("X-Hermes-Session-Id"),
    model: typeof payload.model === "string" ? payload.model : null,
    provider:
      typeof payload.hermes?.provider === "string" ? payload.hermes.provider : null,
    failed,
    error: typeof payload.hermes?.error === "string" ? payload.hermes.error : null,
  };
}
