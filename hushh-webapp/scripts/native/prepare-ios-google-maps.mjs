import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// The export bundles the iOS observer cleanup. Capacitor sync prepares the Swift sources.
const webBuild = process.argv.includes("--web");
if (webBuild || process.env.CAPACITOR_PLATFORM_NAME === "ios") {
  const root = fs.realpathSync(fileURLToPath(new URL("../../", import.meta.url)));
  const sdk = path.join(root, "node_modules/@capacitor/google-maps");
  const patch = fileURLToPath(new URL("./ios-google-maps-attachment.patch", import.meta.url));
  const webFiles = [
    ["dist/esm/map.js", "a003d9ddf6fc1eec0230042e430231d66ef5d34eff8c91e346ccdf806cd101c9", "eb867c106534d940e8aba296cc2667f999bce46e876e634016745b3ad236c5fb"],
  ];
  const nativeFiles = [
    ["ios/Sources/CapacitorGoogleMapsPlugin/Map.swift", "5fc96cc299e834c3a63ab3747017a2b106b33da6251262c5d059282ebf1380b9", "01f9527e8543a5b00b6ffcb47952710d399aef3b6240e1fab3639b3e3fb2868b"],
    ["ios/Sources/CapacitorGoogleMapsPlugin/CapacitorGoogleMapsPlugin.swift", "22bd20f33171dbf261c745716144553e45cd5f73aa9b1c55f6a152d2243e487e", "ca796137fe83603c06566e0b875d14c434b387473b239b2f5610fccfa182860b"],
  ];
  const files = webBuild ? webFiles : [...webFiles, ...nativeFiles];
  const digest = (file) => createHash("sha256").update(fs.readFileSync(file)).digest("hex");
  const pending = [];
  for (const [relative, original, patched] of files) {
    const target = path.join(sdk, relative);
    const hash = digest(target);
    if (hash === patched) continue;
    if (hash !== original) throw new Error(`Review the iOS Google Maps attachment patch for ${relative}.`);
    if (fs.realpathSync(target) !== target) throw new Error("Cannot patch a shared Google Maps installation.");
    pending.push({ relative, target, patched });
  }
  if (pending.length) {
    const args = ["apply", ...pending.map(({ relative }) => `--include=${relative}`)];
    const options = { cwd: sdk, env: { ...process.env, GIT_CEILING_DIRECTORIES: path.dirname(sdk) } };
    execFileSync("git", [...args, "--check", patch], options);
    execFileSync("git", [...args, patch], options);
    for (const { target, patched } of pending) {
      if (digest(target) !== patched) throw new Error("iOS Google Maps attachment patch verification failed.");
    }
  }
}
