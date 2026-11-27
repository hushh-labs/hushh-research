// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 Hushh
/**
 * Resource-bounded ChatGPT and Claude export archive ingestion for Shared / Browser Personal Wiki (#9429).
 *
 * Mirrors `consent-protocol/hushh_mcp/services/wiki_memory/archive_import.py`:
 * - Enforces strict compressed/uncompressed byte ceilings, entry count limits, compression
 *   ratio caps, nested-archive refusal, and path-traversal refusal before JSON parsing.
 * - Normalizes ChatGPT (`conversations.json`, `memories.json`) and Claude (`conversations.json`,
 *   `memories.json`, `projects.json`) exports using only owner-originated (`user` / `human` and
 *   explicit saved-memory) records as claim-eligible evidence; assistant turns are never self-cited.
 * - Scrubs secret spans prior to hashing or persistence, enforces tombstone non-resurrection,
 *   marks compiled wiki pages and receipts as untrusted external source records, and holds
 *   candidate PKM projections in `private_candidate` (`requireOwnerConfirmation: true`).
 */

import { unzipSync } from "fflate";

import {
  MAX_BATCH_PAGES,
  MAX_CLAIM_CHARS,
  MAX_CLAIMS_PER_PAGE,
  MAX_PAGE_BODY_CHARS,
  MAX_SOURCES_PER_PAGE,
  MAX_TLDR_CHARS,
  WikiRefusedError,
  sha256Hex,
  validateIdempotencyKey,
  validateProjectionDomain,
  validateProjectionJsonPath,
  type WikiClaim,
} from "./contracts";
import { SharedWikiLibrary, type SynthesisBatchItemInput } from "./library";
import { normalizeStatementFingerprint } from "./migration-and-maintenance";
import { SharedWikiProjectionEngine } from "./projections";
import { SharedWikiKnowledgeWriter, stripSecretSpansForWiki } from "./writer";

export const ARCHIVE_IMPORT_SCHEMA = "hussh.wiki.archive_import.v1";
export const ARCHIVE_IMPORTS_CHECKPOINT = "archive_imports";
const TOMBSTONE_FINGERPRINTS_CHECKPOINT = "tombstone_fingerprints";

export const MAX_ARCHIVE_COMPRESSED_BYTES = 16 * 1024 * 1024; // 16 MiB
export const MAX_ARCHIVE_UNCOMPRESSED_BYTES = 24 * 1024 * 1024; // 24 MiB
export const MAX_ARCHIVE_SINGLE_ENTRY_BYTES = 16 * 1024 * 1024; // 16 MiB
export const MAX_ARCHIVE_ENTRIES = 64;
export const MAX_COMPRESSION_RATIO = 40;
const RATIO_CHECK_MIN_BYTES = 64 * 1024;
const MAX_CONVERSATIONS_PER_IMPORT = 24;
const MAX_CLAIMS_PER_CONVERSATION = 32;

export type ArchiveSourceProvider = "auto" | "chatgpt" | "claude";

export interface NormalizedArchiveRecord {
  provider: "chatgpt" | "claude";
  recordKind: "conversation" | "saved_memory";
  externalId: string;
  title: string;
  observedAt: string;
  statements: string[];
  candidateProjections: Array<[string, string]>;
}

const DISALLOWED_NESTED_SUFFIXES = [
  ".zip",
  ".tar",
  ".gz",
  ".tgz",
  ".bz2",
  ".xz",
  ".7z",
  ".rar",
];

const CREDENTIAL_RESIDUAL_WORDS = new Set([
  "api_key",
  "apikey",
  "api-key",
  "password",
  "passwd",
  "secret",
  "token",
  "bearer",
  "pin",
  "cvv",
  "cvc",
]);

function cleanText(raw: unknown, limit = MAX_CLAIM_CHARS): string {
  if (typeof raw !== "string") return "";
  const { scrubbed } = stripSecretSpansForWiki(raw);
  const collapsed = scrubbed.replace(/\s+/g, " ").trim();
  if (!collapsed) return "";
  const residual = collapsed
    .replaceAll("[credential omitted]", "")
    .replace(/^[\s.,:;=-]+|[\s.,:;=-]+$/g, "");
  if (!residual || CREDENTIAL_RESIDUAL_WORDS.has(residual.toLowerCase())) {
    return "";
  }
  if (collapsed.length > limit) {
    return `${collapsed.slice(0, limit - 1).trimEnd()}…`;
  }
  return collapsed;
}

