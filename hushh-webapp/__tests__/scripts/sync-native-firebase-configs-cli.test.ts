import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

describe("native Firebase config sync CLI", () => {
  it("runs as a direct Node entrypoint on the host platform", () => {
    const fixtureRoot = mkdtempSync(
      path.join(tmpdir(), "hushh-native-firebase-cli-"),
    );
    const appRoot = path.join(fixtureRoot, "hushh-webapp");
    const destination = path.join(
      appRoot,
      "android",
      "app",
      "google-services.json",
    );
    const scriptPath = path.join(
      process.cwd(),
      "scripts",
      "native",
      "sync-native-firebase-configs.mjs",
    );

    try {
      mkdirSync(appRoot, { recursive: true });
      writeFileSync(path.join(appRoot, "capacitor.config.ts"), "export {};\n");
      writeFileSync(
        path.join(fixtureRoot, "google-services.json"),
        JSON.stringify({
          project_info: { project_id: "fixture-project" },
          client: [
            {
              client_info: {
                android_client_info: { package_name: "com.hussh.app" },
              },
            },
          ],
        }),
      );

      const output = execFileSync(
        process.execPath,
        [scriptPath, "--platform", "android"],
        {
          cwd: appRoot,
          encoding: "utf8",
          stdio: "pipe",
        },
      );

      expect(output).toContain("Native Firebase configs ready (android;");
      expect(JSON.parse(readFileSync(destination, "utf8"))).toMatchObject({
        project_info: { project_id: "fixture-project" },
        client: [
          {
            client_info: {
              android_client_info: { package_name: "com.hussh.app" },
            },
          },
        ],
      });
    } finally {
      rmSync(fixtureRoot, { recursive: true, force: true });
    }
  });
});
