#!/usr/bin/env node
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
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
  --profile <name>    Formatter profile: technical (default), partner, founder, or executive.
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

const IMAGE_MEDIA_TYPES = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
};

/**
 * Turn `![alt](local/path.png)` into a data URI so the rendered page is
 * self-contained. Playwright renders from `setContent`, which has no base
 * directory, so a relative path would resolve against nothing and the image
 * would silently be missing -- the failure mode this inlining exists to prevent.
 * A path that cannot be read is left exactly as written, so a broken reference
 * shows up in the output rather than disappearing.
 */
function inlineLocalImages(markdown, baseDir) {
  return markdown.replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, (whole, alt, src) => {
    if (/^(https?:|data:)/i.test(src)) return whole;
    const resolved = path.resolve(baseDir, src);
    const mediaType = IMAGE_MEDIA_TYPES[path.extname(resolved).toLowerCase()];
    if (!mediaType || !existsSync(resolved)) return whole;
    try {
      const encoded = readFileSync(resolved).toString("base64");
      return `![${alt}](data:${mediaType};base64,${encoded})`;
    } catch {
      return whole;
    }
  });
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
  return typeof line === "string" && /^\|\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?$/.test(line.trim());
}

const PDF_TABLE_VARIANTS = new Set(["standard", "metrics", "scorecard", "ledger", "evidence", "calendar", "calendar-list"]);

function tableAlignment(dividerCell) {
  const normalized = dividerCell.replaceAll(" ", "");
  const start = normalized.startsWith(":");
  const end = normalized.endsWith(":");
  if (start && end) return "center";
  if (end) return "end";
  if (start) return "start";
  return "start";
}

