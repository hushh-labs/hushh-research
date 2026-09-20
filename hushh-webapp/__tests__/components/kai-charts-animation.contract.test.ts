import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Every Recharts series declares `isAnimationActive`, and the shared
 * ChartContainer debounces its ResizeObserver.
 *
 * Recharts' default is a 1500ms animation on mount and on every data change
 * (ninety frames of SVG path interpolation per chart), and ResponsiveContainer
 * re-renders the chart on every resize tick, including keyboard and
 * visual-viewport changes during a pane swipe. Kai shows several charts at
 * once on a phone. Series take CHART_ANIMATION_ACTIVE (static inside the
 * native shell, animated on the web); Recharts detects children by component
 * type, so a wrapper component cannot supply this and each site must.
 */

const webRoot = path.resolve(__dirname, "../..");
const read = (relativePath: string) =>
  fs.readFileSync(path.join(webRoot, relativePath), "utf8");

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "__tests__" || entry.name === "node_modules") continue;
      walk(full, out);
    } else if (/\.tsx?$/.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

const SERIES_TAG = /<(Line|Bar|Area|Pie|Radar|Scatter|RadialBar)(?=[\s\n>/])/g;
const TOOLTIP_TAG = /<(ChartTooltip|Tooltip)(?=[\s\n>/])/g;

describe("kai charts animation contract", () => {
  const rechartsFiles = ["components", "app", "lib"]
    .flatMap((dir) => walk(path.join(webRoot, dir)))
    .filter((file) => fs.readFileSync(file, "utf8").includes('from "recharts"'))
    .map((file) => path.relative(webRoot, file));

  it("finds the chart files", () => {
    expect(rechartsFiles.length).toBeGreaterThan(5);
  });

  it.each(rechartsFiles)("%s declares isAnimationActive on every series", (file) => {
    const source = read(file);
    for (const match of source.matchAll(SERIES_TAG)) {
      const end = source.indexOf(">", match.index! + match[0].length);
      const tag = source.slice(match.index!, end);
      expect(tag, `${file}: <${match[1]}> at offset ${match.index}`).toContain(
        "isAnimationActive",
      );
    }
  });

  it.each(rechartsFiles)("%s declares trigger on every Tooltip", (file) => {
    // With the default trigger Recharts attaches onTouchMove and, on every
    // touch frame, reads the container rect and calls setState: a flick
    // across a chart re-renders every path per frame. CHART_TOOLTIP_TRIGGER
    // is "click" inside the native shell, which attaches no touch tracking.
    const source = read(file);
    for (const match of source.matchAll(TOOLTIP_TAG)) {
      const end = source.indexOf(">", match.index! + match[0].length);
      const tag = source.slice(match.index!, end);
      expect(tag, `${file}: <${match[1]}> at offset ${match.index}`).toContain(
        "trigger={CHART_TOOLTIP_TRIGGER}",
      );
    }
  });

  it("debounces the shared ResponsiveContainer", () => {
    const chart = read("components/ui/chart.tsx");
    expect(chart).toContain("export const CHART_ANIMATION_ACTIVE");
    expect(chart).toContain("export const CHART_TOOLTIP_TRIGGER");
    expect(chart).toMatch(
      /<RechartsPrimitive\.ResponsiveContainer debounce=\{CHART_RESIZE_DEBOUNCE_MS\}>/,
    );
  });
});
