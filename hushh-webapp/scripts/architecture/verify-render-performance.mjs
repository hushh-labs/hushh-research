#!/usr/bin/env node
/**
 * Render-performance ratchet.
 *
 * Catches the patterns that measurably cost frames on WKWebView and Android
 * WebView, most of which no CSS-only scan can see: custom-property writes on
 * <html> inside scroll or frame handlers, body-wide subtree observers,
 * non-passive touch listeners on window, blanket will-change, animated
 * layout properties, charts that animate by default, and the layer ladder.
 *
 * The allowlist beside this script carries today's debt as
 * { rule: { path: count } }. A run fails when a file's count exceeds its
 * entry (a new or worsened violation) and also when an entry exceeds the
 * actual count (the debt shrank and the allowlist must follow), so the
 * ratchet only ever tightens. `--write-allowlist` rewrites it from the
 * current tree; use it once when adopting the rule set, and after paying
 * debt down. A line ending in
 *   // perf-lint: allow <rule-id> -- <reason>
 * (or the line above it) is not counted for that rule.
 *
 * Runs from the web app root (process.cwd()), like the other verifiers, so
 * a test can point it at a fixture tree.
 */
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(process.cwd());
const args = new Set(process.argv.slice(2));
const allowlistPath = path.join(root, "scripts/architecture/render-performance-allowlist.json");
const SCAN_DIRS = ["app", "components", "lib", "hooks"];
const SKIP_DIRS = new Set(["node_modules", ".next", ".next-native-uat", "out", "public", "__tests__", "e2e"]);

function walk(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      walk(path.join(dir, entry.name), out);
    } else if (/\.(tsx?|jsx?|css)$/.test(entry.name) && !/\.test\.[tj]sx?$/.test(entry.name)) {
      out.push(path.join(dir, entry.name));
    }
  }
  return out;
}

function suppressed(lines, index, ruleId) {
  const marker = new RegExp(`perf-lint:\\s*allow\\s+${ruleId}\\b`);
  return marker.test(lines[index] ?? "") || marker.test(lines[index - 1] ?? "");
}

function isCommentLine(line) {
  const trimmed = line.trim();
  return trimmed.startsWith("//") || trimmed.startsWith("/*") || trimmed.startsWith("*");
}

