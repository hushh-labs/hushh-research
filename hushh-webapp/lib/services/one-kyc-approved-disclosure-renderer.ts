"use client";

export const APPROVED_DISCLOSURE_FORMATTER_CONTRACT_ID =
  "agent_kyc.approved_disclosure_formatter.v1" as const;

export type RedraftTransform = {
  compact: boolean;
  formal: boolean;
  bulletList: boolean;
  structured: boolean;
  table: boolean;
  fullDetail: boolean;
  human: boolean;
  cleanHeaders: boolean;
};

export type RenderFact = {
  field: string;
  label: string;
  value: string;
  scope: string;
};

export type RenderCard = {
  kind: "card";
  label: string;
  value: string;
};

export type RenderTable = {
  kind: "table";
  title: string;
  columns: string[];
  rows: string[][];
  minWidth: number;
};

export type RenderList = {
  kind: "list";
  title: string;
  items: string[];
};

export type RenderParagraph = {
  kind: "paragraph";
  text: string;
};

export type RenderBlock = RenderCard | RenderTable | RenderList | RenderParagraph;

export type RenderSection = {
  scope: string;
  title: string;
  entries: RenderFact[];
  missingFields: string[];
  blocks?: RenderBlock[];
  presentationSource?: "scope_metadata" | "first_party_adapter" | "generic_projection";
};

export type ApprovedDisclosureRenderModel = {
  contractId: typeof APPROVED_DISCLOSURE_FORMATTER_CONTRACT_ID;
  contractVersion: "1.0.0";
  accountHolder: string;
  style: RedraftTransform;
  sections: RenderSection[];
  missingFields: string[];
  omittedInternalFields?: string[];
  missingPresentationMetadata?: string[];
};

export type ApprovedDisclosureRenderInput = {
  contractId: typeof APPROVED_DISCLOSURE_FORMATTER_CONTRACT_ID;
  accountHolder: string;
  selectedScopes: string[];
  sections: RenderSection[];
  redraftInstruction?: string | null;
};

const MAX_DRAFT_BODY_LENGTH = 12000;

const EMAIL_THEME = {
  accent: "#D4A847",
  accentBorder: "#E7C969",
  background: "#18181b",
  border: "#3f3f46",
  card: "#242426",
  chip: "#2f3033",
  heading: "#f8fafc",
  muted: "#a1a1aa",
  panel: "#1f2023",
  text: "#e5e7eb",
};

function normalizedObjectKey(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
}

function sentenceCase(value: string): string {
  const text = value.replace(/\s+/g, " ").trim();
  if (!text) return text;
  return `${text.charAt(0).toUpperCase()}${text.slice(1)}`;
}

function cleanSentence(value: string): string {
  const text = value.replace(/\s+/g, " ").trim();
  if (!text) return text;
  return /[.!?]$/.test(text) ? text : `${text}.`;
}

