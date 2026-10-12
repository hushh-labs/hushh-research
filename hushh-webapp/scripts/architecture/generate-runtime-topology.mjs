import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const script = path.join(repoRoot, "scripts/ops/generate_runtime_topology_index.py");
const candidates = [
  process.env.HUSHH_CAPABILITY_GRAPH_PYTHON,
  path.join(repoRoot, "consent-protocol/.venv", process.platform === "win32" ? "Scripts/python.exe" : "bin/python"),
  "python3",
].filter(Boolean);
for (const python of candidates) {
  if (python.includes(path.sep) && !existsSync(python)) continue;
  const result = spawnSync(python, [script, ...process.argv.slice(2)], { cwd: repoRoot, stdio: "inherit" });
  if (result.error?.code === "ENOENT") continue;
  if (result.error) throw result.error;
  process.exit(result.status ?? 1);
}
throw new Error("Python is required to regenerate the runtime topology mirror.");
