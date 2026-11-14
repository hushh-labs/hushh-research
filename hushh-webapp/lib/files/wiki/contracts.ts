/** Closed identifiers, refusal errors, and canonical Markdown contracts for Shared wiki/v1. */

export const MAX_PAGE_BODY_CHARS = 64_000;
export const MAX_TLDR_CHARS = 600;
export const MAX_CLAIM_CHARS = 1_000;
export const MAX_CLAIMS_PER_PAGE = 256;
export const MAX_LINKS_PER_PAGE = 256;
export const MAX_SOURCES_PER_PAGE = 256;
export const MAX_BATCH_PAGES = 32;
export const MAX_NOTE_CHARS = 280;

export const CLAIM_STATUSES = [
  "active",
  "superseded",
  "uncertain",
  "retracted",
] as const;
export type WikiClaimStatus = (typeof CLAIM_STATUSES)[number];

export const LINK_RELATIONS = [
  "related",
  "supports",
  "contradicts",
  "supersedes",
  "part_of",
] as const;
export type WikiLinkRelation = (typeof LINK_RELATIONS)[number];

export const SOURCE_KINDS = [
  "chat_turn",
  "file_object",
  "pkm_record",
  "live_activity",
  "owner_direct",
] as const;
export type WikiSourceKind = (typeof SOURCE_KINDS)[number];

const RESERVED_GENERATED_HEADINGS = new Set([
  "tl;dr",
  "claims",
  "relations",
  "sources",
]);

