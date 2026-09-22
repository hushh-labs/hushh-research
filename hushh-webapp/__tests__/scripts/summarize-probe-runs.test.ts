import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const script = resolve(__dirname, "../../scripts/perf/summarize-probe-runs.mjs");

let fixture: string;

function window(kind: string, start: number) {
  return {
    id: `w-${start}`,
    kind,
    route: "/one/feed/",
    start_epoch_ms: start,
    end_epoch_ms: start + 900,
    frames: 100,
    p95_ms: 8,
    p99_ms: 8,
    max_ms: 12,
    over_50_count: 0,
    raf_hitch_ms_per_s: 0,
  };
}

function summarize(gestureName: string, kinds: string[]) {
  const windows = kinds.map((kind, i) => window(kind, 1_000 + i * 1_000));
  writeFileSync(
    join(fixture, "probe.json"),
    JSON.stringify({
      run_id: "fixture",
      started_at_epoch_ms: 1,
      platform: "android",
      raf_hz: { raw: 119.8, nominal: 120, budget_ms: 8.3 },
      windows,
      idle_by_route: [],
    }),
  );
  writeFileSync(
    join(fixture, "gestures.log"),
    `PERF_GESTURE name=${gestureName} rep=0 start_epoch_ms=1000 end_epoch_ms=${1_000 + kinds.length * 1_000}\n`,
  );
  const out = join(fixture, "summary.json");
  const result = spawnSync(
    process.execPath,
    [
      script,
      "--runs", join(fixture, "probe.json"),
      "--gestures", join(fixture, "gestures.log"),
      "--tier", "android-flagship-2024",
      "--configuration", "Release",
      "--test-mode", "0",
      "--json", out,
      "--md", join(fixture, "summary.md"),
    ],
    { encoding: "utf8" },
  );
  expect(result.status, result.stderr).toBe(0);
  return {
    json: JSON.parse(readFileSync(out, "utf8")),
    md: readFileSync(join(fixture, "summary.md"), "utf8"),
  };
}

describe("summarize-probe-runs: a gesture that moved nothing", () => {
  beforeEach(() => {
    fixture = mkdtempSync(join(tmpdir(), "hushh-perf-summary-"));
  });

  afterEach(() => {
    rmSync(fixture, { recursive: true, force: true });
  });

  it("reports a flick whose windows are all taps as not measured, and certifies nothing", () => {
    // The Android card on the vault gate: every flick landed on a screen
    // that does not scroll, and the numbers read 8 ms at 120 Hz.
    const { json, md } = summarize("feed-flick", ["tap", "tap", "tap"]);
    expect(json.gestures[0]).toMatchObject({ name: "feed-flick", measured: false, verdict: "not measured (nothing moved)" });
    expect(json.device.certifies).toBe(false);
    expect(md).toContain("Nothing moved during feed-flick");
  });

  it("keeps a flick that scrolled, and the run certifies", () => {
    const { json } = summarize("feed-flick", ["scroll", "scroll", "tap"]);
    expect(json.gestures[0]).toMatchObject({ measured: true, verdict: "good" });
    expect(json.device.certifies).toBe(true);
  });

  it.each(["bottom-nav-switch", "top-shell-pager-swipe", "location-map-pan", "profile-pane-open-dismiss"])(
    "applies the rule to %s",
    (name) => {
      expect(summarize(name, ["tap", "tap"]).json.gestures[0].measured).toBe(false);
    },
  );

  it("does not call a gesture with no probe windows good", () => {
    // Threads and X: HWUI numbers only, the probe runs in our app.
    expect(summarize("threads-feed-flick", []).json.gestures[0].verdict).toBe("no probe windows");
  });

  it("leaves a gesture that is a tap by nature alone", () => {
    const { json } = summarize("chat-keyboard-show", ["tap", "tap"]);
    expect(json.gestures[0].measured).toBe(true);
    expect(json.device.certifies).toBe(true);
  });
});
