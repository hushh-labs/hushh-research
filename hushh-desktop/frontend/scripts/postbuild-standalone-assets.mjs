import { existsSync, cpSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const frontendRoot = join(__dirname, "..");
const standaloneRoot = join(frontendRoot, ".next", "standalone", "frontend");

if (!existsSync(standaloneRoot)) {
  console.log("[postbuild] No standalone output found (not a standalone build), skipping.");
  process.exit(0);
}

// Next.js standalone output omits .next/static and public/ by design --
// the standalone server expects them copied in as siblings of server.js.
// https://nextjs.org/docs/app/api-reference/config/next-config-js/output
const copies = [
  [join(frontendRoot, ".next", "static"), join(standaloneRoot, ".next", "static")],
  [join(frontendRoot, "public"), join(standaloneRoot, "public")],
];

for (const [from, to] of copies) {
  if (!existsSync(from)) continue;
  cpSync(from, to, { recursive: true });
  console.log(`[postbuild] Copied ${from} -> ${to}`);
}