function isoDate(raw: unknown): string {
  if (typeof raw === "number" && Number.isFinite(raw) && raw > 0) {
    const ms = raw > 1e12 ? raw : raw * 1000;
    const d = new Date(ms);
    if (!Number.isNaN(d.getTime())) {
      return d.toISOString().slice(0, 10);
    }
  }
  if (typeof raw === "string") {
    const trimmed = raw.trim();
    if (/^\d{4}-\d{2}-\d{2}/.test(trimmed)) {
      return trimmed.slice(0, 10);
    }
  }
  return new Date().toISOString().slice(0, 10);
}

function validateArchiveEntryPath(rawName: string): string {
  if (!rawName || rawName.includes("\x00") || rawName.includes("\\")) {
    throw new WikiRefusedError("WIKI_ARCHIVE_UNSAFE", 400);
  }
  if (rawName.startsWith("/") || /^[A-Za-z]:/.test(rawName)) {
    throw new WikiRefusedError("WIKI_ARCHIVE_UNSAFE", 400);
  }
  const parts = rawName.split("/").filter((seg) => seg.length > 0);
  if (
    parts.length === 0 ||
    parts.some((seg) => seg === "." || seg === "..")
  ) {
    throw new WikiRefusedError("WIKI_ARCHIVE_UNSAFE", 400);
  }
  const normalized = parts.join("/");
  const lower = normalized.toLowerCase();
  if (DISALLOWED_NESTED_SUFFIXES.some((ext) => lower.endsWith(ext))) {
    throw new WikiRefusedError("WIKI_ARCHIVE_UNSAFE", 400);
  }
  return normalized;
}

function isZipHeader(bytes: Uint8Array): boolean {
  return (
    bytes.byteLength >= 4 &&
    bytes[0] === 0x50 &&
    bytes[1] === 0x4b &&
    (bytes[2] === 0x03 || bytes[2] === 0x05 || bytes[2] === 0x07) &&
    (bytes[3] === 0x04 || bytes[3] === 0x06 || bytes[3] === 0x08)
  );
}

async function sha256BytesHex(bytes: Uint8Array): Promise<string> {
  const buf = new Uint8Array(bytes).buffer;
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", buf));
  return Array.from(digest, (b) => b.toString(16).padStart(2, "0")).join("");
}

