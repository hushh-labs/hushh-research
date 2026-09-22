import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The microphone-cadence fields (level, elapsedMs) reach exactly one
 * consumer, through their own context.
 *
 * They used to ride the main LocationCommand context value, which was a fresh
 * object every render, so every level event (up to ~12/s while recording)
 * re-rendered the bottom shell, the command card and the device bridge, none
 * of which show a meter. Only the agent bar's waveform needs them.
 */

const webRoot = path.resolve(__dirname, "../..");
const read = (relativePath: string) =>
  fs.readFileSync(path.join(webRoot, relativePath), "utf8");

describe("location command live split", () => {
  it("provides level/elapsedMs from a dedicated context", () => {
    const provider = read("components/agent/location-command-provider.tsx");
    expect(provider).toContain("LocationCommandLiveContext.Provider value={live}");
    expect(provider).toContain("export function useLocationCommandLive()");
    // The memoised controller value carries neither field.
    const controllerBlock = provider.slice(
      provider.indexOf("const controller = useMemo("),
      provider.indexOf("const live = useMemo<LocationCommandLive>("),
    );
    expect(controllerBlock).not.toMatch(/\blevel,\n/);
    expect(controllerBlock).not.toMatch(/\belapsedMs,\n/);
  });

  it("is read only by the agent bar", () => {
    const bar = read("components/agent/command-agent-bar.tsx");
    expect(bar).toContain("useLocationCommandLive()");
    for (const file of [
      "components/app-ui/app-bottom-shell.tsx",
      "components/agent/location-command-card.tsx",
      "components/one-location/onboarding/location-command-device-bridge.tsx",
    ]) {
      expect(read(file), file).not.toContain("useLocationCommandLive");
    }
  });
});
