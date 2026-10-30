#!/usr/bin/env node
// Renders lib/navigation/app-route-layout.contract.json's authored Back
// hierarchy as a Mermaid flowchart. This is a read-only audit/documentation
// aid, not a build step the runtime depends on: the contract JSON itself is
// already the structure back-hierarchy.contract.test.ts validates against
// the live resolver (lib/navigation/back-navigation-graph.ts) on every run,
// so this diagram can never silently diverge from what Back actually does --
// it is generated from the same verified source, not a separate guess at it.
//
// Usage:
//   node ./scripts/architecture/generate-back-navigation-graph.mjs
//   node ./scripts/architecture/generate-back-navigation-graph.mjs --check
//
// `--check` is read-only (exits 1 on drift) and is NOT wired into
// verify:ui-contracts/CI yet -- this is a voluntary command for now. See the
// contributor guide for when/whether to promote it to a gated check.

import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const appRoot = process.cwd();
const repoRoot = path.resolve(appRoot, "..");
const contractPath = path.join(
  appRoot,
  "lib/navigation/app-route-layout.contract.json",
);
const outputPath = path.join(
  repoRoot,
  "docs/reference/architecture/back-navigation-graph.generated.md",
);

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function pathnameOf(href) {
  return String(href || "/").split(/[?#]/, 1)[0] || "/";
}

/** A Mermaid-safe node id: stable, collision-free for the ~150 routes here. */
function nodeId(route) {
  return (
    "r_" +
    (route === "/" ? "root" : route.replace(/[^a-zA-Z0-9]+/g, "_")).replace(
      /^_+|_+$/g,
      "",
    )
  );
}

function escapeLabel(text) {
  return String(text).replace(/"/g, "&quot;");
}

/**
 * One canonical edge per route: the case whose href carries no query (the
 * bare route), which is the route's real place in the hierarchy -- every
 * other case is a query-conditional sub-flow of the SAME route (an action
 * sheet, a tab, a detail view), not a distinct hierarchy node. Those are
 * summarized as a case count, not drawn individually, so the diagram stays a
 * legible hierarchy rather than every authored test fixture.
 *
 * A dynamic route (e.g. "/r/[slug]") can't be tested with its literal
 * bracketed placeholder, so its one authored case uses a concrete sample
 * value ("/r/sample") instead -- match on "no query string", not on exact
 * equality to `entry.route`, so these aren't mistaken for having no bare
 * case at all.
 */
function canonicalEdge(entry) {
  const cases = entry.backVerification?.cases ?? [];
  const bare = cases.find((c) => pathnameOf(c.href) === c.href) ?? cases[0];
  if (!bare) return null;
  return {
    target: bare.expected ? pathnameOf(bare.expected.href) : null,
    mode: bare.expected?.mode ?? null,
  };
}

function buildGraph() {
  const contract = readJson(contractPath);
  const routes = new Map(contract.map((entry) => [entry.route, entry]));
  const edges = [];
  const nodeKinds = new Map();

  for (const entry of contract) {
    const kind = entry.backVerification?.kind ?? "parent";
    nodeKinds.set(entry.route, kind);
    const edge = canonicalEdge(entry);
    const caseCount = entry.backVerification?.cases?.length ?? 0;
    if (edge && edge.target) {
      edges.push({
        from: entry.route,
        to: edge.target,
        mode: edge.mode,
        extraCases: caseCount - 1,
        // The target may not itself be an authored route (e.g. a dynamic
        // detail href) -- still draw it, labeled, so the diagram shows where
        // Back actually goes even for targets outside the 150-entry table.
        targetIsAuthored: routes.has(edge.target),
      });
    }
  }

  return { contract, edges, nodeKinds };
}

function renderMermaid({ contract, edges, nodeKinds }) {
  const lines = [];
  lines.push("flowchart TD");
  lines.push("");

  // Declare every authored route once, styled by its backVerification.kind.
  for (const entry of contract) {
    const id = nodeId(entry.route);
    const kind = nodeKinds.get(entry.route);
    const label = escapeLabel(entry.route);
    if (kind === "root") {
      lines.push(`  ${id}(["${label}"])`);
    } else if (kind === "redirect") {
      lines.push(`  ${id}{{"${label}"}}`);
    } else {
      lines.push(`  ${id}["${label}"]`);
    }
  }
  lines.push("");

  // Declare any edge target that isn't itself an authored route (dynamic
  // hrefs the hierarchy still points at), so the diagram stays complete.
  const extraTargets = new Set();
  for (const edge of edges) {
    if (!edge.targetIsAuthored) extraTargets.add(edge.to);
  }
  for (const target of [...extraTargets].sort()) {
    lines.push(`  ${nodeId(target)}["${escapeLabel(target)}"]`);
  }
  if (extraTargets.size) lines.push("");

  for (const edge of edges) {
    const from = nodeId(edge.from);
    const to = nodeId(edge.to);
    const labelParts = [];
    if (edge.mode) labelParts.push(edge.mode);
    if (edge.extraCases > 0) labelParts.push(`+${edge.extraCases} case${edge.extraCases === 1 ? "" : "s"}`);
    const label = labelParts.length ? `|${escapeLabel(labelParts.join(", "))}|` : "";
    lines.push(`  ${from} -->${label} ${to}`);
  }

  return lines.join("\n");
}

function renderDocument(graph) {
  const mermaid = renderMermaid(graph);
  const rootCount = graph.contract.filter((e) => graph.nodeKinds.get(e.route) === "root").length;
  const withSubflows = graph.edges.filter((e) => e.extraCases > 0).length;
  return `# Back navigation graph

Generated by \`hushh-webapp/scripts/architecture/generate-back-navigation-graph.mjs\`
from \`hushh-webapp/lib/navigation/app-route-layout.contract.json\` -- the same
authored contract \`hushh-webapp/__tests__/navigation/back-hierarchy.contract.test.ts\`
validates against the live resolver
(\`hushh-webapp/lib/navigation/back-navigation-graph.ts\`) on every run.
Regenerate with \`npm run docs:back-navigation-graph\` (from \`hushh-webapp/\`)
after any route's authored Back case changes; do not hand-edit this file.

## Visual Map

${graph.contract.length} authored routes, ${rootCount} of them section/app
roots. ${withSubflows} routes additionally branch on query (an action sheet,
a tab, a detail view) -- those sub-flows are counted on their edge label, not
drawn individually, so the diagram reads as the hierarchy rather than every
authored test fixture. See the JSON contract directly for the full
per-query-combination cases.

An oval marks an app/section root (no outgoing edge -- Back has nowhere
further to climb). A hexagon marks a \`redirect\`-kind route, which forwards
elsewhere immediately and sits outside the normal back-hierarchy. Every other
node is a \`parent\`-kind route with one edge to its authored parent; \`push\`
vs \`replace\` on the edge is the history mode that parent navigation uses.
Routes with no outgoing edge that are neither a root nor a redirect are
\`surface-owned\`: the screen itself owns its own back control, not this
shared contract (lib/navigation/back-layers.ts).

## Diagram

\`\`\`mermaid
${mermaid}
\`\`\`
`;
}

function main() {
  const check = process.argv.includes("--check");
  const graph = buildGraph();
  const document = renderDocument(graph);

  if (check) {
    const current = fs.existsSync(outputPath) ? fs.readFileSync(outputPath, "utf8") : null;
    if (current !== document) {
      console.error(
        `Back navigation graph is stale: ${path.relative(repoRoot, outputPath)} does not match the current contract. Run npm run docs:back-navigation-graph.`,
      );
      process.exitCode = 1;
      return;
    }
    console.log("Back navigation graph is current.");
    return;
  }

  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, document);
  console.log(
    `Wrote back navigation graph (${graph.contract.length} routes, ${graph.edges.length} edges) to ${path.relative(repoRoot, outputPath)}`,
  );
}

main();