export function extractArchiveJsonDocuments(
  rawInput: Uint8Array,
  fileName = "export.zip",
): Record<string, unknown> {
  if (!ArrayBuffer.isView(rawInput) || rawInput.byteLength === 0) {
    throw new WikiRefusedError("WIKI_ARCHIVE_EMPTY", 400);
  }
  const rawBytes = new Uint8Array(
    rawInput.buffer,
    rawInput.byteOffset,
    rawInput.byteLength,
  );
  if (rawBytes.byteLength > MAX_ARCHIVE_COMPRESSED_BYTES) {
    throw new WikiRefusedError("WIKI_ARCHIVE_TOO_LARGE", 413);
  }

  const decoder = new TextDecoder("utf-8", { fatal: true });
  const documents: Record<string, unknown> = {};

  if (!isZipHeader(rawBytes)) {
    if (rawBytes.byteLength > MAX_ARCHIVE_SINGLE_ENTRY_BYTES) {
      throw new WikiRefusedError("WIKI_ARCHIVE_TOO_LARGE", 413);
    }
    try {
      const text = decoder.decode(rawBytes).replace(/^\uFEFF/, "");
      const base = (fileName.split("/").pop() || "export.json").trim() || "export.json";
      const safeKey = base.toLowerCase().endsWith(".json") ? base : `${base}.json`;
      documents[safeKey] = JSON.parse(text);
      return documents;
    } catch {
      throw new WikiRefusedError("WIKI_ARCHIVE_UNSAFE", 400);
    }
  }

  let entryCount = 0;
  let totalProjectedBytes = 0;
  let unpacked: Record<string, Uint8Array>;
  try {
    unpacked = unzipSync(rawBytes, {
      filter(file) {
        entryCount += 1;
        if (entryCount > MAX_ARCHIVE_ENTRIES) {
          throw new WikiRefusedError("WIKI_ARCHIVE_UNSAFE", 400);
        }
        if (file.name.endsWith("/")) {
          const trimmed = file.name.replace(/\/+$/, "");
          if (trimmed) validateArchiveEntryPath(trimmed);
          return false;
        }
        const clean = validateArchiveEntryPath(file.name);
        const origSize = Number(file.originalSize ?? 0);
        const compSize = Math.max(1, Number(file.size ?? 1));
        if (origSize > MAX_ARCHIVE_SINGLE_ENTRY_BYTES) {
          throw new WikiRefusedError("WIKI_ARCHIVE_TOO_LARGE", 413);
        }
        if (
          origSize > RATIO_CHECK_MIN_BYTES &&
          origSize > compSize * MAX_COMPRESSION_RATIO
        ) {
          throw new WikiRefusedError("WIKI_ARCHIVE_UNSAFE", 400);
        }
        totalProjectedBytes += origSize;
        if (totalProjectedBytes > MAX_ARCHIVE_UNCOMPRESSED_BYTES) {
          throw new WikiRefusedError("WIKI_ARCHIVE_TOO_LARGE", 413);
        }
        return clean.toLowerCase().endsWith(".json");
      },
    });
  } catch (err) {
    if (err instanceof WikiRefusedError) throw err;
    throw new WikiRefusedError("WIKI_ARCHIVE_UNSAFE", 400);
  }

  let actualUncompressed = 0;
  for (const [entryName, entryBytes] of Object.entries(unpacked)) {
    const cleanPath = validateArchiveEntryPath(entryName);
    actualUncompressed += entryBytes.byteLength;
    if (
      entryBytes.byteLength > MAX_ARCHIVE_SINGLE_ENTRY_BYTES ||
      actualUncompressed > MAX_ARCHIVE_UNCOMPRESSED_BYTES
    ) {
      throw new WikiRefusedError("WIKI_ARCHIVE_TOO_LARGE", 413);
    }
    if (!cleanPath.toLowerCase().endsWith(".json")) continue;
    try {
      const text = decoder.decode(entryBytes).replace(/^\uFEFF/, "");
      documents[cleanPath] = JSON.parse(text);
    } catch {
      throw new WikiRefusedError("WIKI_ARCHIVE_UNSAFE", 400);
    }
  }

  if (Object.keys(documents).length === 0) {
    throw new WikiRefusedError("WIKI_ARCHIVE_EMPTY", 400);
  }
  return documents;
}

function extractChatGptMessageText(message: Record<string, unknown>): string {
  const content = message.content;
  if (typeof content === "string") return cleanText(content);
  if (!content || typeof content !== "object") return "";
  const cObj = content as Record<string, unknown>;
  const contentType = String(cObj.content_type ?? "text");
  if (
    contentType !== "text" &&
    contentType !== "multimodal_text" &&
    contentType !== "user_editable_context"
  ) {
    return "";
  }
  const collected: string[] = [];
  if (Array.isArray(cObj.parts)) {
    for (const part of cObj.parts) {
      if (typeof part === "string") {
        const cleaned = cleanText(part);
        if (cleaned) collected.push(cleaned);
      } else if (part && typeof part === "object" && typeof (part as { text?: unknown }).text === "string") {
        const cleaned = cleanText((part as { text: string }).text);
        if (cleaned) collected.push(cleaned);
      }
    }
  } else if (
    typeof cObj.user_profile === "string" ||
    typeof cObj.user_instructions === "string"
  ) {
    for (const field of ["user_profile", "user_instructions"]) {
      const cleaned = cleanText(cObj[field]);
      if (cleaned) collected.push(cleaned);
    }
  } else if (typeof cObj.text === "string") {
    const cleaned = cleanText(cObj.text);
    if (cleaned) collected.push(cleaned);
  }
  return cleanText(collected.join(" "));
}

function extractClaudeMessageText(msg: Record<string, unknown>): string {
  const pieces: string[] = [];
  if (typeof msg.text === "string") {
    const cleaned = cleanText(msg.text);
    if (cleaned) pieces.push(cleaned);
  }
  if (pieces.length === 0 && Array.isArray(msg.content)) {
    for (const block of msg.content) {
      if (
        block &&
        typeof block === "object" &&
        String((block as { type?: unknown }).type ?? "text") === "text"
      ) {
        const cleaned = cleanText((block as { text?: unknown }).text);
        if (cleaned) pieces.push(cleaned);
      }
    }
  }
  return cleanText(pieces.join(" "));
}

