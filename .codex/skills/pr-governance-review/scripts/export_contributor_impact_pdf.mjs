#!/usr/bin/env node
import { readFile, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "../../../..");

// This dashboard renders in the Molten Gold variant, but its palette is NOT hardcoded:
// every accent and foundation value is resolved from the SINGLE source,
// hushh-webapp/app/globals.css, at build time — the same file the canonical formatter reads.
// A frozen hex copy drifts the moment globals.css changes; reading it keeps this in lockstep
// and lets the design gate (verify-accent-tokens.mjs) scan this file for stray accent hexes.
function resolveGlobalsPalette() {
  const css = readFileSync(path.join(repoRoot, "hushh-webapp/app/globals.css"), "utf8");
  const blockAt = (index) => {
    const open = css.indexOf("{", index);
    let depth = 0;
    for (let i = open; i < css.length; i += 1) {
      if (css[i] === "{") depth += 1;
      if (css[i] === "}") {
        depth -= 1;
        if (depth === 0) return css.slice(open + 1, i);
      }
    }
    return "";
  };
  const block = (selector) => {
    const re = new RegExp(`(^|\\n)\\s*${selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*\\{`, "m");
    const m = re.exec(css);
    return m ? blockAt(m.index) : "";
  };
  const tok = (blk, name) => {
    const m = new RegExp(`--${name}\\s*:\\s*([^;]+);`).exec(blk);
    return m ? m[1].trim() : null;
  };
  const root = block(":root");
  const darkFoundation = blockAt(css.lastIndexOf("\n.dark {")); // the PDF pitch-black ground
  // Raw selectors — block() escapes them itself; pre-escaping would double-escape and miss.
  const goldLight = block('html[data-accent="gold"]');
  const goldDark = block('html[data-accent="gold"].dark');
  const pick = (foundBlk, accentBlk) => ({
    ink: tok(foundBlk, "foundation-ink"),
    off: tok(foundBlk, "foundation-off"),
    surface: tok(foundBlk, "foundation-surface"),
    hairline: tok(foundBlk, "foundation-hairline"),
    accent: tok(accentBlk, "app-accent"),
    deep: tok(accentBlk, "app-accent-deep"),
    soft: tok(accentBlk, "app-accent-surface"),
    strong: tok(accentBlk, "app-accent-surface-strong"),
    border: tok(accentBlk, "app-accent-border"),
  });
  return { light: pick(root, goldLight), dark: pick(darkFoundation, goldDark) };
}
const PALETTE = resolveGlobalsPalette();
const webappRequire = createRequire(path.join(repoRoot, "hushh-webapp/package.json"));
const { chromium } = webappRequire("playwright");

const DEFAULT_INPUT = path.join(repoRoot, "tmp/contributor-impact-dashboard.md");
const DEFAULT_OUTPUT = path.join(repoRoot, "tmp/contributor-impact-dashboard-light.pdf");
const THEMES = new Set(["light", "dark"]);

