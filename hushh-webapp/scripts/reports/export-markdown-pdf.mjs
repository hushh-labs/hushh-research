#!/usr/bin/env node
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "../../..");

function parseArgs(argv) {
  const args = {
    input: null,
    output: null,
    html: null,
    title: "Hussh Report",
    subtitle: "",
  };

  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--input") {
      args.input = resolveInputPath(argv[++index]);
    } else if (value === "--output") {
      args.output = resolveOutputPath(argv[++index]);
    } else if (value === "--html") {
      args.html = resolveOutputPath(argv[++index]);
    } else if (value === "--title") {
      args.title = argv[++index];
    } else if (value === "--subtitle") {
      args.subtitle = argv[++index];
    } else if (value === "--help" || value === "-h") {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${value}`);
    }
  }

  if (!args.input || !args.output) {
    printHelp();
    process.exit(1);
  }

  return args;
}

function resolveInputPath(value) {
  if (path.isAbsolute(value)) {
    return value;
  }
  const fromCwd = path.resolve(process.cwd(), value);
  if (existsSync(fromCwd)) {
    return fromCwd;
  }
  return path.resolve(repoRoot, value);
}

function resolveOutputPath(value) {
  if (path.isAbsolute(value)) {
    return value;
  }
  return path.resolve(process.cwd(), value);
}

function printHelp() {
  console.log(`Usage: node scripts/reports/export-markdown-pdf.mjs --input <file.md> --output <file.pdf> [options]

Options:
  --html <path>       Optional HTML output path.
  --title <text>      Browser title and PDF header label.
  --subtitle <text>   Small header subtitle.
`);
}

function escapeHtml(value) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function toGitHubBlobUrl(href, inputDir) {
  const [target, anchor = ""] = href.split("#");
  const resolved = path.resolve(inputDir, target);
  const relative = path.relative(repoRoot, resolved);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    return href;
  }
  const normalized = relative.split(path.sep).join("/");
  return `https://github.com/hushh-labs/hushh-research/blob/main/${normalized}${anchor ? `#${anchor}` : ""}`;
}

function rewriteShareableLinks(markdown, inputPath) {
  const inputDir = path.dirname(inputPath);
  return markdown.replace(
    /\[([^\]]+)\]\((?!https?:\/\/|#)([^)\s]+\.md(?:#[^)]+)?)\)/g,
    (_match, label, href) => `[${label}](${toGitHubBlobUrl(href, inputDir)})`,
  );
}

function renderInline(markdown) {
  let html = escapeHtml(markdown);
  html = html.replace(/`([^`]+)`/g, "<code>$1</code>");
  html = html.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  html = html.replace(
    /\[([^\]]+)\]\((https?:\/\/[^)\s]+|#[^)]+|[^)\s]+\.md[^)]*)\)/g,
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
        .filter((row) => row.trim())
        .map((row) => `<tr>${splitTableRow(row).map((cell) => `<td>${renderInline(cell)}</td>`).join("")}</tr>`)
        .join("\n")}
    </tbody>
  </table>`;
}

function cleanMermaidLabel(value) {
  return value.replaceAll("<br/>", " ").replaceAll("<br>", " ").replace(/\s+/g, " ").trim();
}

function renderMermaidFallback(source) {
  const nodeLabels = new Map();
  const edges = [];

  for (const line of source.split("\n")) {
    const node = /^\s*([A-Za-z0-9_]+)\["([^"]+)"\]/.exec(line);
    if (node) {
      nodeLabels.set(node[1], cleanMermaidLabel(node[2]));
      continue;
    }

    const edge = /^\s*([A-Za-z0-9_]+)\s*-->\s*([A-Za-z0-9_]+)/.exec(line);
    if (edge) {
      edges.push([edge[1], edge[2]]);
    }
  }

  if (!nodeLabels.size) {
    return `<pre><code>${escapeHtml(source)}</code></pre>`;
  }

  const nodes = [...nodeLabels.entries()]
    .map(([, label]) => `<div class="diagram-node">${escapeHtml(label)}</div>`)
    .join("");
  const edgeList = edges
    .map(([from, to]) => {
      const fromLabel = nodeLabels.get(from) || from;
      const toLabel = nodeLabels.get(to) || to;
      return `<li><span>${escapeHtml(fromLabel)}</span><strong>-></strong><span>${escapeHtml(toLabel)}</span></li>`;
    })
    .join("");

  return `<figure class="diagram-fallback">
    <div class="diagram-nodes">${nodes}</div>
    ${edgeList ? `<ol class="diagram-edges">${edgeList}</ol>` : ""}
  </figure>`;
}

