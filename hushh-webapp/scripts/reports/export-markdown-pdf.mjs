#!/usr/bin/env node
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import {
  createPdfDocumentFormatter,
  PDF_FORMATTER_PROFILES,
  PDF_FORMATTER_THEMES,
  renderPdfHusshWordmark,
} from "../../lib/morphy-ux/pdf-document-formatter.mjs";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "../../..");
const require = createRequire(import.meta.url);
const mermaidBrowserBundle = require.resolve("mermaid/dist/mermaid.min.js");

function parseArgs(argv) {
  const args = {
    input: null,
    output: null,
    html: null,
    title: "Hussh Report",
    subtitle: "",
    theme: "light",
    profile: "technical",
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
    } else if (value === "--theme") {
      args.theme = argv[++index];
    } else if (value === "--profile") {
      args.profile = argv[++index];
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

  if (!PDF_FORMATTER_THEMES.includes(args.theme)) {
    throw new Error(`Unsupported theme: ${args.theme}. Use ${PDF_FORMATTER_THEMES.join(", ")}.`);
  }

  if (!Object.hasOwn(PDF_FORMATTER_PROFILES, args.profile)) {
    throw new Error(
      `Unsupported profile: ${args.profile}. Use ${Object.keys(PDF_FORMATTER_PROFILES).join(", ")}.`,
    );
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
  --theme <name>      Foundation theme: light (default), dark, molten-gold-light, or molten-gold.
  --profile <name>    Formatter profile: technical (default), partner, or founder.
`);
}

function escapeHtml(value) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function highlightJson(source) {
  const escaped = escapeHtml(source);
  return escaped.replace(
    /(&quot;.*?&quot;)(\s*:)?|(-?\b\d+(?:\.\d+)?(?:[eE][+-]?\d+)?\b|\b(?:true|false|null)\b)/g,
    (match, stringValue, propertyDelimiter, literal) => {
      if (stringValue) {
        const token = propertyDelimiter ? "token-key" : "token-string";
        return `<span class="${token}">${stringValue}</span>${propertyDelimiter || ""}`;
      }
      return `<span class="token-literal">${literal}</span>`;
    },
  );
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

function renderMermaid(source) {
  return `<figure class="diagram-render"><pre class="mermaid">${escapeHtml(source)}</pre></figure>`;
}

function renderMarkdown(markdown) {
  const lines = markdown.split(/\r?\n/);
  const html = [];
  let unorderedOpen = false;
  let orderedOpen = false;
  let tableRows = [];
  let codeFence = null;
  let codeLines = [];
  let paragraphLines = [];
  let omitFromPdf = false;

  const flushParagraph = () => {
    if (!paragraphLines.length) {
      return;
    }
    html.push(`<p>${renderInline(paragraphLines.join(" "))}</p>`);
    paragraphLines = [];
  };

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
    const source = codeLines.join("\n");
    const code = codeFence === "json" ? highlightJson(source) : escapeHtml(source);
    if (codeFence === "mermaid") {
      html.push(renderMermaid(source));
    } else {
      html.push(`<pre class="code-block code-block-${codeFence}"><code>${code}</code></pre>`);
    }
    codeFence = null;
    codeLines = [];
  };

  for (const line of lines) {
    if (line.trim() === "<!-- pdf:page-break -->") {
      flushParagraph();
      closeLists();
      flushTable();
      html.push('<div class="pdf-page-break" aria-hidden="true"></div>');
      continue;
    }
    if (line.trim() === "<!-- pdf:omit-start -->") {
      omitFromPdf = true;
      continue;
    }
    if (line.trim() === "<!-- pdf:omit-end -->") {
      omitFromPdf = false;
      continue;
    }
    if (omitFromPdf) continue;

    const fence = /^```([A-Za-z0-9_-]+)?\s*$/.exec(line);
    if (fence) {
      flushParagraph();
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
      flushParagraph();
      closeLists();
      tableRows.push(line);
      continue;
    }

    flushTable();

    if (!line.trim()) {
      flushParagraph();
      closeLists();
      continue;
    }

    const heading = /^(#{1,4})\s+(.+)$/.exec(line);
    if (heading) {
      flushParagraph();
      closeLists();
      const level = heading[1].length;
      html.push(`<h${level}>${renderInline(heading[2])}</h${level}>`);
      continue;
    }

    if (line.startsWith("> ")) {
      flushParagraph();
      closeLists();
      html.push(`<blockquote>${renderInline(line.slice(2))}</blockquote>`);
      continue;
    }

    const listContinuation = /^\s{2,}(.+)$/.exec(line);
    if (
      listContinuation &&
      (unorderedOpen || orderedOpen) &&
      html.at(-1)?.startsWith("<li>")
    ) {
      const previousItem = html.at(-1);
      html[html.length - 1] = previousItem.replace(
        /<\/li>$/,
        ` ${renderInline(listContinuation[1].trim())}</li>`,
      );
      continue;
    }

    if (/^\s*-\s+/.test(line)) {
      flushParagraph();
      if (!unorderedOpen) {
        closeLists();
        html.push("<ul>");
        unorderedOpen = true;
      }
      html.push(`<li>${renderInline(line.replace(/^\s*-\s+/, ""))}</li>`);
      continue;
    }

    if (/^\s*\d+\.\s+/.test(line)) {
      flushParagraph();
      if (!orderedOpen) {
        closeLists();
        html.push("<ol>");
        orderedOpen = true;
      }
      html.push(`<li>${renderInline(line.replace(/^\s*\d+\.\s+/, ""))}</li>`);
      continue;
    }

    closeLists();
    paragraphLines.push(line.trim());
  }

  flushParagraph();
  flushTable();
  flushCode();
  closeLists();
  return html.join("\n");
}

function extractCssBlock(source, selector, startAt = 0) {
  const escapedSelector = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const selectorPattern = new RegExp(`^\\s*${escapedSelector}\\s*\\{`, "m");
  const scopedSource = source.slice(startAt);
  const selectorMatch = selectorPattern.exec(scopedSource);
  if (!selectorMatch) {
    throw new Error(`Missing Morphy CSS selector: ${selector}`);
  }

  const openBrace = startAt + selectorMatch.index + selectorMatch[0].lastIndexOf("{");
  let depth = 0;
  for (let index = openBrace; index < source.length; index += 1) {
    if (source[index] === "{") depth += 1;
    if (source[index] === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(openBrace + 1, index);
    }
  }
  throw new Error(`Unclosed Morphy CSS selector: ${selector}`);
}

function readCssCustomProperties(block) {
  return Object.fromEntries(
    [...block.matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/gi)].map(([, name, value]) => [name, value.trim()]),
  );
}

function visibleTitle(title) {
  const withoutBrand = title.replace(/^(hussh|hushh)\s+/i, "").trim();
  return withoutBrand || title;
}

async function resolveFormatter(theme, profile) {
  const globals = await readFile(path.join(repoRoot, "hushh-webapp/app/globals.css"), "utf8");
  const useDarkFoundation = theme === "dark" || theme === "molten-gold";
  const foundation = useDarkFoundation
    ? {
        ...readCssCustomProperties(
          extractCssBlock(globals, ".dark", globals.indexOf("\n.dark {")),
        ),
        ...readCssCustomProperties(
          extractCssBlock(globals, ".dark", globals.lastIndexOf("\n.dark {")),
        ),
      }
    : readCssCustomProperties(extractCssBlock(globals, ":root"));
  const accent = theme === "molten-gold" || theme === "molten-gold-light"
    ? readCssCustomProperties(
        extractCssBlock(
          globals,
          theme === "molten-gold"
            ? 'html[data-accent="gold"].dark'
            : 'html[data-accent="gold"]',
        ),
      )
    : foundation;

  return createPdfDocumentFormatter({ theme, profile, foundation, accent });
}

function buildHtml(markdown, { documentTitle, displayTitle, subtitle, formatter }) {
  const body = renderMarkdown(markdown);
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${escapeHtml(documentTitle)}</title>
    <style>
      :root {
        ${formatter.css}
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
        font: var(--pdf-body-size)/var(--pdf-line-height) -apple-system, BlinkMacSystemFont, "SF Pro Text", "SF Pro", "Helvetica Neue", system-ui, sans-serif;
        margin: 0;
      }

      .pdf-page-break {
        break-before: page;
        height: 0;
      }

      .shell {
        max-width: 960px;
        margin: 0 auto;
      }

      header {
        border-bottom: 2px solid var(--accent);
        break-inside: avoid;
        margin-bottom: 18px;
        padding-bottom: 14px;
      }

      .brand {
        height: 30px;
        margin-bottom: 8px;
        width: 94px;
      }

      .brand svg {
        display: block;
        height: 100%;
        overflow: visible;
        width: 100%;
      }

      .subtitle {
        color: var(--fg-secondary);
        font-size: 12px;
        margin-top: 5px;
      }

      h1 {
        break-after: avoid;
        font-family: -apple-system, BlinkMacSystemFont, "SF Pro Display", "SF Pro", "Helvetica Neue", system-ui, sans-serif;
        font-size: var(--pdf-title-size);
        letter-spacing: 0;
        line-height: 1.12;
        margin: 0 0 12px;
      }

      h2 {
        break-after: avoid;
        border-top: 1px solid var(--separator);
        font-size: var(--pdf-section-size);
        letter-spacing: 0;
        line-height: 1.2;
        margin: var(--pdf-section-gap) 0 8px;
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
        background: var(--accent-surface);
        border-left: 3px solid var(--accent);
        border-radius: 10px;
        color: var(--fg-secondary);
        padding: 10px 12px;
      }

      .badge {
        display: inline-block;
        background: var(--accent-surface);
        border: 1px solid var(--separator-strong);
        color: var(--accent);
        border-radius: 4px;
        padding: 1px 6px;
        font-size: 8px;
        font-weight: 700;
        font-family: "JetBrains Mono", "SF Mono", monospace;
        text-transform: uppercase;
        letter-spacing: 0.4px;
      }

      a {
        color: var(--link);
        font-weight: 600;
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
        background: var(--code-bg);
        border: 1px solid var(--code-border);
        border-radius: 14px;
        break-inside: avoid;
        box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.05);
        color: var(--code-fg);
        font: var(--pdf-code-size)/1.45 "SF Mono", "SFMono-Regular", ui-monospace, Menlo, Consolas, monospace;
        margin: 10px 0 14px;
        overflow: hidden;
        padding: 12px;
        white-space: pre-wrap;
      }

      pre code {
        background: transparent;
        border: 0;
        border-radius: 0;
        color: inherit;
        font: inherit;
        padding: 0;
      }

      .token-key { color: var(--code-key); }
      .token-string { color: var(--code-string); }
      .token-literal { color: var(--code-literal); }

      .diagram-fallback {
        background: var(--diagram-bg);
        border: 1px solid var(--separator-strong);
        border-radius: 14px;
        margin: 10px 0 16px;
        padding: 12px;
      }

      .diagram-render {
        align-items: center;
        background: var(--diagram-bg);
        border: 1px solid var(--separator-strong);
        border-radius: 14px;
        break-inside: avoid;
        display: flex;
        justify-content: center;
        margin: 10px 0 16px;
        min-height: 120px;
        overflow: hidden;
        padding: 12px;
        width: 100%;
      }

      .diagram-render .mermaid {
        background: transparent;
        border: 0;
        box-shadow: none;
        margin: 0;
        overflow: visible;
        padding: 0;
        width: 100%;
      }

      .diagram-render svg {
        display: block;
        height: auto;
        margin: 0 auto;
        max-height: 620px;
        max-width: 100%;
        width: 100%;
      }

      .diagram-render .nodeLabel,
      .diagram-render .edgeLabel,
      .diagram-render .label,
      .diagram-render .messageText,
      .diagram-render .actor {
        font-size: var(--pdf-diagram-size) !important;
        line-height: 1.3 !important;
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
        border-collapse: separate;
        border-spacing: 0;
        break-inside: avoid;
        font-size: 9.5px;
        margin: 12px 0 18px;
        width: 100%;
        border: 1px solid var(--separator-strong);
        border-radius: 10px;
        overflow: hidden;
        background: var(--bg-secondary);
      }

      th {
        background: var(--bg-tertiary, var(--bg-secondary));
        border-bottom: 1px solid var(--separator-strong);
        color: var(--fg-secondary);
        font-size: 8px;
        font-weight: 700;
        letter-spacing: 0.8px;
        padding: 8px 10px;
        text-align: left;
        text-transform: uppercase;
        vertical-align: middle;
      }

      td {
        border-bottom: 1px solid var(--separator);
        color: var(--fg);
        padding: 8px 10px;
        vertical-align: middle;
      }

      tr:last-child td {
        border-bottom: none;
      }

      tr:nth-child(even) td {
        background: var(--accent-surface);
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
    <main class="shell formatter-${formatter.id}">
      <header>
        <div class="brand">
          ${renderPdfHusshWordmark()}
        </div>
        <h1>${escapeHtml(displayTitle)}</h1>
        ${subtitle ? `<div class="subtitle">${escapeHtml(subtitle)}</div>` : ""}
      </header>
      ${body}
    </main>
  </body>
</html>`;
}

async function renderPdf({ input, output, html: htmlOutput, title, subtitle, theme, profile }) {
  const markdown = rewriteShareableLinks(await readFile(input, "utf8"), input);
  const formatter = await resolveFormatter(theme, profile);
  const displayTitle = visibleTitle(title);
  const html = buildHtml(markdown, { documentTitle: title, displayTitle, subtitle, formatter });
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1240, height: 1754 } });
    await page.setContent(html, { waitUntil: "networkidle", timeout: 20000 });
    const mermaidScript = await page.addScriptTag({ path: mermaidBrowserBundle });
    await page.evaluate(async () => {
      const styles = getComputedStyle(document.documentElement);
      const color = (name) => styles.getPropertyValue(name).trim();
      globalThis.mermaid.initialize({
        startOnLoad: false,
        securityLevel: "strict",
        theme: "base",
        themeVariables: {
          background: color("--bg"),
          primaryColor: color("--bg-secondary"),
          primaryTextColor: color("--fg"),
          primaryBorderColor: color("--accent"),
          lineColor: color("--accent"),
          secondaryColor: color("--accent-surface"),
          secondaryTextColor: color("--fg"),
          tertiaryColor: color("--bg-tertiary"),
          tertiaryTextColor: color("--fg"),
          noteBkgColor: color("--accent-surface"),
          noteTextColor: color("--fg"),
          actorBkg: color("--bg-secondary"),
          actorBorder: color("--accent"),
          actorTextColor: color("--fg"),
          signalColor: color("--accent"),
          signalTextColor: color("--fg"),
          labelBoxBkgColor: color("--bg-secondary"),
          labelBoxBorderColor: color("--separator-strong"),
          labelTextColor: color("--fg"),
          fontFamily: '-apple-system, BlinkMacSystemFont, "SF Pro Text", "InterVariable", system-ui, sans-serif',
          fontSize: color("--pdf-diagram-size"),
        },
        flowchart: { htmlLabels: true, useMaxWidth: true },
        sequence: { useMaxWidth: true, wrap: true },
      });
      try {
        await globalThis.mermaid.run({ nodes: document.querySelectorAll(".mermaid") });
      } catch (error) {
        const message = error instanceof Error ? error.message : JSON.stringify(error);
        throw new Error(`Mermaid render failed: ${message}`);
      }
    });
    await mermaidScript.evaluate((node) => node.remove());
    if (htmlOutput) {
      await mkdir(path.dirname(htmlOutput), { recursive: true });
      await writeFile(htmlOutput, await page.content(), "utf8");
    }
    await page.waitForTimeout(1000);
    await mkdir(path.dirname(output), { recursive: true });
    await page.pdf({
      path: output,
      format: "A4",
      printBackground: true,
      displayHeaderFooter: true,
      headerTemplate: `<div style="font: 8px -apple-system, BlinkMacSystemFont, 'SF Pro Text', sans-serif; color: ${formatter.chromeColor}; width: 100%; padding: 0 14mm;">${escapeHtml(displayTitle)}</div>`,
      footerTemplate: `<div style="font: 8px -apple-system, BlinkMacSystemFont, 'SF Pro Text', sans-serif; color: ${formatter.chromeColor}; width: 100%; padding: 0 14mm; text-align: right;"><span class="pageNumber"></span> / <span class="totalPages"></span></div>`,
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