function detectProvider(
  documents: Record<string, unknown>,
  requested: ArchiveSourceProvider,
): "chatgpt" | "claude" {
  if (requested === "chatgpt" || requested === "claude") return requested;
  for (const doc of Object.values(documents)) {
    const items = Array.isArray(doc) ? doc : [doc];
    for (const item of items) {
      if (!item || typeof item !== "object") continue;
      const obj = item as Record<string, unknown>;
      if ("mapping" in obj || "conversation_id" in obj) return "chatgpt";
      if ("chat_messages" in obj || "conversations_memory" in obj) return "claude";
    }
  }
  return "chatgpt";
}

export async function parseAiExportDocuments(
  documents: Record<string, unknown>,
  sourceProvider: ArchiveSourceProvider = "auto",
): Promise<{
  provider: "chatgpt" | "claude";
  records: NormalizedArchiveRecord[];
}> {
  if (!["auto", "chatgpt", "claude"].includes(sourceProvider)) {
    throw new WikiRefusedError("WIKI_SCHEMA_INVALID", 400);
  }
  const provider = detectProvider(documents, sourceProvider);
  const providerLabel = provider === "chatgpt" ? "ChatGPT" : "Claude";

  const records: NormalizedArchiveRecord[] = [];
  const savedMemoryStatements: string[] = [];
  let savedMemoryObserved = new Date().toISOString().slice(0, 10);

  for (const path of Object.keys(documents).sort()) {
    const basename = (path.split("/").pop() ?? "").toLowerCase();
    const doc = documents[path];

    if (
      basename === "memories.json" ||
      basename === "memory.json" ||
      (doc &&
        typeof doc === "object" &&
        !Array.isArray(doc) &&
        ("memories" in doc ||
          "conversations_memory" in doc ||
          "project_memories" in doc))
    ) {
      const rawItems: unknown[] = [];
      if (Array.isArray(doc)) {
        rawItems.push(...doc);
      } else if (doc && typeof doc === "object") {
        const dObj = doc as Record<string, unknown>;
        if (Array.isArray(dObj.memories)) rawItems.push(...dObj.memories);
        if (typeof dObj.conversations_memory === "string") {
          for (const line of dObj.conversations_memory.split(/\r?\n/)) {
            const trimmed = line.replace(/^[\s\-*]+/, "").trim();
            if (trimmed) rawItems.push(trimmed);
          }
        }
        if (dObj.project_memories && typeof dObj.project_memories === "object") {
          for (const val of Object.values(dObj.project_memories as Record<string, unknown>)) {
            if (typeof val === "string") {
              for (const line of val.split(/\r?\n/)) {
                const trimmed = line.replace(/^[\s\-*]+/, "").trim();
                if (trimmed) rawItems.push(trimmed);
              }
            }
          }
        }
      }
      for (const entry of rawItems) {
        let stmt = "";
        if (typeof entry === "string") {
          stmt = cleanText(entry);
        } else if (entry && typeof entry === "object") {
          const eObj = entry as Record<string, unknown>;
          stmt = cleanText(
            eObj.content ?? eObj.statement ?? eObj.memory ?? eObj.text,
          );
          if (eObj.updated_at || eObj.created_at) {
            savedMemoryObserved = isoDate(eObj.updated_at ?? eObj.created_at);
          }
        }
        if (stmt && !savedMemoryStatements.includes(stmt)) {
          savedMemoryStatements.push(stmt);
        }
      }
      continue;
    }

    if (basename === "projects.json" && Array.isArray(doc)) {
      for (const proj of doc.slice(0, MAX_CONVERSATIONS_PER_IMPORT)) {
        if (!proj || typeof proj !== "object") continue;
        const pObj = proj as Record<string, unknown>;
        const projUuid = String(pObj.uuid ?? pObj.id ?? "").trim();
        const projTitle = cleanText(pObj.name ?? "Imported Project", 120);
        const stmts: string[] = [];
        if (typeof pObj.prompt_template === "string") {
          const cleaned = cleanText(pObj.prompt_template);
          if (cleaned) stmts.push(cleaned);
        }
        if (Array.isArray(pObj.docs)) {
          for (const pdoc of pObj.docs) {
            if (pdoc && typeof pdoc === "object") {
              const cleaned = cleanText(
                (pdoc as Record<string, unknown>).content ??
                  (pdoc as Record<string, unknown>).text,
              );
              if (cleaned && !stmts.includes(cleaned)) stmts.push(cleaned);
            }
          }
        }
        if (stmts.length > 0) {
          const fallbackId = (await sha256Hex(projTitle)).slice(0, 16);
          records.push({
            provider,
            recordKind: "conversation",
            externalId: projUuid || fallbackId,
            title: `${providerLabel} Project: ${projTitle}`.slice(0, 120),
            observedAt: isoDate(pObj.updated_at ?? pObj.created_at),
            statements: stmts.slice(0, MAX_CLAIMS_PER_CONVERSATION),
            candidateProjections: [],
          });
        }
      }
      continue;
    }

    let convList: unknown[] = [];
    if (Array.isArray(doc)) {
      convList = doc;
    } else if (doc && typeof doc === "object") {
      const dObj = doc as Record<string, unknown>;
      if (Array.isArray(dObj.conversations)) {
        convList = dObj.conversations;
      } else if (
        "mapping" in dObj ||
        "chat_messages" in dObj ||
        "messages" in dObj
      ) {
        convList = [dObj];
      }
    }

    for (const conv of convList) {
      if (records.length >= MAX_CONVERSATIONS_PER_IMPORT) break;
      if (!conv || typeof conv !== "object") continue;
      const cObj = conv as Record<string, unknown>;

      if (cObj.mapping && typeof cObj.mapping === "object") {
        const convId = String(cObj.conversation_id ?? cObj.id ?? "").trim();
        const rawTitle = cleanText(cObj.title ?? "Imported Conversation", 120);
        const observedAt = isoDate(cObj.update_time ?? cObj.create_time);
        const orderedNodes: Array<{
          ts: number;
          id: string;
          msg: Record<string, unknown>;
        }> = [];
        let idx = 0;
        for (const [nodeId, node] of Object.entries(
          cObj.mapping as Record<string, unknown>,
        )) {
          idx += 1;
          if (!node || typeof node !== "object") continue;
          const msg = (node as Record<string, unknown>).message;
          if (!msg || typeof msg !== "object") continue;
          const mObj = msg as Record<string, unknown>;
          const author = mObj.author;
          const role =
            author && typeof author === "object"
              ? String((author as Record<string, unknown>).role ?? "").toLowerCase()
              : "";
          if (role !== "user") continue;
          const createTime = mObj.create_time;
          const sortTs =
            typeof createTime === "number" && Number.isFinite(createTime)
              ? createTime
              : idx;
          orderedNodes.push({ ts: sortTs, id: nodeId, msg: mObj });
        }
        orderedNodes.sort(
          (a, b) => a.ts - b.ts || a.id.localeCompare(b.id),
        );
        const userStmts: string[] = [];
        for (const item of orderedNodes) {
          const cleaned = extractChatGptMessageText(item.msg);
          if (cleaned && !userStmts.includes(cleaned)) {
            userStmts.push(cleaned);
            if (userStmts.length >= MAX_CLAIMS_PER_CONVERSATION) break;
          }
        }
        if (userStmts.length > 0) {
          const fallbackId = (await sha256Hex(rawTitle)).slice(0, 16);
          records.push({
            provider: "chatgpt",
            recordKind: "conversation",
            externalId: convId || fallbackId,
            title: `ChatGPT: ${rawTitle || "Conversation"}`.slice(0, 120),
            observedAt,
            statements: userStmts,
            candidateProjections: [],
          });
        }
        continue;
      }

      if (Array.isArray(cObj.chat_messages)) {
        const convId = String(cObj.uuid ?? cObj.id ?? "").trim();
        const rawTitle = cleanText(
          cObj.name ?? cObj.title ?? "Imported Conversation",
          120,
        );
        const observedAt = isoDate(cObj.updated_at ?? cObj.created_at);
        const humanStmts: string[] = [];
        for (const msg of cObj.chat_messages) {
          if (!msg || typeof msg !== "object") continue;
          const mObj = msg as Record<string, unknown>;
          const sender = String(mObj.sender ?? mObj.role ?? "").toLowerCase();
          if (sender !== "human" && sender !== "user") continue;
          const cleaned = extractClaudeMessageText(mObj);
          if (cleaned && !humanStmts.includes(cleaned)) {
            humanStmts.push(cleaned);
            if (humanStmts.length >= MAX_CLAIMS_PER_CONVERSATION) break;
          }
        }
        if (humanStmts.length > 0) {
          const fallbackId = (await sha256Hex(rawTitle)).slice(0, 16);
          records.push({
            provider: "claude",
            recordKind: "conversation",
            externalId: convId || fallbackId,
            title: `Claude: ${rawTitle || "Conversation"}`.slice(0, 120),
            observedAt,
            statements: humanStmts,
            candidateProjections: [],
          });
        }
        continue;
      }

      if (Array.isArray(cObj.messages)) {
        const convId = String(cObj.id ?? cObj.uuid ?? "").trim();
        const rawTitle = cleanText(cObj.title ?? cObj.name ?? "Conversation", 120);
        const observedAt = isoDate(cObj.updated_at ?? cObj.created_at);
        const stmts: string[] = [];
        for (const msg of cObj.messages) {
          if (!msg || typeof msg !== "object") continue;
          const mObj = msg as Record<string, unknown>;
          const role = String(mObj.role ?? mObj.sender ?? "").toLowerCase();
          if (role !== "user" && role !== "human") continue;
          const cleaned = cleanText(mObj.content ?? mObj.text);
          if (cleaned && !stmts.includes(cleaned)) {
            stmts.push(cleaned);
            if (stmts.length >= MAX_CLAIMS_PER_CONVERSATION) break;
          }
        }
        if (stmts.length > 0) {
          const fallbackId = (await sha256Hex(rawTitle)).slice(0, 16);
          records.push({
            provider,
            recordKind: "conversation",
            externalId: convId || fallbackId,
            title: `${providerLabel}: ${rawTitle}`.slice(0, 120),
            observedAt,
            statements: stmts,
            candidateProjections: [],
          });
        }
      }
    }
  }

  if (savedMemoryStatements.length > 0) {
    const capped = savedMemoryStatements.slice(0, MAX_CLAIMS_PER_CONVERSATION);
    const candidates: Array<[string, string]> = [];
    for (const stmt of capped) {
      const hex12 = (await sha256Hex(stmt)).slice(0, 12);
      candidates.push(["preferences", `imported_notes.item_${hex12}`]);
    }
    records.unshift({
      provider,
      recordKind: "saved_memory",
      externalId: `${provider}_saved_memories`,
      title: `${providerLabel} Saved Memories`,
      observedAt: savedMemoryObserved,
      statements: capped,
      candidateProjections: candidates,
    });
  }

  return { provider, records };
}

