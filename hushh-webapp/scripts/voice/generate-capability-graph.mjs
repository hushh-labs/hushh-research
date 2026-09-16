import { existsSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { spawnSync } from "child_process";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../../..");
const backendRoot = path.join(repoRoot, "consent-protocol");
const scriptPath = path.join(backendRoot, "scripts", "generate_capability_graph.py");
const pythonCandidates = [
  process.env.HUSHH_CAPABILITY_GRAPH_PYTHON,
  process.platform === "win32"
    ? path.join(backendRoot, ".venv", "Scripts", "python.exe")
    : path.join(backendRoot, ".venv", "bin", "python"),
  "python3",
].filter(Boolean);

let lastError = null;
for (const python of pythonCandidates) {
  if (python.includes(path.sep) && !existsSync(python)) continue;
  const result = spawnSync(python, [scriptPath, ...process.argv.slice(2)], {
    cwd: backendRoot,
    stdio: "inherit",
  });
  if (result.error?.code === "ENOENT") {
    lastError = result.error;
    continue;
  }
  process.exitCode = result.status ?? 1;
  break;
}

if (process.exitCode === undefined) {
  throw lastError ?? new Error("No Python interpreter was available for CapabilityGraphV1 generation.");
}
