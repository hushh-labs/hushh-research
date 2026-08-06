#!/usr/bin/env node

/**
 * Proves `verify-doc-diagrams` still detects what it claims to detect.
 *
 * A structural checker fails silently in the one way that matters: if its block
 * regex stops matching, every run reports "clean" forever and the gate becomes a
 * decoration. That is not hypothetical — the first version of this checker was
 * refined twice, and each refinement could have turned a real finding into a pass.
 *
 * So this asserts both directions on fixtures: the four defects are caught, and
 * the three lookalike-but-correct forms are NOT. The second half is the half that
 * keeps the checker usable; over-reporting is how a gate gets muted.
 */

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { runDiagramCheck } = require("./verify-doc-diagrams.cjs");

function writeFixture(root, relativePath, body) {
  const target = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, body, "utf8");
}

function assert(condition, message) {
  if (!condition) {
    console.error(`Doc diagram smoke failed: ${message}`);
    process.exit(1);
  }
}

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "hushh-doc-diagrams-"));

try {
  // Every form here is correct, and each one resembles a defect closely enough
  // that a blunter checker would flag it.
  writeFixture(
    tempRoot,
    "clean/ok.md",
    [
      "```mermaid",
      "flowchart TB",
      '  a["a quoted > renders as text"]',
      '  b["escaped &lt;capability&gt; survives"]',
      '  c["a line<br/>break is not a tag"]',
      "  subgraph group[\"a subgraph is a declaration\"]",
      '    d["inside"]',
      "  end",
      "  a --> b",
      "  b -->|an edge caption| c",
      "  c -.-> d",
      "```",
      "",
      "```mermaid",
      "sequenceDiagram",
      "  participant P as Pod",
      "  P->>P: sequence diagrams declare differently",
      "```",
      "",
    ].join("\n"),
  );

  const clean = runDiagramCheck({ workspaceRoot: tempRoot, scanRoots: ["clean"] });
  assert(clean.ok, `expected correct diagrams to pass, got: ${clean.findings.join("; ")}`);
  // Without this the suite passes when the block regex matches nothing.
  assert(clean.blocks === 2, `expected 2 diagram blocks to be read, saw ${clean.blocks}`);

  const cases = [
    ['  x[an unquoted > breaks the parser]', "UNQUOTED"],
    ['  x["/one/setup/<capability>"]', "htmlLabels"],
    ['  x["unbalanced [ bracket"]', "unbalanced"],
    ['  x["fine"]\n  x --> ghostNode', "undeclared node"],
  ];

  cases.forEach(([body, expect], index) => {
    const rel = `bad/case-${index}.md`;
    writeFixture(tempRoot, rel, ["```mermaid", "flowchart TB", body, "```", ""].join("\n"));
    const result = runDiagramCheck({ workspaceRoot: tempRoot, scanRoots: [`bad/case-${index}.md`] });
    assert(
      !result.ok && result.findings.some((f) => f.includes(expect)),
      `expected a '${expect}' finding for: ${body.trim()} (got: ${result.findings.join("; ") || "none"})`,
    );
    fs.rmSync(path.join(tempRoot, "bad"), { recursive: true, force: true });
  });

  console.log("verify-doc-diagrams smoke: 4 defect classes caught, 3 safe forms passed");
} finally {
  fs.rmSync(tempRoot, { recursive: true, force: true });
}
