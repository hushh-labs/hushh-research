// @vitest-environment node
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { syncNativeUiTestRunner, writeNativeUiFlowsManifest } from "../../scripts/native/prepare-native-test-artifacts.mjs";

vi.mock("node:child_process", () => ({ execSync: vi.fn() }));
const roots: string[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

it.each(["", "isolated-export", "absolute"])("writes fresh artifacts to the selected Capacitor output: %s", (selection) => {
  const root = mkdtempSync(join(tmpdir(), "native-artifacts-"));
  roots.push(root);
  const output = selection === "absolute" ? join(root, "absolute-export") : join(root, selection || "out");
  vi.stubEnv("NEXT_DIST_DIR", selection === "absolute" ? output : selection);
  mkdirSync(join(root, "scripts/native"), { recursive: true });
  writeFileSync(join(root, "scripts/native/native-ui-test-runner-source.js"), "// synthetic runner\n");
  const manifest = writeNativeUiFlowsManifest({ repoRoot: root });
  syncNativeUiTestRunner({ repoRoot: root });
  expect(manifest.flowsPublicPath).toBe(join(output, "native-ui-flows.json"));
  expect(JSON.parse(readFileSync(manifest.flowsPublicPath, "utf8"))).toBeTruthy();
  expect(readFileSync(join(output, "native-ui-test-runner.js"), "utf8")).toBe("// synthetic runner\n");
  if (selection) expect(existsSync(join(root, "out"))).toBe(false);
});
