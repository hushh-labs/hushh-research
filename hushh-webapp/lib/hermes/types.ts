/**
 * Hussh One Hermes bridge — wire types.
 *
 * These mirror the live Hermes local API (gateway/platforms/api_server.py in
 * hussh-one-hermes-agent, default 127.0.0.1:8642). Shapes were captured from a
 * running instance rather than authored from documentation, so optional fields
 * reflect what the server actually omits.
 */

/** Platform channels Hermes bridges (WhatsApp, Feishu, its own API server, ...). */
export interface HermesPlatformLink {
  state: string;
  error_code: string | null;
  error_message: string | null;
  updated_at: string | null;
}

export interface HermesReadinessCheck {
  status: string;
  [detail: string]: unknown;
}

export interface HermesReadiness {
  status: string;
  checks: Record<string, HermesReadinessCheck>;
}

/** `GET /health/detailed` — the machine's own view of itself. */
export interface HermesStatus {
  status: string;
  readiness: HermesReadiness | null;
  platform: string;
  version: string;
  gateway_state: string;
  platforms: Record<string, HermesPlatformLink>;
  active_agents: number;
  gateway_busy: boolean;
  gateway_drainable: boolean;
  exit_reason: string | null;
  updated_at: string | null;
  pid: number | null;
}

/** `GET /api/jobs` — a scheduled (cron) job on the Hermes machine. */
export interface HermesJob {
  id: string;
  name: string;
  schedule: string;
  schedule_display?: string | null;
  enabled: boolean;
  state?: string | null;
  prompt?: string | null;
  skill?: string | null;
  model?: string | null;
  provider?: string | null;
  last_run_at?: string | number | null;
  next_run_at?: string | number | null;
  last_status?: string | null;
  last_error?: string | null;
  paused_at?: string | number | null;
  paused_reason?: string | null;
}

/** One natural-language turn executed on the Hermes machine. */
export interface HermesTurnResult {
  content: string;
  session_id: string | null;
  model: string | null;
  provider: string | null;
  /** True when Hermes answered but reported an agent-side failure. */
  failed: boolean;
  error: string | null;
}

/**
 * A trusted device as the Hussh account API reports it
 * (`GET /api/account/trusted-devices`).
 */
export interface HermesTrustedDevice {
  device_id: string;
  device_name: string;
  platform: string;
  status: "active" | "revoked";
  created_at: number;
  last_used_at: number | null;
  revoked_at?: number | null;
}

/**
 * Whether the Hermes reachable from this server is the same machine as one of
 * the account's registered trusted devices.
 *
 * `deviceId` is read from the local Hermes profile
 * (`~/.hermes/hussh-one/identity.json`), which is written by
 * `/hussh-one connect`. It is the only honest way to say "this running Hermes
 * IS that registered device" — a reachable port alone proves nothing about
 * which account the machine is enrolled to.
 */
export interface HermesLocalIdentity {
  deviceId: string | null;
  environment: string | null;
  /** Vault lock state, when the local profile exposes it. */
  vaultLocked: boolean | null;
  /** Why the identity could not be read, for operator-facing diagnostics. */
  unavailableReason: string | null;
}

/** Reachability of the local Hermes API, independent of enrollment. */
export type HermesReachability = "online" | "offline" | "unauthorized" | "disabled";

/** The composite the UI renders: registration truth + live machine truth. */
export interface HermesBridgeStatus {
  reachability: HermesReachability;
  /** Present only when reachable and authorized. */
  status: HermesStatus | null;
  identity: HermesLocalIdentity;
  /** Set when reachability is not "online". */
  error: string | null;
}
