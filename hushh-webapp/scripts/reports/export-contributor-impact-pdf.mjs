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
    /\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g,
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
  return `<table>
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
        --ink: #16211c;
        --muted: #617066;
        --line: #dbe3dd;
        --soft: #f5f8f6;
        --brand: #0f6b4b;
      }

      @page {
        size: A4;
        margin: 18mm 14mm;
      }

      * {
        box-sizing: border-box;
      }

      body {
        color: var(--ink);
        font: 12px/1.45 Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        margin: 0;
      }

      h1 {
        border-bottom: 2px solid var(--ink);
        font-size: 24px;
        letter-spacing: 0;
        margin: 0 0 10px;
        padding: 0 0 10px;
      }

      h2 {
        break-after: avoid;
        color: var(--brand);
        font-size: 16px;
        margin: 24px 0 8px;
      }

      h3 {
        break-after: avoid;
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
        color: var(--brand);
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
        font-size: 9.5px;
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
        background: var(--soft);
        color: var(--ink);
        font-weight: 700;
      }

      td:nth-child(1),
      td:nth-child(3),
      td:nth-child(4),
      td:nth-child(5),
      td:nth-child(6),
      td:nth-child(7),
      td:nth-child(8),
      th:nth-child(1),
      th:nth-child(3),
      th:nth-child(4),
      th:nth-child(5),
      th:nth-child(6),
      th:nth-child(7),
      th:nth-child(8) {
        text-align: right;
      }

      table:has(th:nth-child(9)) th:nth-child(9),
      table:has(th:nth-child(9)) td:nth-child(9) {
        text-align: left;
        width: 32%;
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
        '<div style="font: 9px system-ui, sans-serif; color: #617066; width: 100%; padding: 0 14mm; display: flex; justify-content: space-between;"><span>Hussh Contributor Impact Dashboard</span><span class="pageNumber"></span></div>',
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
