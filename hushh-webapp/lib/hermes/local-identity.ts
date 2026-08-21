/**
 * Reads the local Hermes trusted-device enrollment.
 *
 * `/hussh-one connect` writes `~/.hermes/hussh-one/identity.json` after the
 * browser-approved PKCE exchange, and that file records the `device_id` the
 * Hussh account API issued. Correlating it with
 * `GET /api/account/trusted-devices` is what lets the app say "the Hermes I can
 * reach IS this registered device" — reachability alone proves only that some
 * process is listening on a port.
 *
 * Deliberately narrow: this reads two identity/lock fields and nothing else.
 * The same directory holds vault envelope material, which must never be read
 * here, returned to a caller, or logged.
 */

import "server-only";

import { readFile } from "node:fs/promises";
import path from "node:path";

import { resolveHermesProfileDir } from "./config";
import type { HermesLocalIdentity } from "./types";

const UNAVAILABLE: HermesLocalIdentity = {
  deviceId: null,
  environment: null,
  vaultLocked: null,
  unavailableReason: "No local Hermes profile found. Run `/hussh-one connect` in Hermes.",
};

async function readJsonFile(filePath: string): Promise<Record<string, unknown> | null> {
  try {
    const raw = await readFile(filePath, "utf8");
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

export async function readHermesLocalIdentity(
  env: NodeJS.ProcessEnv = process.env,
): Promise<HermesLocalIdentity> {
  const profileDir = path.join(resolveHermesProfileDir(env), "hussh-one");

  const identity = await readJsonFile(path.join(profileDir, "identity.json"));
  if (!identity) return UNAVAILABLE;

  const deviceId = asString(identity.device_id);
  if (!deviceId) {
    return {
      ...UNAVAILABLE,
      unavailableReason:
        "The local Hermes profile has no device_id. Re-run `/hussh-one connect` to re-enroll.",
    };
  }

  const lockState = await readJsonFile(path.join(profileDir, "vault-lock-state.json"));
  const locked = lockState && typeof lockState.locked === "boolean" ? lockState.locked : null;

  return {
    deviceId,
    environment: asString(identity.environment),
    vaultLocked: locked,
    unavailableReason: null,
  };
}
