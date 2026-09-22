#!/usr/bin/env node
/**
 * Print the reviewer uid the target backend actually mints for the configured
 * reviewer passphrase.
 *
 * The env files carry a REVIEWER_UID that drifts from what each lane's
 * backend mints (UAT and the local backend each mint their own). Pinning the
 * env value stalls the native test bootstrap with identity_mismatch; pinning
 * nothing leaves the bridge's expectedUserId empty, which switches off the
 * native phone-mandate bypass and the reviewer lands on /register-phone.
 * Asking the backend removes the guess.
 *
 * Reads REVIEWER_VAULT_PASSPHRASE (or HUSHH_UI_TEST_REVIEWER_VAULT_PASSPHRASE)
 * from the process environment only and never prints it. The backend URL comes
 * from PERF_BACKEND_URL, else the compiled native bundle, else the native env
 * file. Output is the uid alone on stdout.
 */
import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const passphrase =
  process.env.HUSHH_UI_TEST_REVIEWER_VAULT_PASSPHRASE || process.env.REVIEWER_VAULT_PASSPHRASE || "";
if (!passphrase) {
  console.error("resolve-reviewer-uid: no reviewer passphrase in the environment.");
  process.exit(1);
}

function backendFromBundle() {
  const chunks = path.join(root, "ios/App/App/public/_next/static/chunks");
  if (!fs.existsSync(chunks)) return "";
  const urls = new Map();
  for (const name of fs.readdirSync(chunks)) {
    if (!name.endsWith(".js")) continue;
    const source = fs.readFileSync(path.join(chunks, name), "utf8");
    for (const match of source.matchAll(/https?:\/\/[a-z0-9.-]+(?::\d+)?/g)) {
      const url = match[0];
      if (/consent-protocol|localhost:8\d{3}|127\.0\.0\.1:8\d{3}/.test(url)) {
        urls.set(url, (urls.get(url) ?? 0) + 1);
      }
    }
  }
  return [...urls.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? "";
}

function backendFromEnvFile() {
  const file = path.join(root, ".env.native.ios.local");
  if (!fs.existsSync(file)) return "";
  const line = fs.readFileSync(file, "utf8").split("\n").find((l) => l.startsWith("NEXT_PUBLIC_BACKEND_URL="));
  return line ? line.slice("NEXT_PUBLIC_BACKEND_URL=".length).trim().replace(/^["']|["']$/g, "") : "";
}

const backend = (process.env.PERF_BACKEND_URL || backendFromBundle() || backendFromEnvFile()).replace(/\/$/, "");
if (!backend) {
  console.error("resolve-reviewer-uid: could not determine the backend URL (set PERF_BACKEND_URL).");
  process.exit(1);
}

// Operator script, not an app surface: it talks to the backend directly.
// eslint-disable-next-line no-restricted-syntax
const response = await fetch(`${backend}/api/app-config/review-mode/session`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ subject: "reviewer", smoke_passphrase: passphrase }),
  signal: AbortSignal.timeout(30_000),
});
const payload = await response.json().catch(() => ({}));
if (!response.ok) {
  console.error(`resolve-reviewer-uid: ${backend} answered ${response.status} (${payload.detail ?? payload.error ?? "no detail"}).`);
  process.exit(1);
}
if (typeof payload.reviewer_uid === "string" && payload.reviewer_uid) {
  process.stdout.write(`${payload.reviewer_uid}\n`);
  process.exit(0);
}
const token = typeof payload.token === "string" ? payload.token : "";
const claims = token.split(".")[1];
if (!claims) {
  console.error("resolve-reviewer-uid: the session response carried no token.");
  process.exit(1);
}
const uid = JSON.parse(Buffer.from(claims, "base64url").toString("utf8")).uid;
if (typeof uid !== "string" || !uid) {
  console.error("resolve-reviewer-uid: the token carried no uid claim.");
  process.exit(1);
}
console.error(`resolve-reviewer-uid: ${backend} mints the reviewer as ${uid}`);
process.stdout.write(`${uid}\n`);
