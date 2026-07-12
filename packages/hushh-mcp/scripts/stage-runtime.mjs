import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const packageDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = path.resolve(packageDir, "..", "..");
const sourceRoot = path.join(repoRoot, "consent-protocol");
const vendorRoot = path.join(packageDir, "vendor");
const targetRoot = path.join(vendorRoot, "consent-protocol");

const copyList = [
  ".env.example",
  "mcp_server.py",
  "requirements.txt",
  "mcp_modules",
  "hushh_mcp",
  "db",
];

const ignoredNames = new Set([
  ".DS_Store",
  ".env",
  ".pytest_cache",
  ".mypy_cache",
  ".ruff_cache",
  "__pycache__",
]);

const ignoredDirectories = new Set(["migrations", "schema_contract"]);

function resetDir(dir) {
  fs.rmSync(dir, { force: true, recursive: true });
  fs.mkdirSync(dir, { recursive: true });
}

function shouldSkip(sourcePath) {
  const name = path.basename(sourcePath);
  if (ignoredNames.has(name)) {
    return true;
  }

  if (fs.statSync(sourcePath).isDirectory() && ignoredDirectories.has(name)) {
    return true;
  }

  return false;
}

function copyRecursively(sourcePath, targetPath) {
  if (shouldSkip(sourcePath)) {
    return;
  }

  const stats = fs.statSync(sourcePath);
  if (stats.isDirectory()) {
    fs.mkdirSync(targetPath, { recursive: true });
    for (const entry of fs.readdirSync(sourcePath)) {
      copyRecursively(
        path.join(sourcePath, entry),
        path.join(targetPath, entry),
      );
    }
    return;
  }

  if (stats.isFile()) {
    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    fs.copyFileSync(sourcePath, targetPath);
  }
}

if (!fs.existsSync(path.join(sourceRoot, "mcp_server.py"))) {
  throw new Error(`consent-protocol runtime not found at ${sourceRoot}`);
}

resetDir(targetRoot);

for (const entry of copyList) {
  copyRecursively(path.join(sourceRoot, entry), path.join(targetRoot, entry));
}

const manifestPath = path.join(vendorRoot, "runtime-manifest.json");
fs.writeFileSync(
  manifestPath,
  JSON.stringify(
    {
      packageVersion: JSON.parse(
        fs.readFileSync(path.join(packageDir, "package.json"), "utf8"),
      ).version,
      copyList,
    },
    null,
    2,
  ),
);