function escapeHtml(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function accountHolderSubject(label: string): string {
  const first = label.trim().split(/\s+/)[0] || label.trim();
  return first || "the account holder";
}

function normalizePreferencePhrase(value: string): string | null {
  const text = value
    .replace(/^actually[, ]*/i, "")
    .replace(/^prefers\s+/i, "")
    .replace(/^i\s+(now\s+)?prefer\s+/i, "")
    .replace(/^i\s+(usually\s+|generally\s+)?choose\s+/i, "")
    .replace(/\bwork(s)? better now\b/i, "")
    .replace(/\bare better now\b/i, "")
    .replace(/\bis better now\b/i, "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[.!?]+$/g, "")
    .trim();
  if (!text) return null;
  return text.charAt(0).toLowerCase() + text.slice(1);
}

function naturalApprovedSentence(params: {
  field: string;
  label: string;
  value: string;
  scope?: string | null;
  accountHolder: string;
}): string {
  if (params.value.includes("\n")) return params.value;
  const holder = accountHolderSubject(params.accountHolder);
  const normalizedField = params.field.toLowerCase();
  const normalizedLabel = params.label.toLowerCase();
  if (normalizedField === "portfolio" || params.scope?.includes("financial.portfolio")) {
    return `${sentenceCase(holder)}'s portfolio ${cleanSentence(params.value)}`;
  }
  if (normalizedField.includes("preference") || normalizedLabel.includes("preference")) {
    const phrase = normalizePreferencePhrase(params.value);
    if (phrase) return `${sentenceCase(holder)} prefers ${phrase}.`;
  }
  const verb = params.field.endsWith("s") || params.value.includes(",") ? "are" : "is";
  return `${sentenceCase(holder)}'s ${params.label} ${verb} ${cleanSentence(params.value)}`;
}

function parseDraftBullet(line: string): string {
  return line.replace(/^[-*]\s*/, "").trim();
}

function draftSubBlocks(value: string): string[] {
  return value
    .split(/\n{2,}/)
    .map((block) => block.trim())
    .filter(Boolean);
}

function draftBlockHeading(value: string): string {
  const lines = value.split("\n");
  return lines[0]?.trim() || "";
}

function isGenericSectionTitle(title: string): boolean {
  const key = normalizedObjectKey(title);
  return (
    key === "approved_information" ||
    key.endsWith("_information") ||
    key.endsWith("_details") ||
    key.endsWith("_data")
  );
}

function isRedundantEntryHeading(sectionTitle: string, heading: string): boolean {
  const sectionKey = normalizedObjectKey(sectionTitle);
  const headingKey = normalizedObjectKey(heading);
  return (
    headingKey === sectionKey ||
    headingKey === `${sectionKey}_summary` ||
    headingKey === `${sectionKey}_details`
  );
}

function hasMultipleHeadedSubBlocks(value: string): boolean {
  return (
    draftSubBlocks(value).filter((block) => {
      const heading = draftBlockHeading(block);
      return Boolean(
        heading &&
          !heading.startsWith("-") &&
          heading.length <= 80 &&
          !/[.!?]$/.test(heading)
      );
    }).length > 1
  );
}

function displayTitleForSection(sectionTitle: string, entryBlocks: string[]): string {
  if (entryBlocks.length !== 1) return sectionTitle;
  const entryHeading = draftBlockHeading(entryBlocks[0] || "");
  if (!entryHeading || entryHeading.startsWith("-")) return sectionTitle;
  if (entryHeading.length > 80 || /[.!?]$/.test(entryHeading)) return sectionTitle;
  if (isRedundantEntryHeading(sectionTitle, entryHeading)) return entryHeading;
  if (isGenericSectionTitle(sectionTitle) && !hasMultipleHeadedSubBlocks(entryBlocks[0] || "")) {
    return entryHeading;
  }
  return sectionTitle;
}

function stripDuplicateSectionHeading(value: string, sectionTitle: string): string {
  const lines = value.split("\n");
  const first = draftBlockHeading(value);
  if (first && normalizedObjectKey(first) === normalizedObjectKey(sectionTitle) && lines.length > 1) {
    return lines.slice(1).join("\n").trim();
  }
  return value;
}

function approvedEntryBlock(entry: RenderFact, model: ApprovedDisclosureRenderModel): string {
  if (model.style.human && !entry.value.includes("\n")) {
    return naturalApprovedSentence({
      field: entry.field,
      label: entry.label,
      value: entry.value,
      scope: entry.scope,
      accountHolder: model.accountHolder,
    });
  }
  if (entry.value.includes("\n")) {
    if (/^(Portfolio summary|Financial profile|Financial documents|Holdings)\n/.test(entry.value)) {
      return entry.value;
    }
    return `${sentenceCase(entry.label)}\n${entry.value}`;
  }
  return `- ${entry.label}: ${entry.value}`;
}

function sectionPlainBlocks(section: RenderSection, model: ApprovedDisclosureRenderModel): string[] {
  return section.entries
    .map((entry) => approvedEntryBlock(entry, model))
    .map((block) => stripDuplicateSectionHeading(block, section.title))
    .filter(Boolean);
}

function sectionDisplayTitle(section: RenderSection, blocks: string[]): string {
  return displayTitleForSection(section.title, blocks);
}

export function redraftTransformFromInstructions(instructions?: string): RedraftTransform {
  const text = String(instructions || "").toLowerCase();
  const human = /\b(human|natural|plain english|readable|less programmatic|rewrite|polish|polished|email)\b/.test(text);
  const structured = /\b(format|formatted|structure|structured|headings|sections|sectioned|readable|clean|beautiful)\b/.test(text);
  const table = /\b(table|tabular|columns|spreadsheet)\b/.test(text);
  return {
    compact: /\b(shorter|short|concise|summary|brief|direct|tighten)\b/.test(text),
    formal: /\b(formal|professional|polished)\b/.test(text),
    bulletList: structured || table || /\b(bullet|bullets|list)\b/.test(text),
    structured,
    table,
    fullDetail: /\b(full detail|all details|complete|everything|full)\b/.test(text),
    human,
    cleanHeaders: /\b(double headers?|duplicate headers?|remove headers?|clean headers?|headings?)\b/.test(text),
  };
}

export function buildApprovedDisclosurePlainText(
  renderModel: ApprovedDisclosureRenderModel
): string {
  const { accountHolder, missingFields, sections, style } = renderModel;
  const opening = style.formal
    ? `I am replying on behalf of ${accountHolder} with the approved information below.`
    : `I am replying on behalf of ${accountHolder}.`;
  const entries = sections.flatMap((section) => section.entries);
  const signature = "Best,\nhussh One";

  if (
    sections.length === 1 &&
    entries.length === 1 &&
    missingFields.length === 0 &&
    !style.bulletList &&
    !style.structured &&
    !style.table &&
    !style.fullDetail &&
    !style.human
  ) {
    const firstEntry = entries[0];
    if (!firstEntry) return `${opening}\n\n${signature}`;
    return `${opening}

${naturalApprovedSentence({
  field: firstEntry.field,
  label: firstEntry.label,
  value: firstEntry.value,
  scope: firstEntry.scope,
  accountHolder,
})}

${signature}`;
  }

  const sectionBlocks = sections
    .filter((section) => section.entries.length)
    .map((section) => {
      const blocks = sectionPlainBlocks(section, renderModel);
      const title = sectionDisplayTitle(section, blocks);
      return `${title}\n\n${blocks.join("\n\n")}`;
    })
    .join("\n\n");
  const missingLines = missingFields
    .map((field) => `- ${field.replaceAll("_", " ")}`)
    .join("\n");
  const missingCopy = missingLines
    ? `\nNot found in the approved data:\n${missingLines}\n`
    : "";

  return `${opening}

${sectionBlocks || "No requested values were present in the approved data."}
${missingCopy}
${signature}`.slice(0, MAX_DRAFT_BODY_LENGTH);
}

type DraftHoldingRow = {
  asset: string;
  quantity: string;
  value: string;
  price: string;
  gainLoss: string;
  type: string;
};

function parseDraftHoldingRow(line: string): DraftHoldingRow | null {
  const text = parseDraftBullet(line);
  const [rawAsset = "", rawDetails = ""] = text.split(/:\s*/, 2);
  const asset = rawAsset.trim();
  if (!asset) return null;
  const details = rawDetails
    .split(";")
    .map((item) => item.trim())
    .filter(Boolean);
  const row: DraftHoldingRow = {
    asset,
    quantity: "",
    value: "",
    price: "",
    gainLoss: "",
    type: "",
  };
  if (asset.toLowerCase() === "cash" && rawDetails.trim().startsWith("$")) {
    row.value = rawDetails.trim();
    return row;
  }
  for (const detail of details) {
    if (detail.endsWith(" shares")) {
      row.quantity = detail.replace(/\s+shares$/, "");
    } else if (detail.endsWith(" value")) {
      row.value = detail.replace(/\s+value$/, "");
    } else if (detail.endsWith(" per share")) {
      row.price = detail.replace(/\s+per share$/, "");
    } else if (detail.endsWith(" unrealized gain/loss")) {
      row.gainLoss = detail.replace(/\s+unrealized gain\/loss$/, "");
    } else if (!row.type) {
      row.type = detail;
    }
  }
  return row;
}

function blockToRenderBlocks(block: string): RenderBlock[] {
  const lines = block.split("\n").map((line) => line.trim()).filter(Boolean);
  const heading = lines[0] || "";
  const rest = lines.slice(1);
  const allBullets = lines.every((line) => /^[-*]\s+/.test(line));
  const restBullets = rest.length > 0 && rest.every((line) => /^[-*]\s+/.test(line));
  if (heading.toLowerCase() === "holdings" && restBullets) {
    const rows = rest
      .map(parseDraftHoldingRow)
      .filter((row): row is DraftHoldingRow => Boolean(row))
      .map((row) => [row.asset, row.quantity || "-", row.value || "-", row.price || "-", row.gainLoss || "-", row.type || "-"]);
    if (rows.length) {
      return [
        {
          kind: "table",
          title: "Holdings",
          columns: ["Asset", "Quantity", "Value", "Price", "Gain/loss", "Type"],
          rows,
          minWidth: 720,
        },
      ];
    }
  }
  if (restBullets) {
    return [
      {
        kind: "list",
        title: heading,
        items: rest.map(parseDraftBullet),
      },
    ];
  }
  if (allBullets) {
    return [
      {
        kind: "list",
        title: "",
        items: lines.map(parseDraftBullet),
      },
    ];
  }
  return [{ kind: "paragraph", text: block }];
}

function renderBlocksForSection(
  section: RenderSection,
  model: ApprovedDisclosureRenderModel
): { title: string; blocks: RenderBlock[] } {
  if (section.blocks?.length) {
    return { title: section.title, blocks: section.blocks };
  }
  const plainBlocks = sectionPlainBlocks(section, model);
  const title = sectionDisplayTitle(section, plainBlocks);
  const blocks = plainBlocks.flatMap((block) => draftSubBlocks(block).flatMap(blockToRenderBlocks));
  return { title, blocks };
}

function htmlParagraph(block: string): string {
  return `<p style="margin:0;color:${EMAIL_THEME.text};font-size:15px;line-height:1.6;white-space:pre-wrap;">${escapeHtml(block)}</p>`;
}

function htmlList(block: RenderList): string {
  const items = block.items
    .map((item) => {
      const [rawLabel = "", ...valueParts] = item.split(":");
      const label = rawLabel.trim();
      const value = valueParts.join(":").trim();
      if (!label || !value) {
        return `<li style="margin:0 0 8px;color:${EMAIL_THEME.text};line-height:1.5;">${escapeHtml(item)}</li>`;
      }
      return `<td style="width:50%;padding:6px;vertical-align:top;word-break:break-word;"><div style="border:1px solid ${EMAIL_THEME.border};border-radius:12px;background:${EMAIL_THEME.panel};padding:12px;"><div style="font-size:11px;letter-spacing:0.08em;text-transform:uppercase;color:${EMAIL_THEME.muted};font-weight:700;">${escapeHtml(label)}</div><div style="margin-top:5px;font-size:15px;line-height:1.4;color:${EMAIL_THEME.heading};font-weight:650;word-break:break-word;">${escapeHtml(value)}</div></div></td>`;
    });
  const keyValueCells = items.every((item) => item.startsWith("<td"));
  if (!keyValueCells) {
    const listItems = block.items
      .map((item) => `<li style="margin:0 0 8px;color:${EMAIL_THEME.text};line-height:1.5;">${escapeHtml(item)}</li>`)
      .join("");
    const title = block.title
      ? `<h2 style="margin:0 0 10px;color:${EMAIL_THEME.heading};font-size:17px;line-height:1.25;">${escapeHtml(block.title)}</h2>`
      : "";
    return `<section style="margin:0;">${title}<ul style="margin:0;padding-left:20px;">${listItems}</ul></section>`;
  }
  const rows = items
    .reduce<string[]>((acc, cell, index) => {
      if (index % 2 === 0) acc.push(`<tr>${cell}`);
      else acc[acc.length - 1] = `${acc[acc.length - 1]}${cell}</tr>`;
      return acc;
    }, [])
    .map((row) => (row.endsWith("</tr>") ? row : `${row}<td style="width:50%;padding:6px;"></td></tr>`))
    .join("");
  return `<section style="margin:0;"><h2 style="margin:0 0 10px;color:${EMAIL_THEME.heading};font-size:17px;line-height:1.25;">${escapeHtml(block.title)}</h2><table role="presentation" cellpadding="0" cellspacing="0" style="width:100%;max-width:100%;border-collapse:collapse;table-layout:fixed;"><tbody>${rows}</tbody></table></section>`;
}

function htmlTable(block: RenderTable): string {
  const header = block.columns
    .map((column) => `<th align="left" style="padding:8px 10px;color:${EMAIL_THEME.muted};font-size:10px;letter-spacing:0.08em;text-transform:uppercase;white-space:nowrap;">${escapeHtml(column)}</th>`)
    .join("");
  const rows = block.rows
    .map((row) => `<tr>${row
      .map((cell, index) => `<td style="padding:8px 10px;border-top:1px solid ${EMAIL_THEME.border};${index === 0 ? `font-weight:700;color:${EMAIL_THEME.heading};` : `color:${EMAIL_THEME.text};`}white-space:nowrap;">${escapeHtml(cell || "-")}</td>`)
      .join("")}</tr>`)
    .join("");
  return `<section style="margin:0;"><h2 style="margin:0 0 10px;color:${EMAIL_THEME.heading};font-size:17px;line-height:1.25;">${escapeHtml(block.title)}</h2><div style="width:100%;max-width:100%;overflow-x:auto;overflow-y:hidden;-webkit-overflow-scrolling:touch;border:1px solid ${EMAIL_THEME.border};border-radius:14px;background:${EMAIL_THEME.panel};"><table cellpadding="0" cellspacing="0" style="width:${block.minWidth}px;min-width:${block.minWidth}px;max-width:none;border-collapse:collapse;font-size:13px;table-layout:auto;"><thead><tr style="background:${EMAIL_THEME.chip};">${header}</tr></thead><tbody>${rows}</tbody></table></div></section>`;
}

function htmlRenderBlock(block: RenderBlock): string {
  if (block.kind === "paragraph") return htmlParagraph(block.text);
  if (block.kind === "list") return htmlList(block);
  if (block.kind === "table") return htmlTable(block);
  return `<div style="border:1px solid ${EMAIL_THEME.border};border-radius:12px;background:${EMAIL_THEME.panel};padding:12px;"><div style="font-size:11px;letter-spacing:0.08em;text-transform:uppercase;color:${EMAIL_THEME.muted};font-weight:700;">${escapeHtml(block.label)}</div><div style="margin-top:5px;font-size:15px;line-height:1.4;color:${EMAIL_THEME.heading};font-weight:650;word-break:break-word;">${escapeHtml(block.value)}</div></div>`;
}

export function buildApprovedDisclosureHtml(model: ApprovedDisclosureRenderModel): string {
  const opening = model.style.formal
    ? `I am replying on behalf of ${model.accountHolder} with the approved information below.`
    : `I am replying on behalf of ${model.accountHolder}.`;
  const entries = model.sections.flatMap((section) => section.entries);
  const canRenderAsDirectAnswer =
    model.sections.length === 1 &&
    entries.length === 1 &&
    model.missingFields.length === 0 &&
    !model.style.bulletList &&
    !model.style.structured &&
    !model.style.table &&
    !model.style.fullDetail &&
    !model.style.human;
  const sections = model.sections
    .filter((section) => section.entries.length)
    .map((section) => {
      const rendered = renderBlocksForSection(section, model);
      const title = canRenderAsDirectAnswer
        ? ""
        : rendered.title
        ? `<h1 style="margin:0;color:${EMAIL_THEME.heading};font-size:24px;line-height:1.15;">${escapeHtml(rendered.title)}</h1>`
        : "";
      const blocks = rendered.blocks.map(htmlRenderBlock).join('<div style="height:14px;line-height:14px;">&nbsp;</div>');
      return `<section style="margin:0;">${title}${title ? '<div style="height:14px;line-height:14px;">&nbsp;</div>' : ""}${blocks}</section>`;
    })
    .join('<div style="height:20px;line-height:20px;">&nbsp;</div>');
  const content = [
    htmlParagraph(opening),
    sections || htmlParagraph("No requested values were present in the approved data."),
    `<p style="margin:0;padding-top:14px;border-top:1px solid ${EMAIL_THEME.border};color:${EMAIL_THEME.heading};font-weight:650;line-height:1.5;">Best,<br/>hussh One</p>`,
  ].join('<div style="height:18px;line-height:18px;">&nbsp;</div>');

  return `<div style="margin:0;padding:16px;background:${EMAIL_THEME.background};font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif;"><div style="width:100%;max-width:820px;margin:0 auto;border:1px solid ${EMAIL_THEME.border};border-radius:18px;background:${EMAIL_THEME.card};overflow:hidden;"><div style="padding:16px 20px;border-bottom:1px solid ${EMAIL_THEME.border};background:${EMAIL_THEME.panel};"><table role="presentation" cellpadding="0" cellspacing="0" style="border-collapse:collapse;"><tr><td style="width:42px;vertical-align:middle;"><div style="width:34px;height:34px;border-radius:12px;border:1px solid ${EMAIL_THEME.accentBorder};background:${EMAIL_THEME.accent};color:${EMAIL_THEME.background};font-size:19px;line-height:34px;text-align:center;font-weight:800;">🤫</div></td><td style="vertical-align:middle;"><div style="font-size:14px;line-height:1.2;color:${EMAIL_THEME.heading};font-weight:800;">hussh One</div><div style="margin-top:2px;font-size:11px;letter-spacing:0.12em;text-transform:uppercase;color:${EMAIL_THEME.accent};font-weight:750;">approved reply</div></td></tr></table></div><div style="padding:20px;">${content}</div></div></div>`;
}
