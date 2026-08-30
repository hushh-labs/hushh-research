import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const defaultRepoRoot = path.resolve(__dirname, "../../../..");

function configuredValue(value) {
  const trimmed = String(value || "").trim();
  return !trimmed || /replace_with_|placeholder|your_[a-z0-9_]+_here/i.test(trimmed)
    ? ""
    : trimmed;
}

function secretManagerValue(project, secret) {
  return execFileSync(
    "gcloud",
    ["secrets", "versions", "access", "latest", `--secret=${secret}`, `--project=${project}`],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  ).trim();
}

async function loadIdentityModule(repoRoot) {
  return import(
    pathToFileURL(
      path.join(repoRoot, "hushh-webapp", "scripts/testing/reviewer-test-identity.mjs"),
    ).href,
  );
}

function normalizedOrigin(value) {
  return String(value || "https://uat.one.hushh.ai").replace(/\/$/, "");
}

function isLocalOrigin(appOrigin) {
  const host = new URL(appOrigin).hostname;
  return host === "localhost" || host === "127.0.0.1";
}

export async function prepareReviewerRehearsal({
  appOrigin = normalizedOrigin(process.env.REVIEWER_APP_ORIGIN),
  repoRoot = defaultRepoRoot,
  secretProject = configuredValue(process.env.REVIEWER_SECRET_PROJECT),
} = {}) {
  const identityModule = await loadIdentityModule(repoRoot);
  const identityOptions = {
    envFiles: identityModule.defaultReviewerIdentityEnvFiles({
      repoRoot,
      webDir: path.join(repoRoot, "hushh-webapp"),
    }),
  };
  let identitySource = "configured_env";

  const configuredIdentity = identityModule.resolveReviewerTestIdentity({
    ...identityOptions,
    required: false,
  });
  if (!configuredIdentity.reviewerUid || !configuredIdentity.reviewerVaultPassphrase) {
    if (!secretProject) {
      throw new Error(
        "Canonical reviewer identity is unavailable. Set REVIEWER_SECRET_PROJECT to the approved environment project; do not copy reviewer secrets into a command or file.",
      );
    }
    if (!configuredIdentity.reviewerUid) {
      process.env.REVIEWER_UID = secretManagerValue(secretProject, "REVIEWER_UID");
    }
    if (!configuredIdentity.reviewerVaultPassphrase) {
      process.env.REVIEWER_VAULT_PASSPHRASE = secretManagerValue(
        secretProject,
        "REVIEWER_VAULT_PASSPHRASE",
      );
    }
    identitySource = configuredIdentity.reviewerUid
      ? "configured_uid_secret_manager_passphrase_memory"
      : "secret_manager_memory";
  }

  const identity = identityModule.resolveReviewerTestIdentity(identityOptions);
  if (!configuredValue(identity.reviewerUid) || !configuredValue(identity.reviewerVaultPassphrase)) {
    throw new Error("Canonical reviewer identity did not resolve to usable values.");
  }

  const response = await fetch(`${appOrigin}/api/app-config/review-mode`, {
    headers: { Accept: "application/json", "Cache-Control": "no-store" },
  });
  if (!response.ok) {
    throw new Error(`Reviewer review-mode preflight returned HTTP ${response.status}.`);
  }
  const payload = await response.json().catch(() => null);
  if (!payload || payload.enabled !== true) {
    const localInstruction = isLocalOrigin(appOrigin)
      ? " Run bash scripts/env/reviewer_mode.sh enable, restart the backend, then rerun preflight."
      : " Verify the approved environment's review-mode contract before retrying.";
    throw new Error(`Reviewer review-mode is not enabled for ${appOrigin}.${localInstruction}`);
  }

  createRequire(path.join(repoRoot, "hushh-webapp", "package.json")).resolve("playwright");
  return {
    appOrigin,
    identitySource,
    mutationPolicy:
      process.env.REVIEWER_ALLOW_SHARED_MUTATIONS === "true"
        ? "explicit_mutation_authorized"
        : "read_only",
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.includes("--help")) {
    process.stdout.write(
      "Reviewer rehearsal preflight. Set REVIEWER_SECRET_PROJECT for memory-only Secret Manager identity resolution.\n",
    );
  } else {
    const result = await prepareReviewerRehearsal();
    process.stdout.write(
      `[reviewer-app-testing] PREFLIGHT PASS origin=${new URL(result.appOrigin).host} identity=${result.identitySource} mutation_policy=${result.mutationPolicy}\n`,
    );
  }
}
