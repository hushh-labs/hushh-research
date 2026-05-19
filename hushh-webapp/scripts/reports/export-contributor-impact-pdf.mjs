#!/usr/bin/env node
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "../../..");

const DEFAULT_INPUT = path.join(repoRoot, "tmp/contributor-impact-dashboard.md");
const DEFAULT_OUTPUT = path.join(repoRoot, "tmp/contributor-impact-dashboard.pdf");

function parseArgs(argv) {
  const args = {
    input: DEFAULT_INPUT,
    output: DEFAULT_OUTPUT,
    html: null,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--input") {
      args.input = path.resolve(process.cwd(), argv[++index]);
    } else if (value === "--output") {
      args.output = path.resolve(process.cwd(), argv[++index]);
    } else if (value === "--html") {
      args.html = path.resolve(process.cwd(), argv[++index]);
    } else if (value === "--help" || value === "-h") {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${value}`);
    }
  }

  return args;
}

function printHelp() {
  console.log(`Usage: npm run report:contributor-impact:pdf -- [options]

Options:
  --input <path>   Markdown dashboard path. Default: ../tmp/contributor-impact-dashboard.md
  --output <path>  PDF output path. Default: ../tmp/contributor-impact-dashboard.pdf
  --html <path>    Optional HTML output for visual debugging.
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
  const tableClass = headers.includes("Top PRs")
    ? "top-table"
    : headers.includes("Weekly Score") && headers.includes("Overall Score")
      ? "scoreboard-table"
      : headers.includes("KPI")
        ? "kpi-table"
        : headers.includes("Contract Cluster")
          ? "cluster-table"
          : headers.some((header) => header.includes("Graph"))
            ? "graph-table"
            : "";
  const classAttribute = tableClass ? ` class="${tableClass}"` : "";
  return `<table${classAttribute}>
    <thead><tr>${headers.map((cell) => `<th>${renderInline(cell)}</th>`).join("")}</tr></thead>
    <tbody>
      ${bodyRows
        .map((row) => `<tr>${splitTableRow(row).map((cell) => `<td>${renderInline(cell)}</td>`).join("")}</tr>`)
        .join("\n")}
    </tbody>
  </table>`;
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

function buildHtml(markdown) {
  const body = renderMarkdown(markdown);
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Hussh Contributor Impact Dashboard</title>
    <style>
      :root {
        color-scheme: light;
        --ink: #1a1a1a;
        --muted: #5c5650;
        --line: #e5e1d8;
        --soft: #f7f3ec;
        --paper: #fafaf5;
        --panel: #fffdf7;
        --panel-strong: #f7f1e7;
        --oxblood: #6b1f2c;
        --sage: #788c5d;
        --gold: #d4a847;
      }

      @page {
        background: var(--paper);
        size: A4;
        margin: 18mm 14mm;
      }

      * {
        box-sizing: border-box;
      }

      body {
        background: var(--paper);
        color: var(--ink);
        font: 12px/1.48 "SF Pro Text", Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        margin: 0;
      }

      h1 {
        border-bottom: 2px solid var(--oxblood);
        font-size: 26px;
        letter-spacing: 0;
        margin: 0 0 10px;
        padding: 0 0 10px;
      }

      h2 {
        break-after: avoid;
        border-top: 1.5px solid var(--oxblood);
        color: var(--oxblood);
        font-size: 17px;
        margin: 24px 0 8px;
        padding-top: 10px;
      }

      h3 {
        break-after: avoid;
        color: var(--sage);
        font-size: 13px;
        margin: 18px 0 6px;
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
        color: var(--sage);
        text-decoration: none;
      }

      code {
        background: var(--soft);
        border: 1px solid var(--line);
        border-radius: 4px;
        font-family: "SFMono-Regular", Consolas, monospace;
        font-size: 0.92em;
        padding: 1px 4px;
      }

      table {
        border-collapse: collapse;
        font-size: 8.8px;
        margin: 8px 0 16px;
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
        padding: 5px 6px;
        text-align: left;
        vertical-align: top;
        word-break: break-word;
      }

      th {
        background: var(--panel-strong);
        color: var(--oxblood);
        font-weight: 700;
        text-transform: uppercase;
      }

      td {
        background: var(--panel);
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
      .scoreboard-table th:nth-child(3),
      .scoreboard-table th:nth-child(4),
      .scoreboard-table th:nth-child(5),
      .scoreboard-table th:nth-child(6),
      .scoreboard-table th:nth-child(7),
      .scoreboard-table th:nth-child(8),
      .scoreboard-table th:nth-child(9),
      .top-table td:nth-child(3),
      .top-table td:nth-child(4),
      .top-table td:nth-child(5),
      .top-table td:nth-child(6),
      .top-table td:nth-child(7),
      .top-table td:nth-child(8),
      .top-table th:nth-child(3),
      .top-table th:nth-child(4),
      .top-table th:nth-child(5),
      .top-table th:nth-child(6),
      .top-table th:nth-child(7),
      .top-table th:nth-child(8) {
        text-align: right;
      }

      .cluster-table td:nth-child(1),
      .cluster-table th:nth-child(1) {
        text-align: left;
      }

      .top-table td:nth-child(9),
      .top-table th:nth-child(9),
      .cluster-table td:nth-child(4),
      .cluster-table th:nth-child(4) {
        text-align: left;
      }

      .top-table td:nth-child(9),
      .top-table th:nth-child(9) {
        width: 33%;
      }

      .scoreboard-table td:nth-child(2),
      .scoreboard-table th:nth-child(2) {
        width: 20%;
      }

      .graph-table td:last-child,
      .graph-table th:last-child {
        font-family: "SFMono-Regular", Consolas, monospace;
        text-align: left;
        word-break: keep-all;
      }

      .graph-table td:last-child {
        color: var(--sage);
        font-weight: 800;
      }

      /*
      Keep older unclassified 8-column tables readable if a future section is
      added before the renderer learns its table shape.
      */
      table:not(.top-table):not(.scoreboard-table):not(.kpi-table):not(.cluster-table) td:nth-child(3),
      table:not(.top-table):not(.scoreboard-table):not(.kpi-table):not(.cluster-table) td:nth-child(4),
      table:not(.top-table):not(.scoreboard-table):not(.kpi-table):not(.cluster-table) td:nth-child(5),
      table:not(.top-table):not(.scoreboard-table):not(.kpi-table):not(.cluster-table) td:nth-child(6),
      table:not(.top-table):not(.scoreboard-table):not(.kpi-table):not(.cluster-table) td:nth-child(7),
      table:not(.top-table):not(.scoreboard-table):not(.kpi-table):not(.cluster-table) td:nth-child(8),
      table:not(.top-table):not(.scoreboard-table):not(.kpi-table):not(.cluster-table) th:nth-child(3),
      table:not(.top-table):not(.scoreboard-table):not(.kpi-table):not(.cluster-table) th:nth-child(4),
      table:not(.top-table):not(.scoreboard-table):not(.kpi-table):not(.cluster-table) th:nth-child(5),
      table:not(.top-table):not(.scoreboard-table):not(.kpi-table):not(.cluster-table) th:nth-child(6),
      table:not(.top-table):not(.scoreboard-table):not(.kpi-table):not(.cluster-table) th:nth-child(7),
      table:not(.top-table):not(.scoreboard-table):not(.kpi-table):not(.cluster-table) th:nth-child(8) {
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
  const html = buildHtml(markdown);

  if (args.html) {
    await writeFile(args.html, html, "utf8");
  }

  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 1200, height: 1600 } });
    await page.setContent(html, { waitUntil: "load" });
    await page.pdf({
      path: args.output,
      format: "A4",
      printBackground: true,
      displayHeaderFooter: true,
      headerTemplate: "<div></div>",
      footerTemplate:
        '<div style="font: 9px system-ui, sans-serif; color: #5c5650; width: 100%; padding: 0 14mm; display: flex; justify-content: space-between;"><span>Hussh Contributor Impact Dashboard</span><span class="pageNumber"></span></div>',
      margin: { top: "18mm", right: "14mm", bottom: "18mm", left: "14mm" },
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
