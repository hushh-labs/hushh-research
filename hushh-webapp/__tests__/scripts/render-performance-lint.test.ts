import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const script = resolve(__dirname, "../../scripts/architecture/verify-render-performance.mjs");

let fixture: string;

function write(relativePath: string, content: string) {
  const full = join(fixture, relativePath);
  mkdirSync(resolve(full, ".."), { recursive: true });
  writeFileSync(full, content);
}

function run(...args: string[]) {
  return spawnSync(process.execPath, [script, ...args], { cwd: fixture, encoding: "utf8" });
}

describe("verify-render-performance", () => {
  beforeEach(() => {
    fixture = mkdtempSync(join(tmpdir(), "hushh-render-perf-"));
    mkdirSync(join(fixture, "scripts/architecture"), { recursive: true });
  });

  afterEach(() => {
    rmSync(fixture, { recursive: true, force: true });
  });

  it("passes a clean tree", () => {
    write("components/clean.tsx", 'export const a = "transition-[transform,opacity] fixed inset-0";\n');
    write("app/globals.css", ".x { transform: none; }\n");
    const result = run();
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("render-performance: OK");
  });

  it.each([
    ["transition-all", "components/a.tsx", 'const c = "transition-all duration-150";\n'],
    ["transition-geometric", "components/b.tsx", 'const c = "transition-[height] duration-150";\n'],
    ["root-custom-property-write", "lib/c.ts", 'document.documentElement.style.setProperty("--x", "1");\n'],
    [
      "body-subtree-mutation-observer",
      "lib/d.ts",
      "const o = new MutationObserver(() => {});\no.observe(document.body, {\n  childList: true,\n  subtree: true,\n});\n",
    ],
    [
      "non-passive-touch-on-root",
      "components/e.tsx",
      'window.addEventListener("touchmove", () => {}, {\n  capture: true,\n  passive: false,\n});\n',
    ],
    ["global-will-change-selector", "app/globals.css", '[class*="backdrop-blur"] {\n  will-change: transform;\n}\n'],
    ["will-change-backdrop-filter", "app/globals.css", ".m {\n  will-change: background-color, backdrop-filter;\n}\n"],
    ["permanent-will-change-on-fixed", "components/f.tsx", 'const c = "fixed inset-0 will-change-transform";\n'],
    ["double-transition-property", "components/g.tsx", 'const c = "transition-transform transition-opacity";\n'],
    [
      "recharts-animation-not-disabled",
      "components/h.tsx",
      'import { Line } from "recharts";\nexport const H = () => <Line dataKey="v" />;\n',
    ],
    [
      "recharts-tooltip-touch-tracking",
      "components/h2.tsx",
      'import { Line, Tooltip } from "recharts";\nexport const H = () => <Tooltip cursor={false} />;\n',
    ],
    [
      "backdrop-filter-on-list-row",
      "components/h3.tsx",
      'export const Rows = ({ rows }) => rows.map((row) => (\n  <li key={row.id} className="rounded-xl backdrop-blur-[16px]">{row.label}</li>\n));\n',
    ],
    ["continuous-float-store-in-react", "components/i.tsx", "const p = useSyncExternalStore(subscribeProgress, getProgress);\n"],
    ["perf-probe-static-import", "components/j.tsx", 'import { startFramePacingProbe } from "@/lib/perf/frame-pacing";\n'],
    ["layer-order-literal", "components/ui/k.tsx", 'const c = "fixed z-[712]";\n'],
  ])("fails on %s", (rule, file, content) => {
    write(file, content);
    const result = run();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(`[${rule}]`);
  });

  it("does not count a comment that quotes a forbidden selector, nor a suppressed line", () => {
    write("app/globals.css", '/* a note about [class*="backdrop-blur"] {\n   will-change: transform } */\n.y { color: red; }\n');
    write(
      "components/l.tsx",
      '// perf-lint: allow transition-all -- one-shot desktop rail\nconst c = "transition-all";\n',
    );
    const result = run();
    expect(result.status, result.stderr).toBe(0);
  });

  it("ratchets: the allowlist holds known debt, fails when it grows, and fails when it goes stale", () => {
    write("components/m.tsx", 'const c = "transition-all";\n');
    expect(run().status).toBe(1);

    const written = run("--write-allowlist");
    expect(written.status, written.stderr).toBe(0);
    const allowlistPath = join(fixture, "scripts/architecture/render-performance-allowlist.json");
    expect(existsSync(allowlistPath)).toBe(true);
    expect(JSON.parse(readFileSync(allowlistPath, "utf8"))).toEqual({
      schema_version: 1,
      rules: { "transition-all": { "components/m.tsx": 1 } },
    });
    expect(run().status).toBe(0);

    // Grows: a second finding in the same file.
    write("components/m.tsx", 'const c = "transition-all";\nconst d = "transition-all";\n');
    const grew = run();
    expect(grew.status).toBe(1);
    expect(grew.stderr).toContain("allowlist permits 1");

    // Shrinks: the debt is paid but the allowlist still permits it.
    write("components/m.tsx", 'const c = "transition-[transform,opacity]";\n');
    const stale = run();
    expect(stale.status).toBe(1);
    expect(stale.stderr).toContain("only 0 remain");
  });
});