/** Each rule returns the 0-based line indexes it flags in `source`. */
const RULES = [
  {
    id: "transition-all",
    files: /\.(tsx?|jsx?|css)$/,
    reason: "transition-all animates every property, most of them off the compositor.",
    find: (lines) => lines.flatMap((line, i) => (/\btransition-all\b/.test(line) && !isCommentLine(line) ? [i] : [])),
  },
  {
    id: "transition-geometric",
    files: /\.(tsx?|jsx?)$/,
    reason: "A transition on height/width/top/left/margin/padding relayouts every frame; use transform or grid-template-rows.",
    find: (lines) =>
      lines.flatMap((line, i) =>
        /transition-\[[^\]]*\b(height|max-height|width|top|bottom|left|right|margin|padding)\b[^\]]*\]/.test(line) &&
        !/grid-template-rows/.test(line) &&
        !isCommentLine(line)
          ? [i]
          : [],
      ),
  },
  {
    id: "root-custom-property-write",
    files: /\.(tsx?|jsx?)$/,
    reason: "A custom-property write on <html> invalidates style for the whole document; per-frame writers (scroll chrome, gestures) must write on the element that consumes the value. The allowlist carries today's writers; relocations tighten it.",
    find: (lines) =>
      lines.flatMap((line, i) =>
        /(documentElement|\broot)\.style\.setProperty\(\s*["'`]--/.test(line) && !isCommentLine(line) ? [i] : [],
      ),
  },
  {
    id: "body-subtree-mutation-observer",
    files: /\.(tsx?|jsx?)$/,
    reason: "A subtree MutationObserver on document.body wakes on every DOM change anywhere (each streamed token); observe the owning element or use explicit triggers.",
    find: (lines) =>
      lines.flatMap((line, i) => {
        if (!/\.observe\(\s*(document\.body|document\.documentElement|document)\s*,/.test(line)) return [];
        const block = lines.slice(i, i + 8).join("\n");
        return /subtree:\s*true/.test(block) ? [i] : [];
      }),
  },
  {
    id: "non-passive-touch-on-root",
    files: /\.(tsx?|jsx?)$/,
    reason: "A non-passive touchmove/touchstart/wheel on window or document makes WebKit wait for the main thread on every scroll frame in the app.",
    find: (lines) =>
      lines.flatMap((line, i) => {
        if (!/(window|document)\.addEventListener\(\s*["'](touchmove|touchstart|wheel)["']/.test(line)) return [];
        const block = lines.slice(i, i + 6).join("\n");
        return /passive:\s*false/.test(block) ? [i] : [];
      }),
  },
  {
    id: "global-will-change-selector",
    files: /\.css$/,
    reason: "A wildcard selector that sets will-change pins every match as a compositor layer for the life of the page.",
    find: (lines) => {
      const out = [];
      for (let i = 0; i < lines.length; i += 1) {
        const line = lines[i];
        if (!/(\[class\*=|^\s*\*\s*\{|^\s*\*\s*,)/.test(line) || isCommentLine(line)) continue;
        for (let j = i; j < Math.min(lines.length, i + 12); j += 1) {
          if (/will-change/.test(lines[j])) {
            out.push(i);
            break;
          }
          if (/\}/.test(lines[j])) break;
        }
      }
      return out;
    },
  },
  {
    id: "will-change-backdrop-filter",
    files: /\.(tsx?|jsx?|css)$/,
    reason: "will-change: backdrop-filter holds a backdrop readback layer permanently.",
    find: (lines) => lines.flatMap((line, i) => (/will-change\s*:[^;]*backdrop-filter/.test(line) && !isCommentLine(line) ? [i] : [])),
  },
  {
    id: "permanent-will-change-on-fixed",
    files: /\.(tsx?|jsx?)$/,
    reason: "A fixed overlay with an unconditional will-change holds a full-screen layer even when idle; set will-change for the gesture only.",
    find: (lines) =>
      lines.flatMap((line, i) =>
        /["'`][^"'`]*\bfixed\b[^"'`]*(?<![:\w-])will-change-[^"'`]*["'`]/.test(line) && !isCommentLine(line) ? [i] : [],
      ),
  },
  {
    id: "double-transition-property",
    files: /\.(tsx?|jsx?)$/,
    reason: "transition-transform and transition-opacity both set transition-property; the last one wins. Use transition-[transform,opacity].",
    find: (lines) =>
      lines.flatMap((line, i) =>
        /\btransition-transform\b/.test(line) && /\btransition-opacity\b/.test(line) && !isCommentLine(line) ? [i] : [],
      ),
  },
  {
    id: "recharts-animation-not-disabled",
    files: /\.(tsx|jsx)$/,
    reason: "Recharts animates every series for 1500ms on mount and on each data change; pass isAnimationActive (CHART_ANIMATION_ACTIVE).",
    find: (lines, source) => {
      if (!source.includes('from "recharts"')) return [];
      const out = [];
      const tag = /<(Line|Bar|Area|Pie|Radar|Scatter|RadialBar)(?=[\s\n>/])/g;
      for (const match of source.matchAll(tag)) {
        const end = source.indexOf(">", match.index + match[0].length);
        if (end === -1) continue;
        if (!source.slice(match.index, end).includes("isAnimationActive")) {
          out.push(source.slice(0, match.index).split("\n").length - 1);
        }
      }
      return out;
    },
  },
  {
    id: "recharts-tooltip-touch-tracking",
    files: /\.(tsx|jsx)$/,
    reason: "A Recharts Tooltip with the default trigger attaches onTouchMove and re-renders the chart (after a layout read) on every touch frame; pass trigger={CHART_TOOLTIP_TRIGGER}.",
    find: (lines, source) => {
      if (!source.includes('from "recharts"') && !source.includes("ChartTooltip")) return [];
      const out = [];
      const tag = /<(ChartTooltip|Tooltip)(?=[\s\n>/])/g;
      for (const match of source.matchAll(tag)) {
        const end = source.indexOf(">", match.index + match[0].length);
        if (end === -1) continue;
        const inner = source.slice(match.index, end);
        if (/TooltipProvider|TooltipContent|TooltipTrigger/.test(inner)) continue;
        if (!inner.includes("trigger=")) {
          out.push(source.slice(0, match.index).split("\n").length - 1);
        }
      }
      return out;
    },
  },
  {
    id: "backdrop-filter-on-list-row",
    files: /\.(tsx|jsx)$/,
    reason: "A backdrop blur on a list row moves under every scroll frame; the engine re-reads and re-blurs what is behind it per row per frame. Blur belongs on fixed chrome; rows take a solid surface (plus morphy-liquid-neutral for the rim).",
    find: (lines, source) => {
      // A keyed JSX element is a list row. Flag a backdrop-blur class inside
      // the opening tag of an element that carries key={...}.
      const out = [];
      const tagOpen = /<[A-Za-z][\w.]*(?=[\s\n>])/g;
      for (const match of source.matchAll(tagOpen)) {
        const start = match.index;
        // The opening tag ends at the first ">" that is not inside braces.
        let depth = 0;
        let end = -1;
        for (let i = start; i < source.length; i += 1) {
          const ch = source[i];
          if (ch === "{") depth += 1;
          else if (ch === "}") depth -= 1;
          else if (ch === ">" && depth === 0) { end = i; break; }
        }
        if (end === -1) continue;
        const tag = source.slice(start, end);
        if (!/\bkey=/.test(tag)) continue;
        const hit = tag.search(/backdrop-blur(?!-none)/);
        if (hit === -1) continue;
        const line = source.slice(0, start + hit).split("\n").length - 1;
        if (!isCommentLine(lines[line] ?? "")) out.push(line);
      }
      return out;
    },
  },
  {
    id: "continuous-float-store-in-react",
    files: /\.tsx$/,
    reason: "A component subscribed to a per-frame float (progress/position/offset) re-renders every scroll frame; consume the CSS variable instead.",
    find: (lines) =>
      lines.flatMap((line, i) =>
        /useSyncExternalStore\([^)]*(progress|position|offset|scrollTop|fraction)/i.test(line) && !isCommentLine(line) ? [i] : [],
      ),
  },
  {
    id: "perf-probe-static-import",
    files: /\.(tsx?|jsx?)$/,
    reason: "The frame-pacing sampler must stay behind a dynamic import so a normal session never loads it.",
    find: (lines) =>
      lines.flatMap((line, i) =>
        /^import\s+(?!type\b)[^;]*from\s+["']@\/lib\/perf\/frame-pacing["']/.test(line) ? [i] : [],
      ),
  },
  {
    id: "layer-order-literal",
    files: /^components\/ui\/[^/]+\.tsx$/,
    scopeRelative: true,
    reason: "Floating primitives take their z-index from the --z-* ladder tokens, never a literal.",
    find: (lines) =>
      lines.flatMap((line, i) => (/\bz-\[(?!5\])\d+\]|\bz-50\b/.test(line) && !isCommentLine(line) ? [i] : [])),
  },
];

function scan() {
  const files = SCAN_DIRS.flatMap((dir) => walk(path.join(root, dir)));
  const counts = {};
  const findings = [];
  for (const file of files) {
    const relative = path.relative(root, file).split(path.sep).join("/");
    const raw = fs.readFileSync(file, "utf8");
    // CSS comments are prose; blank them (keeping line numbers) so a comment
    // that quotes a forbidden selector is not a finding.
    const source = file.endsWith(".css")
      ? raw.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
      : raw;
    const lines = source.split(/\r?\n/);
    for (const rule of RULES) {
      const subject = rule.scopeRelative ? relative : file;
      if (!rule.files.test(subject)) continue;
      const hits = rule.find(lines, source).filter((index) => !suppressed(lines, index, rule.id));
      if (!hits.length) continue;
      counts[rule.id] ??= {};
      counts[rule.id][relative] = hits.length;
      for (const index of hits) {
        findings.push({ rule: rule.id, file: relative, line: index + 1, snippet: (lines[index] ?? "").trim().slice(0, 140), reason: rule.reason });
      }
    }
  }
  return { counts, findings };
}

function readAllowlist() {
  if (!fs.existsSync(allowlistPath)) return { schema_version: 1, rules: {} };
  return JSON.parse(fs.readFileSync(allowlistPath, "utf8"));
}

function main() {
  const { counts, findings } = scan();
  if (args.has("--write-allowlist")) {
    const sorted = {};
    for (const rule of Object.keys(counts).sort()) {
      sorted[rule] = Object.fromEntries(Object.entries(counts[rule]).sort(([a], [b]) => a.localeCompare(b)));
    }
    fs.mkdirSync(path.dirname(allowlistPath), { recursive: true });
    fs.writeFileSync(allowlistPath, `${JSON.stringify({ schema_version: 1, rules: sorted }, null, 2)}\n`);
    console.log(`render-performance: allowlist written (${findings.length} known findings across ${Object.keys(counts).length} rules).`);
    return;
  }
  const allow = readAllowlist().rules ?? {};
  const problems = [];
  for (const rule of RULES) {
    const actual = counts[rule.id] ?? {};
    const allowed = allow[rule.id] ?? {};
    for (const [file, count] of Object.entries(actual)) {
      const budget = allowed[file] ?? 0;
      if (count > budget) {
        const lines = findings.filter((f) => f.rule === rule.id && f.file === file).map((f) => `      ${file}:${f.line}  ${f.snippet}`);
        problems.push(`  [${rule.id}] ${file}: ${count} finding(s), allowlist permits ${budget}\n      ${rule.reason}\n${lines.join("\n")}`);
      }
    }
    for (const [file, budget] of Object.entries(allowed)) {
      const count = actual[file] ?? 0;
      if (budget > count) {
        problems.push(`  [${rule.id}] ${file}: allowlist permits ${budget} but only ${count} remain. Tighten the entry (or run --write-allowlist) so the ratchet keeps the gain.`);
      }
    }
  }
  if (problems.length) {
    console.error(`render-performance: ${problems.length} problem(s)\n${problems.join("\n\n")}`);
    process.exit(1);
  }
  console.log(`render-performance: OK (${findings.length} known findings held by the allowlist, ${RULES.length} rules).`);
}

main();