function parseArgs(argv) {
  const args = {
    input: DEFAULT_INPUT,
    output: DEFAULT_OUTPUT,
    html: null,
    theme: "light",
  };

  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--input") {
      args.input = path.resolve(process.cwd(), argv[++index]);
    } else if (value === "--output") {
      args.output = path.resolve(process.cwd(), argv[++index]);
    } else if (value === "--html") {
      args.html = path.resolve(process.cwd(), argv[++index]);
    } else if (value === "--theme") {
      args.theme = argv[++index];
    } else if (value === "--help" || value === "-h") {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${value}`);
    }
  }
  if (!THEMES.has(args.theme)) {
    throw new Error(`Unknown theme: ${args.theme}. Expected one of: ${[...THEMES].join(", ")}`);
  }

  return args;
}

function printHelp() {
  console.log(`Usage: node .codex/skills/pr-governance-review/scripts/export_contributor_impact_pdf.mjs [options]

Options:
  --input <path>   Markdown dashboard path. Default: tmp/contributor-impact-dashboard.md
  --output <path>  PDF output path. Default: tmp/contributor-impact-dashboard-light.pdf
  --html <path>    Optional HTML output for visual debugging.
  --theme <name>   PDF theme: light or dark. Default: light.
`);
}

function escapeHtml(value) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function renderInline(markdown) {
  let html = escapeHtml(markdown);
  html = html.replace(/`([^`]+)`/g, "<code>$1</code>");
  html = html.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  html = html.replace(
    /\[([^\]]+)\]\((https?:\/\/[^)\s]+|#[^)]+)\)/g,
    '<a href="$2">$1</a>',
  );
  return html;
}

function displayHeader(header) {
  return {
    "Product Bonus": "Bonus",
    "Maintainer Support": "Support",
    "Raw Maintainer": "Raw",
    "Maintainer Events": "Events",
    "Balanced Impact": "Balanced",
    "Operating Impact": "Operating",
    "Total PRs": "PRs",
    "Two-Week Source": "Source",
    "Two-Week PRs": "PRs",
    "Two-Week Merged": "Merged",
    "Two-Week Harvested": "Harvested",
    "Weekly Impact": "Weekly",
    "Two-Week Impact": "Two-Week",
    "Overall Impact": "Overall",
    "Weekly Operating": "Weekly",
    "Two-Week Operating": "Two-Week",
    "Monthly Operating": "Monthly",
    "Overall Operating": "Overall",
  }[header] || header;
}

function splitTableRow(line) {
  return line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((cell) => cell.trim());
}

function isDividerRow(line) {
  return /^\|\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?$/.test(line.trim());
}

function renderTable(rows) {
  const [header, maybeDivider, ...body] = rows;
  const bodyRows = isDividerRow(maybeDivider) ? body : [maybeDivider, ...body];
  const headers = splitTableRow(header);
  const tableClass =
    (headers.includes("Weekly Impact") && headers.includes("Overall Impact")) ||
    (headers.includes("Weekly Operating") && headers.includes("Overall Operating")) ||
    (headers.includes("Weekly") && headers.includes("Two-Week") && headers.includes("Monthly"))
      ? "scoreboard-table"
      : headers.includes("Top PRs")
        ? "top-table"
      : headers.includes("Product Area")
        ? "product-table"
      : headers.includes("KPI")
        ? "kpi-table"
        : headers.includes("Contract Cluster")
          ? "cluster-table"
          : headers.some((header) => header.includes("Graph"))
            ? "graph-table"
            : "";
  const classAttribute = tableClass ? ` class="${tableClass}"` : "";
  const colgroup = columnWidths(tableClass, headers.length);
  return `<table${classAttribute}>
    ${colgroup}
    <thead><tr>${headers.map((cell) => `<th title="${escapeHtml(cell)}">${renderInline(displayHeader(cell))}</th>`).join("")}</tr></thead>
    <tbody>
      ${bodyRows
        .map((row) => `<tr>${splitTableRow(row).map((cell) => `<td>${renderInline(cell)}</td>`).join("")}</tr>`)
        .join("\n")}
    </tbody>
  </table>`;
}

function columnWidths(tableClass, columns) {
  const widthMaps = {
    "top-table": [5, 18, 8, 10, 10, 10, 8, 31],
    "scoreboard-table": [5, 17, 7, 9, 10, 9, 9, 7, 27],
    "product-table": [31, 10, 10, 10, 11, 10, 10],
    "kpi-table": [72, 14, 14],
    "cluster-table": [28, 8, 8, 56],
    "graph-table": [5, 18, 8, 10, 10, 10, 8, 31],
  };
  const widths = widthMaps[tableClass];
  if (!widths || widths.length !== columns) {
    return "";
  }
  return `<colgroup>${widths.map((width) => `<col style="width:${width}%">`).join("")}</colgroup>`;
}

function renderMarkdown(markdown) {
  const lines = markdown.split(/\r?\n/);
  const html = [];
  let listOpen = false;
  let tableRows = [];

  const closeList = () => {
    if (listOpen) {
      html.push("</ul>");
      listOpen = false;
    }
  };

  const flushTable = () => {
    if (tableRows.length) {
      html.push(renderTable(tableRows));
      tableRows = [];
    }
  };

  for (const line of lines) {
    if (line.trim().startsWith("|")) {
      closeList();
      tableRows.push(line);
      continue;
    }

    flushTable();

    if (!line.trim()) {
      closeList();
      continue;
    }

    const heading = /^(#{1,3})\s+(.+)$/.exec(line);
    if (heading) {
      closeList();
      const level = heading[1].length;
      html.push(`<h${level}>${renderInline(heading[2])}</h${level}>`);
      continue;
    }

    if (line.startsWith("- ")) {
      if (!listOpen) {
        html.push("<ul>");
        listOpen = true;
      }
      html.push(`<li>${renderInline(line.slice(2))}</li>`);
      continue;
    }

    closeList();
    html.push(`<p>${renderInline(line)}</p>`);
  }

  flushTable();
  closeList();
  return html.join("\n");
}

function buildHtml(markdown, theme = "light") {
  const body = renderMarkdown(markdown);
  return `<!doctype html>
<html lang="en" data-theme="${theme}">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Hussh Contributor Impact Dashboard (${theme})</title>
    <style>
      :root {
        color-scheme: light;
        /* Accent + ground resolved from hushh-webapp/app/globals.css (Molten Gold + Foundation). */
        --ink: ${PALETTE.light.ink};
        --muted: color-mix(in srgb, ${PALETTE.light.ink} 62%, ${PALETTE.light.off});
        --quiet: color-mix(in srgb, ${PALETTE.light.ink} 44%, ${PALETTE.light.off});
        --line: ${PALETTE.light.hairline};
        --line-strong: ${PALETTE.light.border};
        --paper: ${PALETTE.light.off};
        --soft: ${PALETTE.light.off};
        --panel: ${PALETTE.light.surface};
        --panel-strong: ${PALETTE.light.surface};
        --accent: ${PALETTE.light.accent};
        --accent-strong: ${PALETTE.light.deep};
        --accent-soft: ${PALETTE.light.soft};
        --accent-surface-strong: ${PALETTE.light.strong};
        --accent-border: ${PALETTE.light.border};
        --link: ${PALETTE.light.deep};
        --success: #137a35;
        --critical: #c31d13;
        --brand: ${PALETTE.light.ink};
        --page-shadow: rgba(0, 0, 0, 0.08);
      }

      [data-theme="dark"] {
        color-scheme: dark;
        --ink: ${PALETTE.dark.ink};
        --muted: color-mix(in srgb, ${PALETTE.dark.ink} 66%, ${PALETTE.dark.off});
        --quiet: color-mix(in srgb, ${PALETTE.dark.ink} 46%, ${PALETTE.dark.off});
        --line: ${PALETTE.dark.hairline};
        --line-strong: ${PALETTE.dark.border};
        --paper: ${PALETTE.dark.off};
        --soft: ${PALETTE.dark.surface};
        --panel: ${PALETTE.dark.surface};
        --panel-strong: ${PALETTE.dark.surface};
        --accent: ${PALETTE.dark.accent};
        --accent-strong: ${PALETTE.dark.deep};
        --accent-soft: ${PALETTE.dark.soft};
        --accent-surface-strong: ${PALETTE.dark.strong};
        --accent-border: ${PALETTE.dark.border};
        --link: ${PALETTE.dark.deep};
        --success: #30d158;
        --critical: #ff6961;
        --brand: ${PALETTE.dark.ink};
        --page-shadow: rgba(0, 0, 0, 0.42);
      }

      @page {
        background: var(--paper);
        size: A4 landscape;
        margin: 12mm;
      }

      * {
        box-sizing: border-box;
      }

      body {
        background: var(--paper);
        color: var(--ink);
        font: 11px/1.48 -apple-system, BlinkMacSystemFont, "SF Pro Text", "SF Pro", "Helvetica Neue", system-ui, sans-serif;
        margin: 0;
      }

      h1 {
        border-bottom: 2px solid var(--accent);
        color: var(--brand);
        font-size: 24px;
        font-weight: 800;
        letter-spacing: 0;
        margin: 0 0 8px;
        padding: 0 0 8px;
      }

      h2 {
        break-after: avoid;
        border-top: 1px solid var(--line);
        color: var(--ink);
        font-size: 15px;
        margin: 18px 0 7px;
        padding-top: 9px;
      }

      h3 {
        break-after: avoid;
        color: var(--accent-strong);
        font-size: 12px;
        margin: 14px 0 5px;
      }

      p,
      ul {
        margin: 6px 0 10px;
      }

      ul {
        padding-left: 18px;
      }

      li + li {
        margin-top: 3px;
      }

      a {
        color: var(--link);
        text-decoration: none;
      }

      code {
        background: var(--soft);
        border: 1px solid var(--line);
        border-radius: 6px;
        font-family: "SF Mono", "SFMono-Regular", ui-monospace, Menlo, Consolas, monospace;
        font-size: 0.92em;
        padding: 1px 4px;
      }

      table {
        border-collapse: collapse;
        font-size: 8px;
        margin: 7px 0 13px;
        page-break-inside: auto;
        table-layout: fixed;
        width: 100%;
      }

      thead {
        display: table-header-group;
      }

      tr {
        break-inside: avoid;
      }

      th,
      td {
        border: 1px solid var(--line);
        line-height: 1.25;
        padding: 4px 5px;
        text-align: left;
        vertical-align: top;
        word-break: normal;
        overflow-wrap: anywhere;
      }

      th {
        background: var(--accent-soft);
        color: var(--ink);
        font-size: 7px;
        font-weight: 800;
        letter-spacing: 0.02em;
        overflow-wrap: normal;
        text-transform: none;
        word-break: normal;
      }

      td {
        background: var(--panel);
      }

      td code {
        border-radius: 4px;
        display: inline;
        padding: 0 2px;
      }

      .scoreboard-table td:nth-child(1),
      .scoreboard-table th:nth-child(1),
      .top-table td:nth-child(1),
      .top-table th:nth-child(1) {
        text-align: right;
        width: 6%;
      }

      .kpi-table td:nth-child(1),
      .kpi-table th:nth-child(1) {
        text-align: left;
        width: 70%;
      }

      .kpi-table td:nth-child(2),
      .kpi-table td:nth-child(3),
      .kpi-table th:nth-child(2),
      .kpi-table th:nth-child(3),
      .product-table td:nth-child(2),
      .product-table td:nth-child(3),
      .product-table td:nth-child(4),
      .product-table td:nth-child(5),
      .product-table td:nth-child(6),
      .product-table td:nth-child(7),
      .product-table th:nth-child(2),
      .product-table th:nth-child(3),
      .product-table th:nth-child(4),
      .product-table th:nth-child(5),
      .product-table th:nth-child(6),
      .product-table th:nth-child(7),
      .cluster-table td:nth-child(2),
      .cluster-table td:nth-child(3),
      .cluster-table th:nth-child(2),
      .cluster-table th:nth-child(3),
      .scoreboard-table td:nth-child(3),
      .scoreboard-table td:nth-child(4),
      .scoreboard-table td:nth-child(5),
      .scoreboard-table td:nth-child(6),
      .scoreboard-table td:nth-child(7),
      .scoreboard-table td:nth-child(8),
      .scoreboard-table td:nth-child(9),
      .scoreboard-table td:nth-child(10),
      .scoreboard-table td:nth-child(11),
      .scoreboard-table td:nth-child(12),
      .scoreboard-table td:nth-child(13),
      .scoreboard-table th:nth-child(3),
      .scoreboard-table th:nth-child(4),
      .scoreboard-table th:nth-child(5),
      .scoreboard-table th:nth-child(6),
      .scoreboard-table th:nth-child(7),
      .scoreboard-table th:nth-child(8),
      .scoreboard-table th:nth-child(9),
      .scoreboard-table th:nth-child(10),
      .scoreboard-table th:nth-child(11),
      .scoreboard-table th:nth-child(12),
      .scoreboard-table th:nth-child(13),
      .top-table td:nth-child(3),
      .top-table td:nth-child(4),
      .top-table td:nth-child(5),
      .top-table td:nth-child(6),
      .top-table td:nth-child(7),
      .top-table td:nth-child(8),
      .top-table td:nth-child(9),
      .top-table td:nth-child(10),
      .top-table td:nth-child(11),
      .top-table td:nth-child(12),
      .top-table td:nth-child(13),
      .top-table td:nth-child(14),
      .top-table th:nth-child(3),
      .top-table th:nth-child(4),
      .top-table th:nth-child(5),
      .top-table th:nth-child(6),
      .top-table th:nth-child(7),
      .top-table th:nth-child(8),
      .top-table th:nth-child(9),
      .top-table th:nth-child(10),
      .top-table th:nth-child(11),
      .top-table th:nth-child(12),
      .top-table th:nth-child(13),
      .top-table th:nth-child(14) {
        text-align: right;
      }

      .cluster-table td:nth-child(1),
      .cluster-table th:nth-child(1),
      .product-table td:nth-child(1),
      .product-table th:nth-child(1) {
        text-align: left;
      }

      .top-table td:last-child,
      .top-table th:last-child,
      .cluster-table td:nth-child(4),
      .cluster-table th:nth-child(4) {
        text-align: left;
      }

      .top-table td:last-child,
      .top-table th:last-child {
        overflow-wrap: normal;
        white-space: normal;
      }

      .top-table td:nth-child(2) code,
      .scoreboard-table td:nth-child(2) code {
        background: transparent;
        border: 0;
        padding: 0;
        white-space: normal;
        word-break: normal;
        overflow-wrap: anywhere;
      }

      .graph-table td:last-child,
      .graph-table th:last-child {
        font-family: "SFMono-Regular", Consolas, monospace;
        text-align: left;
        word-break: keep-all;
      }

      .graph-table td:last-child {
        color: var(--accent-strong);
        font-weight: 800;
      }

      /*
      Keep older unclassified 8-column tables readable if a future section is
      added before the renderer learns its table shape.
      */
      table:not(.top-table):not(.scoreboard-table):not(.kpi-table):not(.cluster-table):not(.product-table) td:nth-child(3),
      table:not(.top-table):not(.scoreboard-table):not(.kpi-table):not(.cluster-table):not(.product-table) td:nth-child(4),
      table:not(.top-table):not(.scoreboard-table):not(.kpi-table):not(.cluster-table):not(.product-table) td:nth-child(5),
      table:not(.top-table):not(.scoreboard-table):not(.kpi-table):not(.cluster-table):not(.product-table) td:nth-child(6),
      table:not(.top-table):not(.scoreboard-table):not(.kpi-table):not(.cluster-table):not(.product-table) td:nth-child(7),
      table:not(.top-table):not(.scoreboard-table):not(.kpi-table):not(.cluster-table):not(.product-table) td:nth-child(8),
      table:not(.top-table):not(.scoreboard-table):not(.kpi-table):not(.cluster-table):not(.product-table) th:nth-child(3),
      table:not(.top-table):not(.scoreboard-table):not(.kpi-table):not(.cluster-table):not(.product-table) th:nth-child(4),
      table:not(.top-table):not(.scoreboard-table):not(.kpi-table):not(.cluster-table):not(.product-table) th:nth-child(5),
      table:not(.top-table):not(.scoreboard-table):not(.kpi-table):not(.cluster-table):not(.product-table) th:nth-child(6),
      table:not(.top-table):not(.scoreboard-table):not(.kpi-table):not(.cluster-table):not(.product-table) th:nth-child(7),
      table:not(.top-table):not(.scoreboard-table):not(.kpi-table):not(.cluster-table):not(.product-table) th:nth-child(8) {
        text-align: right;
      }

      h2 + ul,
      h2 + p {
        color: var(--muted);
      }
    </style>
  </head>
  <body>${body}</body>
</html>`;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const markdown = await readFile(args.input, "utf8");
  const html = buildHtml(markdown, args.theme);

  if (args.html) {
    await writeFile(args.html, html, "utf8");
  }

  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 1600, height: 1100 } });
    await page.setContent(html, { waitUntil: "load" });
    await page.pdf({
      path: args.output,
      format: "A4",
      landscape: true,
      printBackground: true,
      displayHeaderFooter: true,
      headerTemplate: "<div></div>",
      footerTemplate:
        `<div style="font: 8px -apple-system, BlinkMacSystemFont, SF Pro Text, system-ui, sans-serif; color: ${args.theme === "dark" ? "rgba(245,241,232,.72)" : "rgba(60,60,67,.78)"}; width: 100%; padding: 0 12mm; display: flex; justify-content: space-between;"><span>Hussh Contributor Impact Dashboard · ${args.theme}</span><span class="pageNumber"></span></div>`,
      margin: { top: "12mm", right: "12mm", bottom: "12mm", left: "12mm" },
    });
  } finally {
    await browser.close();
  }

  console.log(`PDF exported to ${path.relative(repoRoot, args.output)}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