function renderMarkdown(markdown) {
  const lines = markdown.split(/\r?\n/);
  const html = [];
  let unorderedOpen = false;
  let orderedOpen = false;
  let tableRows = [];
  let codeFence = null;
  let codeLines = [];

  const closeLists = () => {
    if (unorderedOpen) {
      html.push("</ul>");
      unorderedOpen = false;
    }
    if (orderedOpen) {
      html.push("</ol>");
      orderedOpen = false;
    }
  };

  const flushTable = () => {
    if (tableRows.length) {
      html.push(renderTable(tableRows));
      tableRows = [];
    }
  };

  const flushCode = () => {
    if (!codeFence) {
      return;
    }
    const code = escapeHtml(codeLines.join("\n"));
    if (codeFence === "mermaid") {
      html.push(renderMermaidFallback(codeLines.join("\n")));
    } else {
      html.push(`<pre><code>${code}</code></pre>`);
    }
    codeFence = null;
    codeLines = [];
  };

  for (const line of lines) {
    const fence = /^```([A-Za-z0-9_-]+)?\s*$/.exec(line);
    if (fence) {
      if (codeFence) {
        flushCode();
      } else {
        closeLists();
        flushTable();
        codeFence = fence[1] || "text";
        codeLines = [];
      }
      continue;
    }

    if (codeFence) {
      codeLines.push(line);
      continue;
    }

    if (line.trim().startsWith("|")) {
      closeLists();
      tableRows.push(line);
      continue;
    }

    flushTable();

    if (!line.trim()) {
      closeLists();
      continue;
    }

    const heading = /^(#{1,4})\s+(.+)$/.exec(line);
    if (heading) {
      closeLists();
      const level = heading[1].length;
      html.push(`<h${level}>${renderInline(heading[2])}</h${level}>`);
      continue;
    }

    if (line.startsWith("> ")) {
      closeLists();
      html.push(`<blockquote>${renderInline(line.slice(2))}</blockquote>`);
      continue;
    }

    if (/^\s*-\s+/.test(line)) {
      if (!unorderedOpen) {
        closeLists();
        html.push("<ul>");
        unorderedOpen = true;
      }
      html.push(`<li>${renderInline(line.replace(/^\s*-\s+/, ""))}</li>`);
      continue;
    }

    if (/^\s*\d+\.\s+/.test(line)) {
      if (!orderedOpen) {
        closeLists();
        html.push("<ol>");
        orderedOpen = true;
      }
      html.push(`<li>${renderInline(line.replace(/^\s*\d+\.\s+/, ""))}</li>`);
      continue;
    }

    closeLists();
    html.push(`<p>${renderInline(line)}</p>`);
  }

  flushTable();
  flushCode();
  closeLists();
  return html.join("\n");
}

function buildHtml(markdown, { title, subtitle }) {
  const body = renderMarkdown(markdown);
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${escapeHtml(title)}</title>
    <style>
      :root {
        color-scheme: light;
        --bg: #ffffff;
        --bg-secondary: #f5f5f7;
        --bg-tertiary: #ebebf0;
        --fg: #1c1c1e;
        --fg-secondary: rgba(60, 60, 67, 0.78);
        --fg-tertiary: rgba(60, 60, 67, 0.52);
        --separator: rgba(60, 60, 67, 0.18);
        --separator-strong: rgba(60, 60, 67, 0.36);
        --accent: #dbb90f;
        --accent-soft: #fff3bf;
        --blue: #007aff;
      }

      @page {
        background: var(--bg);
        size: A4;
        margin: 18mm 14mm;
      }

      * {
        box-sizing: border-box;
      }

      body {
        background: var(--bg);
        color: var(--fg);
        font: 12px/1.52 -apple-system, BlinkMacSystemFont, "SF Pro Text", "SF Pro", "Helvetica Neue", system-ui, sans-serif;
        margin: 0;
      }

      .shell {
        max-width: 960px;
        margin: 0 auto;
      }

      header {
        border-bottom: 2px solid var(--accent);
        margin-bottom: 18px;
        padding-bottom: 14px;
      }

      .brand {
        color: var(--accent);
        font-size: 11px;
        font-weight: 700;
        letter-spacing: 0.12em;
        margin-bottom: 8px;
        text-transform: uppercase;
      }

      .subtitle {
        color: var(--fg-secondary);
        font-size: 12px;
        margin-top: 5px;
      }

      h1 {
        break-after: avoid;
        font-family: -apple-system, BlinkMacSystemFont, "SF Pro Display", "SF Pro", "Helvetica Neue", system-ui, sans-serif;
        font-size: 30px;
        letter-spacing: 0;
        line-height: 1.12;
        margin: 0 0 12px;
      }

      h2 {
        break-after: avoid;
        border-top: 1px solid var(--separator);
        font-size: 18px;
        letter-spacing: 0;
        line-height: 1.2;
        margin: 26px 0 8px;
        padding-top: 12px;
      }

      h3 {
        break-after: avoid;
        color: var(--accent);
        font-size: 14px;
        letter-spacing: 0;
        margin: 18px 0 6px;
      }

      h4 {
        break-after: avoid;
        color: var(--fg-secondary);
        font-size: 12px;
        margin: 14px 0 4px;
        text-transform: uppercase;
      }

      p,
      ul,
      ol,
      blockquote {
        margin: 6px 0 10px;
      }

      ul,
      ol {
        padding-left: 20px;
      }

      li + li {
        margin-top: 3px;
      }

      blockquote {
        background: var(--bg-secondary);
        border-left: 3px solid var(--accent);
        border-radius: 10px;
        color: var(--fg-secondary);
        padding: 10px 12px;
      }

      a {
        color: var(--blue);
        text-decoration: none;
      }

      code {
        background: var(--bg-secondary);
        border: 1px solid var(--separator);
        border-radius: 6px;
        font-family: "SF Mono", "SFMono-Regular", ui-monospace, Menlo, Consolas, monospace;
        font-size: 0.92em;
        padding: 1px 4px;
      }

      pre {
        background: var(--bg-secondary);
        border: 1px solid var(--separator);
        border-radius: 14px;
        color: var(--fg);
        font: 10px/1.45 "SF Mono", "SFMono-Regular", ui-monospace, Menlo, Consolas, monospace;
        margin: 10px 0 14px;
        overflow: hidden;
        padding: 12px;
        white-space: pre-wrap;
      }

      .diagram-fallback {
        background: #ffffff;
        border: 1px solid var(--separator-strong);
        border-radius: 14px;
        margin: 10px 0 16px;
        padding: 12px;
      }

      .diagram-nodes {
        display: grid;
        gap: 8px;
        grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));
      }

      .diagram-node {
        background: var(--bg-secondary);
        border: 1px solid var(--separator);
        border-left: 3px solid var(--accent);
        border-radius: 10px;
        color: var(--fg);
        font-size: 10px;
        font-weight: 700;
        line-height: 1.35;
        min-height: 38px;
        padding: 8px 9px;
      }

      .diagram-edges {
        border-top: 1px solid var(--separator);
        color: var(--fg-secondary);
        counter-reset: diagram-edge;
        display: grid;
        gap: 4px 12px;
        grid-template-columns: repeat(auto-fit, minmax(260px, 1fr));
        list-style: none;
        margin: 12px 0 0;
        padding: 10px 0 0;
      }

      .diagram-edges li {
        align-items: center;
        display: grid;
        gap: 5px;
        grid-template-columns: 1fr auto 1fr;
      }

      .diagram-edges strong {
        color: var(--accent);
        font-family: "SF Mono", "SFMono-Regular", ui-monospace, Menlo, Consolas, monospace;
      }

      table {
        border-collapse: collapse;
        break-inside: avoid;
        font-size: 10px;
        margin: 10px 0 16px;
        width: 100%;
      }

      th {
        background: var(--bg-secondary);
        border-bottom: 1px solid var(--separator-strong);
        color: var(--fg);
        font-weight: 700;
        padding: 7px 8px;
        text-align: left;
        vertical-align: top;
      }

      td {
        border-bottom: 1px solid var(--separator);
        color: var(--fg-secondary);
        padding: 7px 8px;
        vertical-align: top;
      }

      td:first-child {
        color: var(--fg);
        font-weight: 600;
      }

      strong {
        color: var(--fg);
      }
    </style>
  </head>
  <body>
    <main class="shell">
      <header>
        <div class="brand">Hussh</div>
        <h1>${escapeHtml(title)}</h1>
        ${subtitle ? `<div class="subtitle">${escapeHtml(subtitle)}</div>` : ""}
      </header>
      ${body}
    </main>
  </body>
</html>`;
}

async function renderPdf({ input, output, html: htmlOutput, title, subtitle }) {
  const markdown = rewriteShareableLinks(await readFile(input, "utf8"), input);
  const html = buildHtml(markdown, { title, subtitle });
  if (htmlOutput) {
    await mkdir(path.dirname(htmlOutput), { recursive: true });
    await writeFile(htmlOutput, html, "utf8");
  }

  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1240, height: 1754 } });
    await page.setContent(html, { waitUntil: "networkidle", timeout: 20000 });
    await page.waitForTimeout(1000);
    await mkdir(path.dirname(output), { recursive: true });
    await page.pdf({
      path: output,
      format: "A4",
      printBackground: true,
      displayHeaderFooter: true,
      headerTemplate: `<div style="font: 8px -apple-system, BlinkMacSystemFont, 'SF Pro Text', sans-serif; color: rgba(60,60,67,.62); width: 100%; padding: 0 14mm;">${escapeHtml(title)}</div>`,
      footerTemplate: '<div style="font: 8px -apple-system, BlinkMacSystemFont, \'SF Pro Text\', sans-serif; color: rgba(60,60,67,.62); width: 100%; padding: 0 14mm; text-align: right;"><span class="pageNumber"></span> / <span class="totalPages"></span></div>',
      margin: { top: "18mm", right: "14mm", bottom: "18mm", left: "14mm" },
    });
  } finally {
    await browser.close();
  }
}

const args = parseArgs(process.argv.slice(2));
await renderPdf(args);
console.log(`Wrote ${path.relative(repoRoot, args.output)}`);
if (args.html) {
  console.log(`Wrote ${path.relative(repoRoot, args.html)}`);
}
