import { spawn } from "node:child_process";
import path from "node:path";

/** Private pipe adapter; credentials and issued tokens never become artifacts. */
export function createOperatorReviewerTokenProvider({ repoRoot, appOrigin, reviewerBindingFile }) {
  return requestedUid => new Promise((resolve, reject) => {
    const child = spawn(path.join(repoRoot, "consent-protocol/.venv/bin/python"),
      [path.join(repoRoot, ".codex/skills/reviewer-app-testing/scripts/reviewer_operator_token.py")],
      { cwd: repoRoot, stdio: ["pipe", "pipe", "pipe"] });
    let token = "";
    const fail = () => reject(new Error("Operator reviewer token unavailable."));
    const timer = setTimeout(() => { child.kill(); fail(); }, 55_000);
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", part => {
      token += part;
      if (token.length > 16_000) { child.kill(); fail(); }
    });
    child.stderr.resume();
    child.on("error", () => { clearTimeout(timer); fail(); });
    child.on("close", code => {
      clearTimeout(timer);
      if (code !== 0 || !token.trim()) { token = ""; fail(); return; }
      resolve(token.trim()); token = "";
    });
    child.stdin.on("error", fail);
    child.stdin.end(JSON.stringify({ app_origin: appOrigin, reviewer_binding_file: reviewerBindingFile, requested_uid: requestedUid }));
  });
}
