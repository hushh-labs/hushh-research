#!/usr/bin/env node

/**
 * Structural check on every Mermaid diagram in the docs.
 *
 * A diagram that renders *something* looks correct at a glance, which is exactly
 * why these defects survive review: the reader sees boxes and arrows and assumes
 * they are the boxes and arrows the author drew. Three classes were found live in
 * this repo and each one is silent:
 *
 *   1. An edge naming a node that is never declared. Mermaid invents an empty box
 *      rather than failing, so `One --> Ria` with no `Ria[...]` renders a blank
 *      node beside four labelled ones and reads as a rendering glitch.
 *   2. `<word>` inside a label. GitHub renders labels as HTML, so
 *      `/one/setup/<capability>` displays as `/one/setup/` — the most important
 *      part of the label is the part that disappears.
 *   3. `>` inside an UNQUOTED label. `>` is Mermaid's odd-shape node syntax
 *      (`id>text]`), so this is a parser risk rather than a rendering one.
 *
 * Deliberately NOT flagged: a lone `>` inside a quoted label. It renders as plain
 * text, and flagging it produced nine findings of which only two were real — a
 * checker that cries wolf gets muted, which costs more than it saves.
 *
 * This is a structural check, not a renderer. It cannot tell you a diagram is
 * *wrong*, only that it will not draw what the source says.
 */

const fs = require("node:fs");
const path = require("node:path");

const DEFAULT_SCAN_ROOTS = ["docs", "consent-protocol/docs", "hushh-webapp/docs"];
const IGNORED_DIRS = new Set(["node_modules", ".next", ".git", ".venv", "dist", "build"]);

const BLOCK = /```mermaid\n([\s\S]*?)```/g;
const LABEL = /\[([^\]]*)\]|\(([^)]*)\)|\{([^}]*)\}/g;
const DECL = /(?:^|\s|-->|---)([A-Za-z_][A-Za-z0-9_]*)\s*[[({]/g;
const SUBGRAPH = /^\s*subgraph\s+([A-Za-z_][A-Za-z0-9_]*)/;
const EDGE_SPLIT = /-\.->|-->|---|==>|-\.-/;
const BR = /<br\s*\/?>/g;
const BRACKET_PAIRS = [
  ["[", "]"],
  ["(", ")"],
  ["{", "}"],
];

function walkMarkdown(workspaceRoot, relTarget) {
  const fullTarget = path.join(workspaceRoot, relTarget);
  if (!fs.existsSync(fullTarget)) return [];
  // A scan root may be a single file, same as verify-doc-links.cjs allows.
  if (fs.statSync(fullTarget).isFile()) {
    return relTarget.endsWith(".md") ? [relTarget.replace(/\\/g, "/")] : [];
  }
  const out = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (IGNORED_DIRS.has(entry.name)) continue;
        walk(full);
      } else if (entry.name.endsWith(".md")) {
        out.push(path.relative(workspaceRoot, full).replace(/\\/g, "/"));
      }
    }
  };
  walk(fullTarget);
  return out;
}

/** Every label on one line, with the entities and `<br/>` already discounted. */
function labelsIn(line) {
  const out = [];
  LABEL.lastIndex = 0;
  let match;
  while ((match = LABEL.exec(line)) !== null) {
    const raw = match[1] ?? match[2] ?? match[3];
    if (raw === undefined) continue;
    const trimmed = raw.trim();
    out.push({
      text: raw.replace(/&lt;/g, "").replace(/&gt;/g, "").replace(BR, ""),
      quoted: trimmed.length > 1 && trimmed.startsWith('"') && trimmed.endsWith('"'),
    });
  }
  return out;
}

function checkBlock(where, source, findings) {
  const lines = source.split("\n").filter((ln) => ln.trim() && !ln.trim().startsWith("%%"));
  if (lines.length === 0) return;
  const kind = lines[0].trim().split(/\s+/)[0];

  for (const line of lines) {
    for (const { text, quoted } of labelsIn(line)) {
      if (/<[A-Za-z/]/.test(text)) {
        findings.push(`${where}: '<tag>' in a label is dropped by htmlLabels -> ${line.trim()}`);
      } else if (text.includes("<")) {
        findings.push(`${where}: raw '<' in a label -> ${line.trim()}`);
      }
      if (text.includes(">") && !quoted) {
        findings.push(`${where}: '>' in an UNQUOTED label -> ${line.trim()}`);
      }
    }
    for (const [open, close] of BRACKET_PAIRS) {
      if (line.split(open).length !== line.split(close).length) {
        findings.push(`${where}: unbalanced ${open}${close} -> ${line.trim()}`);
      }
    }
    if ((line.split('"').length - 1) % 2 !== 0) {
      findings.push(`${where}: odd number of " -> ${line.trim()}`);
    }
  }

  // Undeclared-node detection only makes sense where nodes are declared inline.
  if (kind !== "flowchart" && kind !== "graph") return;

  const declared = new Set();
  for (const line of lines) {
    const subgraph = SUBGRAPH.exec(line);
    if (subgraph) declared.add(subgraph[1]);
    DECL.lastIndex = 0;
    let decl;
    while ((decl = DECL.exec(line)) !== null) declared.add(decl[1]);
  }

  for (const line of lines.slice(1)) {
    if (SUBGRAPH.test(line) || line.trim() === "end") continue;
    // Strip labels and edge captions first, or their contents get read as ids.
    const bare = line.replace(LABEL, "").replace(/\|[^|]*\|/g, "");
    if (!EDGE_SPLIT.test(bare)) continue;
    for (const part of bare.split(EDGE_SPLIT)) {
      const token = part.trim();
      if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(token) && !declared.has(token)) {
        findings.push(`${where}: edge references undeclared node '${token}'`);
      }
    }
  }
}

function runDiagramCheck({ workspaceRoot, scanRoots = DEFAULT_SCAN_ROOTS } = {}) {
  const root = workspaceRoot || path.resolve(__dirname, "..");
  const files = scanRoots.flatMap((target) => walkMarkdown(root, target)).sort();
  const findings = [];
  let blocks = 0;

  for (const relPath of files) {
    const text = fs.readFileSync(path.join(root, relPath), "utf8");
    BLOCK.lastIndex = 0;
    let block;
    let index = 0;
    while ((block = BLOCK.exec(text)) !== null) {
      index += 1;
      blocks += 1;
      checkBlock(`${relPath} block#${index}`, block[1], findings);
    }
  }

  return { ok: findings.length === 0, findings, files: files.length, blocks };
}

module.exports = { runDiagramCheck };

if (require.main === module) {
  const result = runDiagramCheck();
  if (!result.ok) {
    console.error(result.findings.join("\n"));
    console.error(`\nverify-doc-diagrams: ${result.findings.length} finding(s)`);
    process.exit(1);
  }
  // Report the BLOCK count, not just the file count. "219 files clean" reads the
  // same whether 101 diagrams passed or the block regex matched nothing at all.
  console.log(`verify-doc-diagrams: ${result.blocks} diagram(s) in ${result.files} file(s) clean`);
}