const PAGE_ID_RE = /^wpg_[0-9a-f]{16}$/;
const CLAIM_ID_RE = /^wcl_[0-9a-f]{16}$/;
const SOURCE_ID_RE = /^wsr_[0-9a-f]{16}$/;
const BATCH_ID_RE = /^wbt_[0-9a-f]{16}$/;
const TOMBSTONE_ID_RE = /^wtb_[0-9a-f]{16}$/;
const SHA256_RE = /^[0-9a-f]{64}$/i;
const DATE_RE = /^\d{4}-\d{2}-\d{2}(?:[T ][^\r\n]{1,40})?$/;
const INLINE_LINK_RE =
  /\[\[(wpg_[0-9a-f]{16})(?:#(wcl_[0-9a-f]{16}))?(?:\|([^\]\r\n]{1,160}))?\]\]/g;
const HEADING_RE = /^(#{2,6})\s+(.+?)\s*$/gm;

export class WikiRefusedError extends Error {
  constructor(
    public readonly code: string,
    public readonly status = 409,
  ) {
    super(code);
    this.name = "WikiRefusedError";
  }
}

export interface WikiSourceRef {
  source_id: string;
  kind: WikiSourceKind;
  locator: string;
  content_sha256: string;
  observed_at: string;
  consent_derived?: boolean;
}

export interface WikiClaim {
  claim_id: string;
  statement: string;
  status?: WikiClaimStatus;
  confidence?: number;
  source_ids?: string[];
  observed_at?: string;
  valid_until?: string;
  superseded_by?: string;
}

export interface NormalizedWikiClaim {
  claim_id: string;
  statement: string;
  status: WikiClaimStatus;
  confidence: number;
  source_ids: string[];
  observed_at: string;
  valid_until?: string;
  superseded_by?: string;
}

export interface WikiLinkEdge {
  target_page_id: string;
  relation?: WikiLinkRelation;
  anchor_claim_id?: string;
  note?: string;
}

export interface NormalizedWikiLinkEdge {
  target_page_id: string;
  relation: WikiLinkRelation;
  anchor_claim_id?: string;
  note?: string;
}

export interface StoredWikiPageRevision {
  format: 1;
  page_id: string;
  revision: number;
  title: string;
  folder: string;
  tldr: string;
  status_as_of: string;
  body: string;
  claims: NormalizedWikiClaim[];
  links: NormalizedWikiLinkEdge[];
  source_ids: string[];
  updated_at: number;
}

export interface PublicWikiPage extends Omit<StoredWikiPageRevision, "format"> {
  content_sha256: string;
  markdown: string;
  pending_batch_id?: string;
}

export function validatePageId(value: unknown): string {
  if (typeof value !== "string" || !PAGE_ID_RE.test(value)) {
    throw new WikiRefusedError("WIKI_INVALID_ID", 400);
  }
  return value;
}

export function validateClaimId(value: unknown): string {
  if (typeof value !== "string" || !CLAIM_ID_RE.test(value)) {
    throw new WikiRefusedError("WIKI_INVALID_ID", 400);
  }
  return value;
}

export function validateSourceId(value: unknown): string {
  if (typeof value !== "string" || !SOURCE_ID_RE.test(value)) {
    throw new WikiRefusedError("WIKI_INVALID_ID", 400);
  }
  return value;
}

export function validateBatchId(value: unknown): string {
  if (typeof value !== "string" || !BATCH_ID_RE.test(value)) {
    throw new WikiRefusedError("WIKI_INVALID_ID", 400);
  }
  return value;
}

export function validateTombstoneId(value: unknown): string {
  if (typeof value !== "string" || !TOMBSTONE_ID_RE.test(value)) {
    throw new WikiRefusedError("WIKI_INVALID_ID", 400);
  }
  return value;
}

export function validateIdempotencyKey(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length < 4 ||
    value.length > 128 ||
    /[\x00-\x1f\x7f]/.test(value)
  ) {
    throw new WikiRefusedError("WIKI_SCHEMA_INVALID", 400);
  }
  return value;
}

export function validateTitle(value: unknown): string {
  if (typeof value !== "string") {
    throw new WikiRefusedError("WIKI_INVALID_TITLE", 400);
  }
  const cleaned = value.trim();
  if (!cleaned || cleaned.length > 200 || /[\x00-\x1f]/.test(cleaned)) {
    throw new WikiRefusedError("WIKI_INVALID_TITLE", 400);
  }
  return cleaned;
}

export function validateFolder(value: unknown): string {
  if (typeof value !== "string") {
    throw new WikiRefusedError("WIKI_INVALID_FOLDER", 400);
  }
  const cleaned = value.trim().replace(/^\/+|\/+$/g, "") || "root";
  if (cleaned === "root") return "root";
  if (
    cleaned.length > 128 ||
    cleaned.includes("\\") ||
    /[\x00-\x1f]/.test(cleaned)
  ) {
    throw new WikiRefusedError("WIKI_INVALID_FOLDER", 400);
  }
  const segments = cleaned.split("/");
  if (segments.length > 8) {
    throw new WikiRefusedError("WIKI_INVALID_FOLDER", 400);
  }
  for (const seg of segments) {
    if (
      !seg ||
      seg === "." ||
      seg === ".." ||
      seg === "root" ||
      !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(seg)
    ) {
      throw new WikiRefusedError("WIKI_INVALID_FOLDER", 400);
    }
  }
  return cleaned;
}

export function validateIsoDate(value: unknown): string {
  if (typeof value !== "string" || !DATE_RE.test(value.trim())) {
    throw new WikiRefusedError("WIKI_SCHEMA_INVALID", 400);
  }
  return value.trim();
}

export function normalizeSourceRef(input: WikiSourceRef): Required<WikiSourceRef> {
  if (!input || typeof input !== "object") {
    throw new WikiRefusedError("WIKI_SCHEMA_INVALID", 400);
  }
  if (
    input.consent_derived !== undefined &&
    typeof input.consent_derived !== "boolean"
  ) {
    throw new WikiRefusedError("WIKI_SCHEMA_INVALID", 400);
  }
  if (input.consent_derived === true) {
    throw new WikiRefusedError("WIKI_SOURCE_INELIGIBLE", 403);
  }
  if (!SOURCE_KINDS.includes(input.kind)) {
    throw new WikiRefusedError("WIKI_SCHEMA_INVALID", 400);
  }
  const locator = typeof input.locator === "string" ? input.locator.trim() : "";
  if (!locator || locator.length > 256 || /[\x00-\x1f]/.test(locator)) {
    throw new WikiRefusedError("WIKI_SCHEMA_INVALID", 400);
  }
  if (
    typeof input.content_sha256 !== "string" ||
    !SHA256_RE.test(input.content_sha256)
  ) {
    throw new WikiRefusedError("WIKI_SCHEMA_INVALID", 400);
  }
  return {
    source_id: validateSourceId(input.source_id),
    kind: input.kind,
    locator,
    content_sha256: input.content_sha256.toLowerCase(),
    observed_at: validateIsoDate(input.observed_at),
    consent_derived: false,
  };
}

export function normalizeClaim(input: WikiClaim): NormalizedWikiClaim {
  if (!input || typeof input !== "object") {
    throw new WikiRefusedError("WIKI_SCHEMA_INVALID", 400);
  }
  const statement =
    typeof input.statement === "string" ? input.statement.trim() : "";
  if (
    !statement ||
    statement.length > MAX_CLAIM_CHARS ||
    /[\x00-\x08\x0b-\x1f]/.test(statement)
  ) {
    throw new WikiRefusedError("WIKI_SCHEMA_INVALID", 400);
  }
  const status = input.status ?? "active";
  if (!CLAIM_STATUSES.includes(status)) {
    throw new WikiRefusedError("WIKI_SCHEMA_INVALID", 400);
  }
  const confidence = input.confidence ?? 1.0;
  if (
    typeof confidence !== "number" ||
    Number.isNaN(confidence) ||
    confidence < 0 ||
    confidence > 1
  ) {
    throw new WikiRefusedError("WIKI_SCHEMA_INVALID", 400);
  }
  const rawSources = input.source_ids ?? [];
  if (!Array.isArray(rawSources) || rawSources.length > MAX_SOURCES_PER_PAGE) {
    throw new WikiRefusedError("WIKI_SCHEMA_INVALID", 400);
  }
  const source_ids = [...new Set(rawSources.map((id) => validateSourceId(id)))];
  const valid_until =
    input.valid_until !== undefined
      ? validateIsoDate(input.valid_until)
      : undefined;
  const superseded_by =
    input.superseded_by !== undefined
      ? validateClaimId(input.superseded_by)
      : undefined;
  if (status === "superseded" && !superseded_by) {
    throw new WikiRefusedError("WIKI_SCHEMA_INVALID", 400);
  }
  return {
    claim_id: validateClaimId(input.claim_id),
    statement,
    status,
    confidence: Math.round(confidence * 10_000) / 10_000,
    source_ids,
    observed_at: validateIsoDate(input.observed_at ?? "2026-01-01"),
    ...(valid_until ? { valid_until } : {}),
    ...(superseded_by ? { superseded_by } : {}),
  };
}

export function normalizeLinkEdge(input: WikiLinkEdge): NormalizedWikiLinkEdge {
  if (!input || typeof input !== "object") {
    throw new WikiRefusedError("WIKI_SCHEMA_INVALID", 400);
  }
  const relation = input.relation ?? "related";
  if (!LINK_RELATIONS.includes(relation)) {
    throw new WikiRefusedError("WIKI_SCHEMA_INVALID", 400);
  }
  const anchor_claim_id =
    input.anchor_claim_id !== undefined
      ? validateClaimId(input.anchor_claim_id)
      : undefined;
  const note = typeof input.note === "string" ? input.note.trim() : "";
  if (note.length > MAX_NOTE_CHARS || /[\x00-\x1f]/.test(note)) {
    throw new WikiRefusedError("WIKI_SCHEMA_INVALID", 400);
  }
  return {
    target_page_id: validatePageId(input.target_page_id),
    relation,
    ...(anchor_claim_id ? { anchor_claim_id } : {}),
    ...(note ? { note } : {}),
  };
}

export function extractInlineLinks(
  body: string,
  selfPageId = "",
): NormalizedWikiLinkEdge[] {
  const seen = new Map<string, NormalizedWikiLinkEdge>();
  for (const match of body.matchAll(INLINE_LINK_RE)) {
    const target = match[1];
    if (!target || target === selfPageId) continue;
    const anchor = match[2];
    const label = (match[3] ?? "").trim().slice(0, MAX_NOTE_CHARS);
    const key = `${target}|related|${anchor ?? ""}`;
    if (!seen.has(key)) {
      seen.set(key, {
        target_page_id: target,
        relation: "related",
        ...(anchor ? { anchor_claim_id: anchor } : {}),
        ...(label ? { note: label } : {}),
      });
    }
  }
  return [...seen.values()];
}

export function buildRevisionRecord(input: {
  page_id: string;
  revision: number;
  title: string;
  folder?: string;
  tldr?: string;
  status_as_of?: string;
  body?: string;
  claims?: WikiClaim[];
  links?: WikiLinkEdge[];
  source_ids?: string[];
  updated_at: number;
}): StoredWikiPageRevision {
  const page_id = validatePageId(input.page_id);
  if (!Number.isSafeInteger(input.revision) || input.revision < 1) {
    throw new WikiRefusedError("WIKI_SCHEMA_INVALID", 400);
  }
  if (!Number.isSafeInteger(input.updated_at) || input.updated_at < 0) {
    throw new WikiRefusedError("WIKI_SCHEMA_INVALID", 400);
  }
  const tldr = typeof input.tldr === "string" ? input.tldr.trim() : "";
  if (tldr.length > MAX_TLDR_CHARS) {
    throw new WikiRefusedError("WIKI_SCHEMA_INVALID", 400);
  }
  const rawBody = typeof input.body === "string" ? input.body : "";
  if (rawBody.length > MAX_PAGE_BODY_CHARS || rawBody.includes("\x00")) {
    throw new WikiRefusedError("WIKI_SCHEMA_INVALID", 400);
  }
  const body = rawBody.replace(/\r\n/g, "\n").trim();

  const rawClaims = input.claims ?? [];
  if (!Array.isArray(rawClaims) || rawClaims.length > MAX_CLAIMS_PER_PAGE) {
    throw new WikiRefusedError("WIKI_SCHEMA_INVALID", 400);
  }
  const claims: NormalizedWikiClaim[] = [];
  const seenClaims = new Set<string>();
  for (const item of rawClaims) {
    const normalized = normalizeClaim(item);
    if (seenClaims.has(normalized.claim_id)) {
      throw new WikiRefusedError("WIKI_SCHEMA_INVALID", 400);
    }
    seenClaims.add(normalized.claim_id);
    claims.push(normalized);
  }

  const mergedLinks = new Map<string, NormalizedWikiLinkEdge>();
  for (const item of input.links ?? []) {
    const edge = normalizeLinkEdge(item);
    if (edge.target_page_id === page_id) continue;
    mergedLinks.set(
      `${edge.target_page_id}|${edge.relation}|${edge.anchor_claim_id ?? ""}`,
      edge,
    );
  }
  for (const edge of extractInlineLinks(body, page_id)) {
    const key = `${edge.target_page_id}|${edge.relation}|${edge.anchor_claim_id ?? ""}`;
    if (!mergedLinks.has(key)) mergedLinks.set(key, edge);
  }
  if (mergedLinks.size > MAX_LINKS_PER_PAGE) {
    throw new WikiRefusedError("WIKI_SCHEMA_INVALID", 400);
  }
  const links = [...mergedLinks.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([, edge]) => edge);

  const collectedSources = [
    ...(input.source_ids ?? []).map((id) => validateSourceId(id)),
    ...claims.flatMap((claim) => claim.source_ids),
  ];
  const source_ids = [...new Set(collectedSources)];
  if (source_ids.length > MAX_SOURCES_PER_PAGE) {
    throw new WikiRefusedError("WIKI_SCHEMA_INVALID", 400);
  }

  return {
    format: 1,
    page_id,
    revision: input.revision,
    title: validateTitle(input.title),
    folder: validateFolder(input.folder ?? "root"),
    tldr,
    status_as_of: validateIsoDate(input.status_as_of ?? "2026-01-01"),
    body,
    claims,
    links,
    source_ids,
    updated_at: input.updated_at,
  };
}

export function renderWikiMarkdown(page: StoredWikiPageRevision): string {
  const lines: string[] = [
    "---",
    `page_id: ${page.page_id}`,
    `revision: ${page.revision}`,
    `title: ${JSON.stringify(page.title)}`,
    `folder: ${page.folder}`,
    `status_as_of: ${page.status_as_of}`,
    `updated_at: ${page.updated_at}`,
    "---",
    "",
    `# ${page.title}`,
    "",
    `Status as of ${page.status_as_of}`,
  ];
  if (page.tldr) {
    lines.push("", "## TL;DR", "", page.tldr);
  }
  if (page.body) {
    lines.push("", page.body);
  }
  if (page.claims.length > 0) {
    lines.push("", "## Claims", "");
    for (const claim of page.claims) {
      const cite =
        claim.source_ids.length > 0
          ? ` (sources: ${claim.source_ids.join(", ")})`
          : "";
      const sup = claim.superseded_by
        ? ` [superseded_by: ${claim.superseded_by}]`
        : "";
      lines.push(
        `- [${claim.claim_id}] (${claim.status}, confidence=${claim.confidence.toFixed(2)}) ${claim.statement}${sup}${cite}`,
      );
    }
  }
  if (page.links.length > 0) {
    lines.push("", "## Relations", "");
    for (const edge of page.links) {
      const anchor = edge.anchor_claim_id ? `#${edge.anchor_claim_id}` : "";
      const note = edge.note ? ` — ${edge.note}` : "";
      lines.push(
        `- ${edge.relation}: [[${edge.target_page_id}${anchor}]]${note}`,
      );
    }
  }
  if (page.source_ids.length > 0) {
    lines.push("", "## Sources", "");
    for (const src of page.source_ids) {
      lines.push(`- ${src}`);
    }
  }
  return `${lines.join("\n")}\n`;
}

export function replaceMarkdownSection(
  body: string,
  options: {
    heading: string;
    content: string | null;
    level?: number;
    createIfMissing?: boolean;
  },
): string {
  if (
    typeof options.heading !== "string" ||
    !options.heading.trim() ||
    options.heading.includes("\n")
  ) {
    throw new WikiRefusedError("WIKI_SCHEMA_INVALID", 400);
  }
  const normalizedHeading = options.heading.trim().replace(/^#+\s*/, "").trim();
  if (!normalizedHeading || normalizedHeading.length > 120) {
    throw new WikiRefusedError("WIKI_SCHEMA_INVALID", 400);
  }
  if (RESERVED_GENERATED_HEADINGS.has(normalizedHeading.toLowerCase())) {
    throw new WikiRefusedError("WIKI_SECTION_RESERVED", 400);
  }
  const level = options.level ?? 2;
  if (!Number.isSafeInteger(level) || level < 2 || level > 6) {
    throw new WikiRefusedError("WIKI_SCHEMA_INVALID", 400);
  }

  const normalizedBody = body.replace(/\r\n/g, "\n");
  const matches = [...normalizedBody.matchAll(HEADING_RE)];
  const targetIdx = matches.findIndex(
    (m) => (m[2] ?? "").trim().toLowerCase() === normalizedHeading.toLowerCase(),
  );
  const cleanContent =
    options.content === null
      ? null
      : options.content.replace(/\r\n/g, "\n").trim();

  const targetMatch = targetIdx >= 0 ? matches[targetIdx] : undefined;
  if (!targetMatch) {
    if (cleanContent === null || options.createIfMissing === false) {
      throw new WikiRefusedError("WIKI_NOT_FOUND", 404);
    }
    const block = `${"#".repeat(level)} ${normalizedHeading}\n\n${cleanContent}`.trim();
    return normalizedBody.trim()
      ? `${normalizedBody.trim()}\n\n${block}`
      : block;
  }

  const targetLevel = (targetMatch[1] ?? "##").length;
  const start = targetMatch.index ?? 0;
  let end = normalizedBody.length;
  for (let idx = targetIdx + 1; idx < matches.length; idx++) {
    const nextMatch = matches[idx];
    if (nextMatch && (nextMatch[1] ?? "").length <= targetLevel) {
      end = nextMatch.index ?? normalizedBody.length;
      break;
    }
  }

  const prefix = normalizedBody.slice(0, start).trimEnd();
  const suffix = normalizedBody.slice(end).replace(/^\n+/, "").trim();
  if (cleanContent === null) {
    return [prefix, suffix].filter(Boolean).join("\n\n").trim();
  }
  const headingLine = `${"#".repeat(targetLevel)} ${(targetMatch[2] ?? normalizedHeading).trim()}`;
  const replacement = cleanContent
    ? `${headingLine}\n\n${cleanContent}`
    : headingLine;
  return [prefix, replacement, suffix].filter(Boolean).join("\n\n").trim();
}

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record)
    .filter((k) => record[k] !== undefined)
    .sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(record[k])}`).join(",")}}`;
}

export async function sha256Hex(text: string): Promise<string> {
  const bytes = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new Uint8Array(bytes).buffer,
  );
  return Array.from(new Uint8Array(digest), (b) =>
    b.toString(16).padStart(2, "0"),
  ).join("");
}
