import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { expect, it } from "vitest";

it("preserves sub-centisecond measurements and medians without changing frame counts", () => {
  const directory = mkdtempSync(join(tmpdir(), "hushh-xcresult-metrics-"));
  try {
    const bundle = join(directory, "public-fixture.xcresult");
    const output = join(directory, "summary.json");
    mkdirSync(bundle);
    const metrics = [{
      testIdentifier: "PublicGesture",
      testRuns: [{
        device: { deviceName: "public-fixture" },
        metrics: [
          { displayName: "Hitch duration", unitOfMeasurement: "s", measurements: [0.004, 0.006] },
          { displayName: "Frame count", unitOfMeasurement: "frames", measurements: [0, 1, 0] },
        ],
      }],
    }];
    // Substitute only Apple's export boundary; exercise the production CLI.
    writeFileSync(join(directory, "xcrun"),
      `#!/usr/bin/env node\nconsole.log(${JSON.stringify(JSON.stringify(metrics))});\n`,
      { mode: 0o700 });
    const result = spawnSync(process.execPath, [
      resolve(__dirname, "../../scripts/perf/summarize-xcresult-metrics.mjs"), bundle, "--json", output,
    ], {
      encoding: "utf8",
      timeout: 5_000,
      env: { ...process.env, PATH: `${directory}${delimiter}${process.env.PATH ?? ""}` },
    });
    expect(result.status, result.stderr).toBe(0);
    const report = JSON.parse(readFileSync(output, "utf8"));
    expect(report.rows[0]).toMatchObject({ iterations: [0.004, 0.006], median: 0.005, unit: "s" });
    expect(report.rows[1]).toMatchObject({ iterations: [0, 1, 0], median: 0, unit: "frames" });
    expect(result.stdout).toContain("| 0.004, 0.006 | 0.005 |");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