function tableCellLabel(value) {
  return value.replace(/[`*_]/g, "").trim();
}

function tableStatusTone(value) {
  const normalized = tableCellLabel(value).toLowerCase();
  if (/(?:^|\\s)(?:strong|high|success|merged)(?:$|\\s)/.test(normalized)) return "positive";
  if (/(?:not certified|weak evidence|failure|failed|risk)/.test(normalized)) return "risk";
  if (/(?:watch|moderate|open|caution)/.test(normalized)) return "caution";
  return null;
}

function isSummaryRow(cells) {
  return /^(?:combined|total|subtotal)$/i.test(tableCellLabel(cells[0] || ""));
}

function renderMetrics(headers, bodyRows) {
  if (bodyRows.length === 1 && headers.length >= 3) {
    const cells = splitTableRow(bodyRows[0]);
    const layout = headers.length >= 4 ? "deck" : "rail";
    return `<section class="pdf-fact-rail pdf-fact-rail--${layout}" aria-label="Key evidence">
      ${headers
        .map(
          (header, index) => `<article class="pdf-fact">
            <span class="pdf-fact-label">${renderInline(header)}</span>
            <div class="pdf-fact-value">${renderInline(cells[index] || "")}</div>
          </article>`,
        )
        .join("\n")}
    </section>`;
  }

  return `<section class="pdf-metric-list" aria-label="Key evidence">
    ${bodyRows
      .filter((row) => row.trim())
      .map((row) => {
        const cells = splitTableRow(row);
        return `<article class="pdf-metric-item">
          <div class="pdf-metric-measure">${renderInline(cells[0] || "")}</div>
          <div class="pdf-metric-detail">${renderInline(cells.slice(1).join(" "))}</div>
        </article>`;
      })
      .join("\n")}
  </section>`;
}

/**
 * A calendar is intentionally a semantic table variant instead of a report-local
 * layout. The seven headers name weekdays; each cell follows
 * `date :: primary event measure :: optional supporting detail`. An em dash marks
 * an intentionally empty day. This keeps Markdown source portable while allowing
 * the shared formatter to give date, measure, and detail their own hierarchy.
 */
function renderCalendar(headers, bodyRows) {
  if (headers.length !== 7) {
    return null;
  }

  const renderCell = (source, weekday) => {
    const cell = source.trim();
    if (!cell || cell === "—") {
      return `<article class="pdf-calendar-day pdf-calendar-day--empty" aria-label="${escapeHtml(weekday)}: no reported event"></article>`;
    }
    const [date = "", measure = "", ...detailParts] = cell.split(/\s*::\s*/);
    const detail = detailParts.join(" · ");
    const label = [weekday, tableCellLabel(date), tableCellLabel(measure), tableCellLabel(detail)]
      .filter(Boolean)
      .join(", ");
    return `<article class="pdf-calendar-day" aria-label="${escapeHtml(label)}">
      <span class="pdf-calendar-date">${renderInline(date)}</span>
      <span class="pdf-calendar-measure">${renderInline(measure)}</span>
      ${detail ? `<span class="pdf-calendar-detail">${renderInline(detail)}</span>` : ""}
    </article>`;
  };

  return `<section class="pdf-calendar" aria-label="Monthly activity calendar">
    <div class="pdf-calendar-weekdays">${headers
      .map((weekday) => `<span>${renderInline(weekday)}</span>`)
      .join("")}</div>
    ${bodyRows
      .filter((row) => row.trim())
      .map((row) => {
        const cells = splitTableRow(row);
        if (cells.length !== 7) return "";
        return `<div class="pdf-calendar-week">${cells
          .map((cell, index) => renderCell(cell, headers[index] || `Day ${index + 1}`))
          .join("")}</div>`;
      })
      .join("\n")}
  </section>`;
}

function renderCalendarList(headers, bodyRows) {
  if (headers.length !== 3) return null;
  return `<section class="pdf-calendar-list" aria-label="Dated delivery evidence">
    <div class="pdf-calendar-list-head">${headers.map((header) => `<span>${renderInline(header)}</span>`).join("")}</div>
    ${bodyRows
      .filter((row) => row.trim())
      .map((row) => {
        const [date = "", measure = "", detail = ""] = splitTableRow(row);
        const isEmpty = measure.trim() === "—";
        return `<article class="pdf-calendar-list-item${isEmpty ? " pdf-calendar-list-item--empty" : ""}">
          <span class="pdf-calendar-list-date">${renderInline(date)}</span>
          <span class="pdf-calendar-list-measure">${renderInline(measure)}</span>
          <span class="pdf-calendar-list-detail">${renderInline(detail)}</span>
        </article>`;
      })
      .join("\n")}
  </section>`;
}

function renderTable(rows, variant = "standard") {
  const [header, maybeDivider, ...body] = rows;
  const hasDivider = isDividerRow(maybeDivider);
  const bodyRows = hasDivider ? body : [maybeDivider, ...body];
  const headers = splitTableRow(header);
  const alignments = hasDivider ? splitTableRow(maybeDivider).map(tableAlignment) : headers.map(() => "start");
  const tableVariant = PDF_TABLE_VARIANTS.has(variant) ? variant : "standard";
  if (tableVariant === "metrics") {
    return renderMetrics(headers, bodyRows);
  }
  if (tableVariant === "calendar") {
    const calendar = renderCalendar(headers, bodyRows);
    if (calendar) return calendar;
  }
  if (tableVariant === "calendar-list") {
    const calendarList = renderCalendarList(headers, bodyRows);
    if (calendarList) return calendarList;
  }
  return `<div class="pdf-table-wrap pdf-table-wrap--${tableVariant}">
    <table class="pdf-table pdf-table--${tableVariant}">
    <thead><tr>${headers
      .map((cell, index) => `<th scope="col" data-align="${alignments[index] || "start"}">${renderInline(cell)}</th>`)
      .join("")}</tr></thead>
    <tbody>
      ${bodyRows
        .filter((row) => row.trim())
        .map((row) => {
          const cells = splitTableRow(row);
          const summary = isSummaryRow(cells) ? ' data-summary="true"' : "";
          return `<tr${summary}>${cells
            .map((cell, index) => {
              const label = escapeHtml(tableCellLabel(headers[index] || `Column ${index + 1}`));
              const alignment = alignments[index] || "start";
              const tone = tableVariant === "evidence" && index === 0 ? tableStatusTone(cell) : null;
              const content = tone
                ? `<span class="pdf-table-status" data-tone="${tone}">${renderInline(cell)}</span>`
                : renderInline(cell);
              return `<td data-label="${label}" data-align="${alignment}">${content}</td>`;
            })
            .join("")}</tr>`;
        })
        .join("\n")}
    </tbody>
    </table>
  </div>`;
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

export function renderMarkdown(markdown) {
  const lines = markdown.split(/\r?\n/);
  const html = [];
  let unorderedOpen = false;
  let orderedOpen = false;
  let tableRows = [];
  let codeFence = null;
  let codeLines = [];
  let paragraphLines = [];
  let omitFromPdf = false;
  let nextTableVariant = "standard";
  let profileOpen = false;
  let coverOpen = false;
  let calloutOpen = false;

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
      html.push(renderTable(tableRows, nextTableVariant));
      tableRows = [];
      nextTableVariant = "standard";
    }
  };

  const closeProfile = () => {
    if (profileOpen) {
      html.push("</section>");
      profileOpen = false;
    }
  };

  const closeCallout = () => {
    if (calloutOpen) {
      html.push("</section>");
      calloutOpen = false;
    }
  };

  const closeCover = () => {
    if (coverOpen) {
      closeCallout();
      html.push("</section>");
      coverOpen = false;
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
    // A line that is only an image becomes a figure. Screenshots are how a report
    // shows what a screen actually did rather than asserting it, and without this
    // the exporter printed the raw markdown, which reads as a broken document.
    // `inlineLocalImages` has already turned any local path into a data URI, so the
    // rendered page stays self-contained.
    const blockImage = /^!\[([^\]]*)\]\(([^)\s]+)\)$/.exec(line.trim());
    if (blockImage) {
      flushParagraph();
      closeLists();
      flushTable();
      const alt = escapeHtml(blockImage[1]);
      html.push(
        `<figure class="pdf-figure"><img src="${escapeHtml(blockImage[2])}" alt="${alt}" />` +
          (alt ? `<figcaption>${alt}</figcaption>` : "") +
          `</figure>`,
      );
      continue;
    }

    const tableDirective = /^<!--\s*pdf:table=([a-z-]+)\s*-->$/.exec(line.trim());
    if (tableDirective) {
      flushParagraph();
      closeLists();
      flushTable();
      nextTableVariant = PDF_TABLE_VARIANTS.has(tableDirective[1]) ? tableDirective[1] : "standard";
      continue;
    }
    if (line.trim() === "<!-- pdf:cover-start -->") {
      flushParagraph();
      closeLists();
      flushTable();
      closeProfile();
      closeCover();
      html.push('<section class="pdf-cover">');
      coverOpen = true;
      continue;
    }
    if (line.trim() === "<!-- pdf:cover-end -->") {
      flushParagraph();
      closeLists();
      flushTable();
      closeCover();
      continue;
    }
    const calloutDirective = /^<!--\s*pdf:callout=(decision|evidence)\s*-->$/.exec(line.trim());
    if (calloutDirective) {
      flushParagraph();
      closeLists();
      flushTable();
      closeCallout();
      html.push(`<section class="pdf-callout pdf-callout--${calloutDirective[1]}">`);
      calloutOpen = true;
      continue;
    }
    if (line.trim() === "<!-- pdf:callout-end -->") {
      flushParagraph();
      closeLists();
      flushTable();
      closeCallout();
      continue;
    }
    if (line.trim() === "<!-- pdf:profile-start -->") {
      flushParagraph();
      closeLists();
      flushTable();
      closeProfile();
      html.push('<section class="pdf-profile">');
      profileOpen = true;
      continue;
    }
    if (line.trim() === "<!-- pdf:profile-end -->") {
      flushParagraph();
      closeLists();
      flushTable();
      closeProfile();
      continue;
    }
    if (line.trim() === "<!-- pdf:page-break -->") {
      flushParagraph();
      closeLists();
      flushTable();
      closeProfile();
      closeCover();
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

    const image = /^!\[([^\]]*)\]\((data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/=]+|https?:\/\/[^)]+)\)$/.exec(line.trim());
    if (image) {
      flushParagraph();
      closeLists();
      html.push(`<figure class="report-figure"><img src="${image[2]}" alt="${escapeHtml(image[1])}" /><figcaption>${escapeHtml(image[1])}</figcaption></figure>`);
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
  closeProfile();
  closeCover();
  return html.join("\n");
}

/**
 * Merge every block matching a selector, in document order, so later declarations win.
 *
 * `globals.css` declares `.dark` several times by design -- surfaces in one place, the
 * accent family in another. Sampling only the first and last silently drops whatever
 * sits between them, which is precisely how the dark PDF theme was broken.
 */
function mergeAllCssBlocks(source, selector) {
  const merged = {};
  let cursor = 0;
  for (;;) {
    let block;
    try {
      block = extractCssBlock(source, selector, cursor);
    } catch {
      break; // no further match: every block has been merged
    }
    Object.assign(merged, readCssCustomProperties(block));
    const next = source.indexOf(block, cursor);
    if (next < 0) break;
    cursor = next + block.length;
  }
  return merged;
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
  let commentOpen = false;
  let quote = null;
  for (let index = openBrace; index < source.length; index += 1) {
    const character = source[index];
    const next = source[index + 1];
    if (commentOpen) {
      if (character === "*" && next === "/") {
        commentOpen = false;
        index += 1;
      }
      continue;
    }
    if (quote) {
      if (character === "\\") {
        index += 1;
      } else if (character === quote) {
        quote = null;
      }
      continue;
    }
    if (character === "/" && next === "*") {
      commentOpen = true;
      index += 1;
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      continue;
    }
    if (character === "{") depth += 1;
    if (character === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(openBrace + 1, index);
    }
  }
  throw new Error(`Unclosed Morphy CSS selector: ${selector}`);
}

function readCssCustomProperties(block) {
  // A token name can appear in a design-system comment immediately before its real
  // declaration. Strip comments first so that a prose colon cannot swallow the next
  // declaration as part of a CSS value.
  const withoutComments = block.replace(/\/\*[\s\S]*?\*\//g, "");
  return Object.fromEntries(
    [...withoutComments.matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/gi)].map(([, name, value]) => [name, value.trim()]),
  );
}

function visibleTitle(title) {
  const withoutBrand = title.replace(/^(hussh|hushh)\s+/i, "").trim();
  return withoutBrand || title;
}

const PDF_COVER_START = "<!-- pdf:cover-start -->";
const PDF_COVER_END = "<!-- pdf:cover-end -->";
const PDF_PAGE_BREAK = "<!-- pdf:page-break -->";

function countOccurrences(source, needle) {
  return source.split(needle).length - 1;
}

/**
 * A full-bleed cover is a physical print page, not a decorative content card.
 * Restricting it to the executive profile and requiring a page break makes the
 * geometry deterministic and avoids a partial-bleed page in future artifacts.
 */
export function resolvePdfLayout(markdown, profile) {
  const hasCoverMarker = markdown.includes(PDF_COVER_START) || markdown.includes(PDF_COVER_END);
  if (!hasCoverMarker) {
    return { hasFullBleedCover: false };
  }

  if (profile !== "executive") {
    throw new Error("The pdf:cover directive is available only with --profile executive.");
  }

  if (countOccurrences(markdown, PDF_COVER_START) !== 1 || countOccurrences(markdown, PDF_COVER_END) !== 1) {
    throw new Error("An executive PDF must contain exactly one pdf:cover-start and pdf:cover-end directive.");
  }

  const source = markdown.trimStart();
  if (!source.startsWith(PDF_COVER_START)) {
    throw new Error("An executive pdf:cover must be the first semantic block in the document.");
  }

  const coverEndIndex = source.indexOf(PDF_COVER_END);
  if (coverEndIndex < PDF_COVER_START.length) {
    throw new Error("The executive pdf:cover-end directive must follow pdf:cover-start.");
  }

  const afterCover = source.slice(coverEndIndex + PDF_COVER_END.length).trimStart();
  if (!afterCover.startsWith(PDF_PAGE_BREAK)) {
    throw new Error("An executive pdf:cover must be followed immediately by <!-- pdf:page-break -->.");
  }

  return { hasFullBleedCover: true };
}

/**
 * Keep normal page margins in CSS so named pages can own their geometry. Passing
 * Playwright a global margin would override this cover rule and recreate a frame.
 */
export function renderPdfPageRules(formatter, { hasFullBleedCover }) {
  const { page } = formatter;
  const coverRule = hasFullBleedCover
    ? `
      @page pdf-cover {
        background: var(--pdf-cover-bg);
        size: ${page.size};
        margin: 0;
      }`
    : "";

  return `
      @page {
        background: var(--bg);
        size: ${page.size};
        margin: ${page.readingMarginBlock} ${page.readingMarginInline};
      }${coverRule}`;
}

/**
 * Exported so the theme-canon test drives the REAL resolution rather than a copy of it.
 * A test that reimplements the resolver passes while the resolver is broken -- which is
 * how `dark` stayed broken through every prior test run.
 */
export async function resolveFormatter(theme, profile) {
  const globals = await readFile(path.join(repoRoot, "hushh-webapp/app/globals.css"), "utf8");
  const useDarkFoundation = !theme.endsWith("light");
  const rootFoundation = readCssCustomProperties(extractCssBlock(globals, ":root"));
  const foundation = useDarkFoundation
    ? {
        ...rootFoundation,
        ...mergeAllCssBlocks(globals, ".dark"),
      }
    : rootFoundation;
  // Blue reads the Foundation accent family; gold reads its own block. The two gold
  // themes differ ONLY in which block they read, so globals.css stays the single source
  // of truth rather than a second palette living here.
  //
  // Blue is NOT `foundation`. The foundation merge above takes the FIRST and LAST
  // `.dark` blocks, and the one declaring the `--app-accent-*` family is neither -- so
  // `theme=dark` raised "Missing Morphy accent token(s)" for all seven accent names and
  // has never rendered. Reading every `.dark` block in order fixes it and is robust to
  // blocks being added or reordered later, which the first/last approach never was.
  const rootAccent = readCssCustomProperties(extractCssBlock(globals, ":root"));
  const accent =
    theme === "molten-gold"
      ? readCssCustomProperties(extractCssBlock(globals, 'html[data-accent="gold"].dark'))
      : theme === "molten-gold-light"
        ? readCssCustomProperties(extractCssBlock(globals, 'html[data-accent="gold"]'))
        : useDarkFoundation
          ? { ...rootAccent, ...mergeAllCssBlocks(globals, ".dark") }
          : rootAccent;

  return createPdfDocumentFormatter({ theme, profile, foundation, accent });
}

export async function buildHtml(markdown, { documentTitle, displayTitle, subtitle, formatter }) {
  const layout = resolvePdfLayout(markdown, formatter.id);
  const body = renderMarkdown(markdown);
  const interFont = await readFile(
    path.join(repoRoot, "hushh-webapp/public/fonts/Inter/InterVariable.woff2"),
  );
  const header = `<header>
    <div class="brand">
      ${renderPdfHusshWordmark()}
    </div>
    <h1>${escapeHtml(displayTitle)}</h1>
    ${subtitle ? `<div class="subtitle">${escapeHtml(subtitle)}</div>` : ""}
  </header>`;
  const renderedBody =
    layout.hasFullBleedCover && body.startsWith('<section class="pdf-cover">')
      ? body.replace('<section class="pdf-cover">', `<section class="pdf-cover">${header}`)
      : `${header}${body}`;
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${escapeHtml(documentTitle)}</title>
    <style>
      @font-face {
        font-family: "InterVariable";
        font-display: block;
        font-style: normal;
        font-weight: 100 900;
        src: url("data:font/woff2;base64,${interFont.toString("base64")}") format("woff2");
      }

      :root {
        ${formatter.css}
      }

      ${renderPdfPageRules(formatter, layout)}

      * {
        box-sizing: border-box;
      }

      body {
        background: var(--bg);
        color: var(--fg);
        font: var(--pdf-body-size)/var(--pdf-line-height) "InterVariable", "Inter", system-ui, sans-serif;
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
        font-family: "InterVariable", "Inter", system-ui, sans-serif;
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

      .pdf-profile {
        break-inside: avoid;
        margin: 0;
      }

      .pdf-figure {
        break-inside: avoid;
        margin: 18px 0 24px;
      }

      .pdf-figure img {
        border: 1px solid var(--separator);
        border-radius: 8px;
        display: block;
        max-width: 100%;
        height: auto;
      }

      .pdf-figure figcaption {
        color: var(--fg-tertiary);
        font-size: 8.6px;
        line-height: 1.45;
        margin-top: 7px;
      }

      .pdf-fact-rail,
      .pdf-metric-list {
        break-inside: avoid;
        margin: 16px 0 28px;
      }

      .pdf-fact-rail {
        display: grid;
      }

      .pdf-fact-rail--deck {
        background: color-mix(in srgb, var(--accent-surface) 34%, var(--bg-secondary));
        border-bottom: 1px solid var(--separator-strong);
        border-top: 1px solid var(--separator-strong);
        grid-template-columns: repeat(5, minmax(0, 1fr));
      }

      .pdf-fact-rail--rail {
        border-bottom: 1px solid var(--separator);
        border-top: 1px solid var(--separator);
        grid-template-columns: repeat(3, minmax(0, 1fr));
      }

      .pdf-fact {
        min-width: 0;
      }

      .pdf-fact-rail--deck .pdf-fact {
        border-left: 1px solid var(--separator);
        padding: 15px 13px 16px;
      }

      .pdf-fact-rail--rail .pdf-fact {
        border-left: 1px solid var(--separator);
        padding: 12px 13px 14px;
      }

      .pdf-fact:first-child {
        border-left: 0;
      }

      .pdf-fact-label {
        color: var(--fg-tertiary);
        display: block;
        font-family: "SF Mono", "SFMono-Regular", ui-monospace, Menlo, Consolas, monospace;
        font-size: 7.3px;
        font-weight: 650;
        letter-spacing: 0.08em;
        line-height: 1.25;
        text-transform: uppercase;
      }

      .pdf-fact-value {
        color: var(--fg);
        margin-top: 8px;
      }

      .pdf-fact-rail--deck .pdf-fact-value {
        font-size: 24px;
        font-variant-numeric: tabular-nums;
        font-weight: 650;
        letter-spacing: -0.04em;
        line-height: 1;
      }

      .pdf-fact-rail--rail .pdf-fact-value {
        font-size: 10px;
        line-height: 1.42;
      }

      .pdf-fact-rail--rail .pdf-fact-value strong {
        font-size: 13px;
        font-variant-numeric: tabular-nums;
        letter-spacing: -0.02em;
      }

      .pdf-metric-list {
        border-bottom: 1px solid var(--separator);
        border-top: 1px solid var(--separator-strong);
      }

      .pdf-metric-item {
        display: grid;
        gap: 18px;
        grid-template-columns: minmax(168px, 0.72fr) minmax(0, 1.28fr);
        padding: 13px 0;
      }

      .pdf-metric-item + .pdf-metric-item {
        border-top: 1px solid var(--separator);
      }

      .pdf-metric-measure {
        color: var(--fg);
        font-size: 12px;
        font-variant-numeric: tabular-nums;
        font-weight: 650;
        letter-spacing: -0.015em;
      }

      .pdf-metric-detail {
        color: var(--fg-secondary);
        font-size: 10.2px;
        line-height: 1.42;
      }

      .pdf-calendar {
        border-bottom: 1px solid var(--separator-strong);
        border-top: 1px solid var(--separator-strong);
        break-inside: avoid;
        margin: 16px 0 24px;
      }

      .pdf-calendar-weekdays,
      .pdf-calendar-week {
        display: grid;
        grid-template-columns: repeat(7, minmax(0, 1fr));
      }

      .pdf-calendar-weekdays {
        color: var(--fg-tertiary);
        font-family: "SF Mono", "SFMono-Regular", ui-monospace, Menlo, Consolas, monospace;
        font-size: 7px;
        font-weight: 700;
        letter-spacing: 0.08em;
        text-transform: uppercase;
      }

      .pdf-calendar-weekdays span {
        padding: 9px 8px 8px;
      }

      .pdf-calendar-week {
        border-top: 1px solid var(--separator);
      }

      .pdf-calendar-day {
        border-right: 1px solid var(--separator);
        display: flex;
        flex-direction: column;
        gap: 4px;
        min-height: 80px;
        padding: 8px;
      }

      .pdf-calendar-weekdays span:nth-child(7n),
      .pdf-calendar-day:nth-child(7n) {
        border-right: 0;
      }

      .pdf-calendar-day--empty {
        background: color-mix(in srgb, var(--bg-secondary) 44%, transparent);
      }

      .pdf-calendar-date {
        color: var(--fg-tertiary);
        font-family: "SF Mono", "SFMono-Regular", ui-monospace, Menlo, Consolas, monospace;
        font-size: 7px;
        font-variant-numeric: tabular-nums;
        line-height: 1;
      }

      .pdf-calendar-measure {
        color: var(--fg);
        font-size: 12px;
        font-variant-numeric: tabular-nums;
        font-weight: 680;
        letter-spacing: -0.02em;
        line-height: 1.05;
      }

      .pdf-calendar-detail {
        color: var(--fg-secondary);
        font-size: 7px;
        font-weight: 550;
        letter-spacing: 0.01em;
        line-height: 1.18;
      }

      .pdf-calendar-detail a {
        color: var(--accent);
        font-weight: 700;
        text-decoration-thickness: 0.08em;
        text-underline-offset: 0.14em;
      }

      .pdf-calendar-list {
        border-bottom: 1px solid var(--separator-strong);
        border-top: 1px solid var(--separator-strong);
        margin: 16px 0 24px;
      }

      .pdf-calendar-list-head,
      .pdf-calendar-list-item {
        display: grid;
        grid-template-columns: 78px 72px minmax(0, 1fr);
      }

      .pdf-calendar-list-head {
        color: var(--fg-tertiary);
        font-family: "SF Mono", "SFMono-Regular", ui-monospace, Menlo, Consolas, monospace;
        font-size: 7px;
        font-weight: 700;
        letter-spacing: 0.08em;
        padding: 8px 10px;
        text-transform: uppercase;
      }

      .pdf-calendar-list-item {
        border-top: 1px solid var(--separator);
        break-inside: avoid;
        padding: 7px 10px;
      }

      .pdf-calendar-list-item--empty {
        background: color-mix(in srgb, var(--bg-secondary) 48%, transparent);
      }

      .pdf-calendar-list-date {
        color: var(--fg-secondary);
        font-family: "SF Mono", "SFMono-Regular", ui-monospace, Menlo, Consolas, monospace;
        font-size: 8.5px;
        font-variant-numeric: tabular-nums;
        font-weight: 650;
        line-height: 1.25;
      }

      .pdf-calendar-list-measure {
        color: var(--fg);
        font-size: 9px;
        font-variant-numeric: tabular-nums;
        font-weight: 700;
        line-height: 1.25;
      }

      .pdf-calendar-list-detail {
        color: var(--fg-secondary);
        font-size: 9px;
        line-height: 1.3;
      }

      .pdf-calendar-list-item--empty .pdf-calendar-list-measure,
      .pdf-calendar-list-item--empty .pdf-calendar-list-detail {
        color: var(--fg-tertiary);
        font-style: italic;
        font-weight: 500;
      }

      .pdf-calendar-list-detail a {
        color: var(--accent);
        font-weight: 700;
        text-decoration-thickness: 0.08em;
        text-underline-offset: 0.14em;
      }

      .pdf-table-wrap {
        break-inside: auto;
        margin: 14px 0 24px;
        width: 100%;
      }

      /* Evidence tables are deliberately brief audit units. Their denser rhythm
         keeps a three-outcome audit reading together without forcing a near-empty
         trailing page when the surrounding governance narrative is substantial. */
      .pdf-table-wrap--evidence {
        margin: 6px 0 12px;
      }

      .pdf-table--evidence td {
        padding-bottom: 7px;
        padding-top: 7px;
      }

      .pdf-table {
        background: transparent;
        border-collapse: collapse;
        border-spacing: 0;
        color: var(--fg);
        font-size: 10px;
        line-height: 1.38;
        width: 100%;
      }

      .pdf-table thead {
        display: table-header-group;
      }

      .pdf-table tr {
        break-inside: avoid;
      }

      .pdf-table th {
        border-bottom: 1px solid var(--separator-strong);
        color: var(--fg-tertiary);
        font-size: 7.4px;
        font-weight: 700;
        letter-spacing: 0.1em;
        padding: 0 10px 9px;
        text-align: left;
        text-transform: uppercase;
        vertical-align: bottom;
      }

      .pdf-table td {
        border-bottom: 1px solid var(--separator);
        color: var(--fg);
        padding: 10px;
        vertical-align: top;
      }

      .pdf-table tbody tr:last-child td {
        border-bottom: 0;
      }

      .pdf-table th[data-align="end"],
      .pdf-table td[data-align="end"] {
        font-variant-numeric: tabular-nums;
        text-align: right;
      }

      .pdf-table th[data-align="center"],
      .pdf-table td[data-align="center"] {
        text-align: center;
      }

      .pdf-table td:first-child {
        color: var(--fg);
        font-weight: 650;
      }

      .pdf-table tr[data-summary="true"] td {
        background: color-mix(in srgb, var(--accent-surface) 55%, transparent);
        border-bottom: 1px solid var(--separator-strong);
        border-top: 1px solid var(--separator-strong);
        color: var(--fg);
        font-weight: 700;
      }

      .pdf-table--scorecard {
        font-size: 9px;
      }

      .pdf-table--scorecard th {
        font-size: 7px;
        padding: 0 7px 8px;
      }

      .pdf-table--scorecard td {
        padding: 9px 7px;
      }

      .pdf-table--ledger {
        font-size: 9.4px;
      }

      .pdf-table--ledger th,
      .pdf-table--ledger td {
        padding-left: 8px;
        padding-right: 8px;
      }

      .pdf-table--evidence td:first-child {
        min-width: 90px;
      }

      .pdf-table-status {
        border: 1px solid var(--separator);
        border-radius: 3px;
        color: var(--fg-secondary);
        display: inline-block;
        font-size: 8px;
        font-weight: 750;
        letter-spacing: 0.02em;
        line-height: 1.15;
        padding: 4px 7px;
      }

      .pdf-table-status[data-tone="positive"] {
        background: var(--pdf-positive-surface);
        border-color: var(--pdf-positive-border);
        color: var(--pdf-positive);
      }

      .pdf-table-status[data-tone="caution"] {
        background: var(--pdf-caution-surface);
        border-color: var(--pdf-caution-border);
        color: var(--pdf-caution);
      }

      .pdf-table-status[data-tone="risk"] {
        background: var(--pdf-risk-surface);
        border-color: var(--pdf-risk-border);
        color: var(--pdf-risk);
      }

      .pdf-cover {
        break-inside: avoid;
      }

      .pdf-callout {
        break-inside: avoid;
      }

      .formatter-executive {
        font-variant-numeric: proportional-nums;
      }

      .formatter-executive header {
        border-bottom: 0;
        display: grid;
        grid-template-columns: 1fr auto;
        margin-bottom: 30px;
        padding: 2px 0 24px;
        position: relative;
      }

      .formatter-executive header::after {
        background: linear-gradient(90deg, var(--brand-hero-from), var(--brand-hero-mid), var(--brand-hero-to));
        bottom: 0;
        content: "";
        height: 2px;
        left: 0;
        position: absolute;
        width: 74px;
      }

      .formatter-executive .pdf-cover {
        background: var(--pdf-cover-bg);
        color: var(--pdf-cover-ink);
        margin: 0;
        min-height: var(--pdf-page-height);
        page: pdf-cover;
        padding: 23mm 16mm 18mm;
      }

      .formatter-executive .pdf-cover header {
        margin-bottom: 44px;
      }

      .formatter-executive .pdf-cover .brand {
        --brand-ink: var(--pdf-cover-ink);
      }

      .formatter-executive .pdf-cover h1,
      .formatter-executive .pdf-cover strong,
      .formatter-executive .pdf-cover .pdf-fact-value {
        color: var(--pdf-cover-ink);
      }

      .formatter-executive .pdf-cover .subtitle,
      .formatter-executive .pdf-cover p,
      .formatter-executive .pdf-cover .pdf-fact-label {
        color: var(--pdf-cover-muted);
      }

      .formatter-executive .pdf-cover .pdf-fact-rail--deck {
        background: transparent;
        border-color: color-mix(in srgb, var(--pdf-cover-ink) 24%, transparent);
        margin: 34px 0 26px;
      }

      .formatter-executive .pdf-cover .pdf-fact-rail--deck .pdf-fact {
        border-color: color-mix(in srgb, var(--pdf-cover-ink) 16%, transparent);
        padding-bottom: 18px;
        padding-top: 18px;
      }

      .formatter-executive .pdf-callout--decision {
        border-left: 2px solid var(--accent);
        color: var(--fg-secondary);
        margin: 20px 0 0;
        max-width: 630px;
        padding: 1px 0 1px 16px;
      }

      .formatter-executive .pdf-callout--decision p {
        margin: 0;
      }

      .formatter-executive .pdf-cover .pdf-callout--decision {
        border-color: var(--brand-hero-mid);
        color: var(--pdf-cover-muted);
      }

      .formatter-executive .brand {
        height: 24px;
        margin: 0 0 28px;
        width: 76px;
      }

      .formatter-executive h1 {
        font-size: var(--pdf-title-size);
        font-weight: 680;
        grid-column: 1 / -1;
        letter-spacing: -0.055em;
        line-height: 0.98;
        margin: 0;
        max-width: 620px;
      }

      .formatter-executive .subtitle {
        color: var(--fg-tertiary);
        font-family: "SF Mono", "SFMono-Regular", ui-monospace, Menlo, Consolas, monospace;
        font-size: 8.5px;
        font-weight: 650;
        grid-column: 1 / -1;
        letter-spacing: 0.08em;
        margin-top: 16px;
        text-transform: uppercase;
      }

      .formatter-executive h2 {
        border-top: 0;
        font-size: var(--pdf-section-size);
        font-weight: 680;
        letter-spacing: -0.035em;
        line-height: 1.08;
        margin: var(--pdf-section-gap) 0 12px;
        padding: 0;
      }

      .formatter-executive h2::before {
        background: var(--accent);
        content: "";
        display: block;
        height: 2px;
        margin: 0 0 13px;
        width: 26px;
      }

      .formatter-executive h3 {
        color: var(--fg);
        font-size: 14px;
        font-weight: 680;
        letter-spacing: -0.018em;
        line-height: 1.2;
        margin: 26px 0 10px;
      }

      .formatter-executive h4 {
        color: var(--fg-secondary);
        font-family: "SF Mono", "SFMono-Regular", ui-monospace, Menlo, Consolas, monospace;
        font-size: 8px;
        letter-spacing: 0.08em;
        text-transform: uppercase;
      }

      .formatter-executive p,
      .formatter-executive ul,
      .formatter-executive ol,
      .formatter-executive blockquote {
        margin: 7px 0 13px;
      }

      .formatter-executive .pdf-profile {
        border-top: 1px solid var(--separator);
        padding-top: 14px;
      }

      .formatter-executive .pdf-profile + .pdf-profile {
        margin-top: 18px;
      }

      .formatter-executive .pdf-fact-rail--rail {
        margin: 12px 0 16px;
      }

      .formatter-executive .pdf-table {
        font-size: 9.35px;
      }

      .formatter-executive .pdf-table th {
        color: var(--fg-tertiary);
        font-family: "SF Mono", "SFMono-Regular", ui-monospace, Menlo, Consolas, monospace;
        font-size: 6.9px;
        font-weight: 650;
        letter-spacing: 0.055em;
        text-transform: uppercase;
      }

      .formatter-executive .pdf-table td {
        padding-bottom: 11px;
        padding-top: 11px;
      }

      .formatter-executive .pdf-table tr[data-summary="true"] td {
        background: color-mix(in srgb, var(--accent-surface) 34%, var(--bg-secondary));
      }

      .formatter-executive .pdf-table--evidence td:first-child {
        font-family: "SF Mono", "SFMono-Regular", ui-monospace, Menlo, Consolas, monospace;
      }

      .formatter-executive code {
        background: transparent;
        border: 0;
        border-radius: 0;
        color: var(--fg-secondary);
        font-size: 0.9em;
        padding: 0;
      }

      strong {
        color: var(--fg);
      }

      .report-figure {
        break-inside: avoid;
        margin: 14px 0 20px;
      }

      .report-figure img {
        border-radius: 16px;
        box-shadow: 0 20px 52px -38px var(--accent-deep);
        display: block;
        height: auto;
        max-height: 210mm;
        object-fit: contain;
        width: 100%;
      }

      .report-figure figcaption {
        color: var(--fg-secondary);
        font-size: 9px;
        margin-top: 7px;
      }
    </style>
  </head>
  <body>
    <main class="shell formatter-${formatter.id}">
      ${renderedBody}
    </main>
  </body>
</html>`;
}

async function renderPdf({ input, output, html: htmlOutput, title, subtitle, theme, profile }) {
  const markdown = inlineLocalImages(
    rewriteShareableLinks(await readFile(input, "utf8"), input),
    path.dirname(path.resolve(input)),
  );
  const formatter = await resolveFormatter(theme, profile);
  const displayTitle = visibleTitle(title);
  const html = await buildHtml(markdown, { documentTitle: title, displayTitle, subtitle, formatter });
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1240, height: 1754 } });
    await page.setContent(html, { waitUntil: "networkidle", timeout: 20000 });
    await page.evaluate(() => document.fonts.ready);
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
          fontFamily: '"InterVariable", "Inter", system-ui, sans-serif',
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
      preferCSSPageSize: true,
      printBackground: true,
      displayHeaderFooter: true,
      headerTemplate:
        formatter.id === "executive"
          ? "<div></div>"
          : `<div style="font: 8px Inter, system-ui, sans-serif; color: ${formatter.chromeColor}; width: 100%; padding: 0 14mm;">${escapeHtml(displayTitle)}</div>`,
      footerTemplate: `<div style="font: 8px Inter, system-ui, sans-serif; color: ${formatter.chromeColor}; width: 100%; padding: 0 14mm; text-align: right;"><span class="pageNumber"></span> / <span class="totalPages"></span></div>`,
    });
  } finally {
    await browser.close();
  }
}

// Run the CLI only when invoked as one. Without this guard, importing the module to
// test `resolveFormatter` executes the exporter and dies on missing argv -- so the
// resolver could only ever be tested by a COPY of itself, which is how `dark` stayed
// broken through every prior test run. Making the module importable is what lets the
// test drive the shipped code.
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const args = parseArgs(process.argv.slice(2));
  await renderPdf(args);
  console.log(`Wrote ${path.relative(repoRoot, args.output)}`);
  if (args.html) {
    console.log(`Wrote ${path.relative(repoRoot, args.html)}`);
  }
}