export class SharedWikiArchiveImporter {
  private readonly writer: SharedWikiKnowledgeWriter;
  private readonly projections: SharedWikiProjectionEngine;

  constructor(private readonly library: SharedWikiLibrary) {
    this.writer = new SharedWikiKnowledgeWriter(library);
    this.projections = new SharedWikiProjectionEngine(library);
  }

  private async opaque16(label: string): Promise<string> {
    const hex = await sha256Hex(`${this.library.owner}|${label}`);
    return hex.slice(0, 16);
  }

  async sourceIdForArchive(
    archiveSha256: string,
    externalId: string,
  ): Promise<string> {
    return `wsr_${await this.opaque16(`archive:${archiveSha256}:${externalId}`)}`;
  }

  async pageIdForArchiveRecord(
    provider: string,
    recordKind: string,
    externalId: string,
  ): Promise<string> {
    return `wpg_${await this.opaque16(`import:${provider}:${recordKind}:${externalId}`)}`;
  }

  async importArchiveBytes(
    input: {
      fileId: string;
      fileName: string;
      rawBytes: Uint8Array;
      idempotencyKey: string;
      sourceProvider?: ArchiveSourceProvider;
      explicitCandidateMappings?: Array<{
        statement: string;
        domain: string;
        jsonPath: string;
      }>;
    },
    signal?: AbortSignal,
  ) {
    validateIdempotencyKey(input.idempotencyKey);
    const cleanFileId = String(input.fileId ?? "").trim();
    if (!cleanFileId || cleanFileId.length > 128 || cleanFileId.includes("/")) {
      throw new WikiRefusedError("WIKI_SCHEMA_INVALID", 400);
    }

    const archiveSha256 = await sha256BytesHex(input.rawBytes);
    const documents = extractArchiveJsonDocuments(
      input.rawBytes,
      input.fileName,
    );
    const { provider, records } = await parseAiExportDocuments(
      documents,
      input.sourceProvider ?? "auto",
    );

    const explicitByStatement = new Map<string, [string, string]>();
    for (const mapping of input.explicitCandidateMappings ?? []) {
      const fp = await normalizeStatementFingerprint(mapping.statement ?? "");
      const dom = validateProjectionDomain(mapping.domain);
      const jpath = validateProjectionJsonPath(mapping.jsonPath);
      if (fp) explicitByStatement.set(fp, [dom, jpath]);
    }

    const tombstones = await this.library.listTombstones(signal);
    const deadClaims = new Set(
      tombstones
        .filter((t) => t.target_kind === "claim")
        .map((t) => t.target_id),
    );
    const deadPages = new Set(
      tombstones
        .filter((t) => t.target_kind === "page")
        .map((t) => t.target_id),
    );
    const { payload: fpDoc } = await this.library.readNamedCheckpoint(
      TOMBSTONE_FINGERPRINTS_CHECKPOINT,
      signal,
    );
    const deadFps = new Set(
      Array.isArray((fpDoc as { fingerprints?: unknown })?.fingerprints)
        ? ((fpDoc as { fingerprints: string[] }).fingerprints ?? [])
        : [],
    );

    const batchItems: SynthesisBatchItemInput[] = [];
    const pendingCandidates: Array<[string, string, string, string]> = [];
    const registeredSources: string[] = [];
    let importedClaimCount = 0;
    let deduplicatedClaimCount = 0;
    let skippedTombstonedCount = 0;

    for (const record of records.slice(0, MAX_BATCH_PAGES)) {
      signal?.throwIfAborted();
      const pageId = await this.pageIdForArchiveRecord(
        record.provider,
        record.recordKind,
        record.externalId,
      );
      if (deadPages.has(pageId)) {
        skippedTombstonedCount += record.statements.length;
        continue;
      }

      const sourceId = await this.sourceIdForArchive(
        archiveSha256,
        record.externalId,
      );
      const locator = `files:${cleanFileId}#${record.provider}:${record.externalId}`.slice(
        0,
        256,
      );
      const recordDigest = await sha256Hex(record.statements.join("\n"));

      await this.library.registerSource(
        {
          source_id: sourceId,
          kind: "file_object",
          locator,
          content_sha256: recordDigest,
          observed_at: record.observedAt,
          consent_derived: false,
        },
        `src:${input.idempotencyKey}:${sourceId}`,
        signal,
      );
      registeredSources.push(sourceId);

      let existingPage = null;
      try {
        existingPage = await this.library.readPage(
          pageId,
          { requireSettled: true },
          signal,
        );
      } catch (err) {
        if (!(err instanceof WikiRefusedError && err.code === "WIKI_NOT_FOUND")) {
          throw err;
        }
      }

      const existingClaimsById = new Map<string, WikiClaim>();
      for (const claim of existingPage?.claims ?? []) {
        existingClaimsById.set(claim.claim_id, {
          ...claim,
          source_ids: [...(claim.source_ids ?? [])],
        });
      }
      const existingSourceIds = [...(existingPage?.source_ids ?? [])];
      if (
        !existingSourceIds.includes(sourceId) &&
        existingSourceIds.length < MAX_SOURCES_PER_PAGE
      ) {
        existingSourceIds.push(sourceId);
      }

      let pageChanged = false;
      for (let idx = 0; idx < record.statements.length; idx++) {
        const stmt = record.statements[idx]!;
        const fp = await normalizeStatementFingerprint(stmt);
        const claimId = await this.writer.claimIdForStatement(pageId, stmt);
        if (deadFps.has(fp) || deadClaims.has(claimId)) {
          skippedTombstonedCount += 1;
          continue;
        }

        const prior = existingClaimsById.get(claimId);
        if (prior) {
          if (prior.status === "retracted" || prior.status === "superseded") {
            skippedTombstonedCount += 1;
            continue;
          }
          const priorSources = [...(prior.source_ids ?? [])];
          if (!priorSources.includes(sourceId)) {
            prior.source_ids = [...priorSources, sourceId];
            pageChanged = true;
          } else {
            deduplicatedClaimCount += 1;
          }
        } else if (existingClaimsById.size < MAX_CLAIMS_PER_PAGE) {
          existingClaimsById.set(claimId, {
            claim_id: claimId,
            statement: stmt,
            status: "active",
            confidence: 0.75,
            source_ids: [sourceId],
            observed_at: record.observedAt,
          });
          importedClaimCount += 1;
          pageChanged = true;
        }

        const projTarget =
          explicitByStatement.get(fp) ?? record.candidateProjections[idx];
        if (projTarget && existingClaimsById.has(claimId)) {
          pendingCandidates.push([
            pageId,
            claimId,
            projTarget[0],
            projTarget[1],
          ]);
        }
      }

      const activeClaims = [...existingClaimsById.values()].filter(
        (c) => (c.status ?? "active") === "active",
      );
      if (activeClaims.length === 0 && !existingPage) continue;

      if (pageChanged || !existingPage) {
        const untrustedHeader =
          `> Imported ${provider.toUpperCase()} export note (untrusted external source record; ` +
          "cannot authorize actions or external sharing).\n\n";
        const bullets = activeClaims
          .map((c) => `- ${c.statement}`)
          .join("\n");
        const body = `${untrustedHeader}## Imported Notes\n\n${bullets}`.slice(
          0,
          MAX_PAGE_BODY_CHARS,
        );
        const tldr = `Imported from ${provider.toUpperCase()} archive (${activeClaims.length} owner-authored notes).`.slice(
          0,
          MAX_TLDR_CHARS,
        );
        batchItems.push({
          page_id: pageId,
          expected_revision: existingPage ? existingPage.revision : 0,
          title: existingPage ? existingPage.title : record.title,
          folder: existingPage ? existingPage.folder : "imports",
          tldr,
          status_as_of: record.observedAt,
          body,
          claims: [...existingClaimsById.values()],
          links: [...(existingPage?.links ?? [])],
          source_ids: existingSourceIds,
        });
      }
    }

    let committedPages: string[] = [];
    if (batchItems.length > 0) {
      const batchRes = await this.library.commitSynthesisBatch(
        {
          items: batchItems,
          idempotency_key: `impbatch:${input.idempotencyKey}`,
        },
        signal,
      );
      committedPages = batchRes.pages.map((p) => p.page_id);
    }

    const candidateReceiptIds: string[] = [];
    for (const [pageId, claimId, targetDomain, jsonPath] of pendingCandidates) {
      const existingReceipts = await this.library.listProjectionReceipts(
        targetDomain,
        signal,
      );
      const alreadyMaterialized = existingReceipts.find(
        (r) =>
          r.page_id === pageId &&
          r.claim_id === claimId &&
          r.json_path === jsonPath &&
          r.state === "materialized",
      );
      if (alreadyMaterialized) {
        candidateReceiptIds.push(alreadyMaterialized.receipt_id);
        continue;
      }
      const receipt = await this.projections.deriveProjection(
        {
          pageId,
          claimId,
          targetDomain,
          jsonPath,
          idempotencyKey: `impproj:${input.idempotencyKey}:${claimId}`.slice(
            0,
            128,
          ),
          activeRecipientCount: 0,
          ownerConfirmed: false,
          requireOwnerConfirmation: true,
        },
        signal,
      );
      candidateReceiptIds.push(receipt.receipt_id);
    }

    await this.writer.refreshHotDigest(signal);

    const { payload: ledger, revision: ledgerRev } =
      await this.library.readNamedCheckpoint(ARCHIVE_IMPORTS_CHECKPOINT, signal);
    const priorImports = {
      ...((ledger as { imports?: Record<string, unknown> } | null)?.imports ??
        {}),
    };
    priorImports[archiveSha256] = {
      file_id: cleanFileId,
      provider,
      archive_sha256: archiveSha256,
      pages: committedPages,
      source_ids: registeredSources,
    };
    await this.library.writeNamedCheckpoint(
      ARCHIVE_IMPORTS_CHECKPOINT,
      { imports: priorImports },
      ledgerRev,
      signal,
    );

    return {
      schema: ARCHIVE_IMPORT_SCHEMA,
      status: "imported" as const,
      provider,
      file_id: cleanFileId,
      archive_sha256: archiveSha256,
      pages_updated: committedPages.length,
      page_ids: committedPages,
      claims_imported: importedClaimCount,
      claims_deduplicated: deduplicatedClaimCount,
      claims_skipped_tombstoned: skippedTombstonedCount,
      source_ids: registeredSources,
      candidate_receipt_ids: candidateReceiptIds,
      untrusted_data: true as const,
      instruction_authority: "none" as const,
      shareable: "never" as const,
    };
  }
}

