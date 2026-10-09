import { spawn } from "node:child_process";
import path from "node:path";

/** Private pipe adapter; credentials and issued tokens never become artifacts. */
export function createOperatorReviewerTokenProvider({ repoRoot, appOrigin, reviewerBindingFile, timeoutMs = 55_000 }) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 180_000) {
    throw new Error("Operator reviewer timeout budget refused.");
  }
  return requestedUid => new Promise((resolve, reject) => {
    const child = spawn(path.join(repoRoot, "consent-protocol/.venv/bin/python"),
      [path.join(repoRoot, ".codex/skills/reviewer-app-testing/scripts/reviewer_operator_token.py")],
      { cwd: repoRoot, stdio: ["pipe", "pipe", "pipe"] });
    let token = "";
    let failed = false;
    let terminationTimer;
    const fail = () => {
      if (failed) return;
      failed = true;
      token = "";
      clearTimeout(timer);
      child.stdin.destroy();
      child.kill("SIGTERM");
      // The promise settles only after close, so another attempt cannot overlap
      // a retired issuer. Escalate only this owned child after a bounded grace.
      terminationTimer = setTimeout(() => child.kill("SIGKILL"), 1_000);
    };
    const timer = setTimeout(fail, timeoutMs);
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", part => {
      if (failed) return;
      token += part;
      if (token.length > 16_000) fail();
    });
    child.stderr.resume();
    child.on("error", fail);
    child.on("close", code => {
      clearTimeout(timer);
      clearTimeout(terminationTimer);
      if (failed || code !== 0 || !token.trim()) {
        token = "";
        reject(new Error("Operator reviewer token unavailable."));
        return;
      }
      resolve(token.trim()); token = "";
    });
    child.stdin.on("error", fail);
    child.stdin.end(JSON.stringify({ app_origin: appOrigin, reviewer_binding_file: reviewerBindingFile, requested_uid: requestedUid }));
  });
}
