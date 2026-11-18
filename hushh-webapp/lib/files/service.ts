"use client";
import { activeFilesAccess, filesRequest, sharedWikiLibrary } from "./connection";
import {
  invalidateFilesMutationCache,
  peekFilesTextCache,
  setFilesListCache,
  setFilesSettingsCache,
  setFilesTextCache,
  setFilesWikiOverviewCache,
  setFilesWikiPageCache,
} from "./files-cache";
import {
  classifyWikiClaimsForPkm,
  fetchProjectionSharingImpact,
  inspectPkmConflictsForProjection,
  materializeWikiReceiptToPkm,
  retractStaleWikiProjectionsFromPkm,
  syncWikiPagesToPkmProjections,
  type StaledWikiProjectionDescriptor,
  type WikiProjectionSyncTransport,
} from "./wiki/pkm-projection-sync";
import { FilesLocalError } from "./local-error";

export type FileEntry = {
  id: string;
  name: string;
  originalName: string;
  parent: string;
  kind: "file" | "folder";
  size: number;
  received: number;
  receivedHash: string;
  state: "uploading" | "ready" | "trashed";
  revision: number;
  organization?: { state: string; code?: string };
};
export type FilesPage = {
  entries: FileEntry[];
  cursor: string;
  chunkBytes: number;
};
export type FilesSettings = {
  retention?: {
    retentionSeconds?: number | null;
    retentionLocked: boolean;
    softDeleteSeconds: number;
    versioning: boolean;
    physicalDeletion: string;
  };
  revision: number;
  analysis: boolean;
  automatic: boolean;
  excluded: string[];
  backgroundAvailable?: boolean;
  backgroundProvider?: string | null;
  foregroundOnly?: boolean;
};
export type OrganizationJob = {
  id: string;
  state: string;
  file?: string;
  result?: { state: string; explanation: string };
  history?: Array<{ state: string; result?: { explanation: string } }>;
};
export type WikiSummaryPage = {
  pageId: string;
  title: string;
  folder: string;
  tldr: string;
  revision: number;
  updatedAt: number;
};
export type WikiCandidateItem = {
  receiptId: string;
  pageId: string;
  pageRevision?: number;
  claimId: string;
  sourceRevision?: number;
  domain: string;
  jsonPath?: string;
  statement: string;
  state: string;
  activeRecipientCount?: number;
  recipientLabels?: string[];
};
export type WikiOverview = {
  captureOptIn: boolean;
  migrationState: string;
  migrationRevision: number;
  dualReadQualified?: boolean;
  coldRecoveryQualified?: boolean;
  compiledClaimCount?: number;
  classicWriterRetired?: boolean;
  pages: WikiSummaryPage[];
  candidateReceipts: WikiCandidateItem[];
  staleReceipts?: StaledWikiProjectionDescriptor[];
  projectedClaimKeys?: string[];
};
export type WikiMigrationAction =
  | "compile_and_verify"
  | "cutover_rollback_safe"
  | "graduate_wiki_primary"
  | "maintenance_tick";
export type WikiMigrationResult = {
  action: WikiMigrationAction;
  migrationState: string;
  migrationRevision: number;
  dualReadQualified: boolean;
  coldRecoveryQualified: boolean;
  compiledClaimCount?: number;
  skippedTombstoned?: number;
  classicWriterRetired: boolean;
};
export type WikiPageDetail = {
  pageId: string;
  title: string;
  folder: string;
  tldr: string;
  body: string;
  revision: number;
  statusAsOf: string;
  claims: Array<{
    claimId: string;
    statement: string;
    status: string;
    observedAt: string;
    origins: string[];
  }>;
};
export type WikiArchiveImportResult = {
  provider: "chatgpt" | "claude";
  fileId: string;
  pagesUpdated: number;
  claimsImported: number;
  claimsDeduplicated: number;
  claimsSkippedTombstoned: number;
  candidateCount: number;
};

const latestCandidateHints = new Map<string, WikiCandidateItem>();

function filesCacheOwner(): string {
  return activeFilesAccess()?.owner ?? "pod";
}

export function isPreviewableTextFilename(name: string): boolean {
  return /\.(md|markdown|mdx|txt|json|ya?ml|csv|log|ts|tsx|js|jsx|py|sh|toml|ini|conf)$/i.test(
    name.trim(),
  );
}

async function json<T>(
  path: string,
  body?: unknown,
  method = body === undefined ? "GET" : "POST",
  signal?: AbortSignal,
): Promise<T> {
  const response = await filesRequest(path, {
    method,
    signal,
    headers: { "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (!response.ok) {
    const result = await response.json().catch(() => ({}));
    throw new Error(
      result?.detail?.code ?? `FILES_UNAVAILABLE:${response.status}`,
    );
  }
  return response.json() as Promise<T>;
}

function filesWikiSyncTransport(): WikiProjectionSyncTransport {
  return {
    overview: (signal) =>
      json<WikiOverview>("wiki/overview", undefined, "GET", signal),
    readPage: (pageId, signal) =>
      json<WikiPageDetail>(
        `wiki/page?${new URLSearchParams({ page_id: pageId })}`,
        undefined,
        "GET",
        signal,
      ),
    deriveProjection: (input, signal) =>
      json<{
        receiptId: string;
        state: string;
        domain: string;
        jsonPath: string;
        pageId: string;
        pageRevision: number;
        claimId: string;
        sourceRevision: number;
      }>(
        "wiki/projection/derive",
        {
          page_id: input.pageId,
          claim_id: input.claimId,
          target_domain: input.targetDomain,
          json_path: input.jsonPath,
          active_recipient_count: input.activeRecipientCount,
          owner_confirmed: input.ownerConfirmed,
          require_owner_confirmation: input.requireOwnerConfirmation,
          ...(input.conflictAuthority
            ? { conflict_authority: input.conflictAuthority }
            : {}),
          ...(input.conflictReason
            ? { conflict_reason: input.conflictReason }
            : {}),
          ...(input.conflictPath ? { conflict_path: input.conflictPath } : {}),
          request_id: input.requestId,
        },
        "POST",
        signal,
      ),
  };
}

export const FilesService = {
  entry: (fileId: string, signal?: AbortSignal) =>
    json<FileEntry>(
      `entry?${new URLSearchParams({ file_id: fileId })}`,
      undefined,
      "GET",
      signal,
    ),
  history: (cursor = "", signal?: AbortSignal) =>
    json<{ entries: OrganizationJob[]; cursor: string }>(
      `jobs?${new URLSearchParams({ cursor })}`,
      undefined,
      "GET",
      signal,
    ),
  job: (fileId: string, signal?: AbortSignal) =>
    json<OrganizationJob>(
      `jobs?${new URLSearchParams({ file_id: fileId })}`,
      undefined,
      "GET",
      signal,
    ),
  organize: (fileId: string, cancel = false, signal?: AbortSignal) =>
    json<OrganizationJob>(
      "jobs",
      { file_id: fileId, cancel, request_id: crypto.randomUUID() },
      "POST",
      signal,
    ),
  usagePage: (cursor = "", signal?: AbortSignal) =>
    json<{ bytes: number; files: number; cursor: string }>(
      `usage?${new URLSearchParams({ cursor })}`,
      undefined,
      "GET",
      signal,
    ),
  list: async (parent: string, cursor = "", trash = false, signal?: AbortSignal) => {
    const page = await json<FilesPage>(
      `list?${new URLSearchParams({ parent, cursor, trash: String(trash) })}`,
      undefined,
      "GET",
      signal,
    );
    setFilesListCache(filesCacheOwner(), parent, cursor, trash, page);
    return page;
  },
  settings: async (signal?: AbortSignal) => {
    const config = await json<FilesSettings>("settings", undefined, "GET", signal);
    setFilesSettingsCache(filesCacheOwner(), config);
    return config;
  },
  configure: async (settings: FilesSettings, signal?: AbortSignal) => {
    const res = await json<FilesSettings>("settings", settings, "PUT", signal);
    invalidateFilesMutationCache(filesCacheOwner());
    return res;
  },
  createFolder: async (name: string, parent: string, signal?: AbortSignal) => {
    const res = await json<FileEntry>(
      "create",
      { name, parent, size: 0, folder: true, request_id: crypto.randomUUID() },
      "POST",
      signal,
    );
    invalidateFilesMutationCache(filesCacheOwner());
    return res;
  },
  mutate: async (
    entry: FileEntry,
    operation: string,
    fields: Record<string, unknown> = {},
    signal?: AbortSignal,
  ) => {
    const res = await json<FileEntry>(
      "mutate",
      { file_id: entry.id, revision: entry.revision, operation, ...fields },
      "POST",
      signal,
    );
    invalidateFilesMutationCache(filesCacheOwner());
    return res;
  },
  async upload(
    file: File,
    parent: string,
    onProgress: (received: number) => void,
    signal: AbortSignal,
    resume?: FileEntry,
  ): Promise<FileEntry> {
    const entry =
      resume ??
      (await json<FileEntry>(
        "create",
        {
          name: file.name,
          parent,
          size: file.size,
          request_id: crypto.randomUUID(),
        },
        "POST",
        signal,
      ));
    if (entry.size !== file.size || entry.originalName !== file.name)
      throw new FilesLocalError(
        "Choose the original file to resume this upload.",
      );
    const chunkBytes = 4 * 1024 * 1024;
    // Verify the accepted prefix locally without retransmitting stored bytes.
    let chain = new Uint8Array(32);
    for (let offset = 0; offset < entry.received; offset += chunkBytes) {
      signal.throwIfAborted();
      const digest = new Uint8Array(
        await crypto.subtle.digest(
          "SHA-256",
          await file
            .slice(offset, Math.min(entry.received, offset + chunkBytes))
            .arrayBuffer(),
        ),
      );
      const input = new Uint8Array(64);
      input.set(chain);
      input.set(digest, 32);
      chain = new Uint8Array(await crypto.subtle.digest("SHA-256", input));
    }
    if (
      Array.from(chain, (byte) => byte.toString(16).padStart(2, "0")).join(
        "",
      ) !== entry.receivedHash
    )
      throw new FilesLocalError(
        "This file does not match the uploaded portion. Choose the original file.",
      );
    onProgress(entry.received);
    for (
      let offset = entry.received;
      offset < file.size;
      offset += chunkBytes
    ) {
      signal.throwIfAborted();
      const response = await filesRequest(
        `chunk?${new URLSearchParams({ file_id: entry.id, index: String(offset / chunkBytes) })}`,
        {
          method: "PUT",
          body: file.slice(offset, offset + chunkBytes),
          signal,
          headers: { "Content-Type": "application/octet-stream" },
        },
      );
      if (!response.ok) {
        const result = await response.json().catch(() => ({}));
        if (result?.detail?.code) throw new Error(result.detail.code);
        throw new FilesLocalError(
          "Upload paused. Select the same file to resume.",
        );
      }
      onProgress(Math.min(file.size, offset + chunkBytes));
    }
    const completed = await json<FileEntry>("complete", { file_id: entry.id }, "POST", signal);
    invalidateFilesMutationCache(filesCacheOwner());
    return completed;
  },
  async readText(
    entry: FileEntry,
    signal?: AbortSignal,
    maxBytes = 512 * 1024,
  ): Promise<string> {
    const cached = peekFilesTextCache(filesCacheOwner(), entry.id, entry.revision);
    if (cached !== null) return cached;
    if (entry.size > maxBytes) {
      throw new FilesLocalError(
        "This file is too large to preview inline. Download it to inspect.",
      );
    }
    if (entry.size === 0) {
      setFilesTextCache(filesCacheOwner(), entry, "");
      return "";
    }
    let chain = new Uint8Array(32);
    const parts: Uint8Array[] = [];
    for (let offset = 0; offset < entry.size; ) {
      signal?.throwIfAborted();
      const response = await filesRequest(
        `chunk?${new URLSearchParams({ file_id: entry.id, index: String(offset / CHUNK_BYTES) })}`,
        { signal },
      );
      if (!response.ok) {
        throw new FilesLocalError("Could not read file contents.");
      }
      const bytes = await response.arrayBuffer();
      if (bytes.byteLength !== Math.min(CHUNK_BYTES, entry.size - offset)) {
        throw new FilesLocalError("The file chunk was incomplete.");
      }
      chain = await hashChunk(chain, bytes);
      parts.push(new Uint8Array(bytes));
      offset += bytes.byteLength;
    }
    if (hex(chain) !== entry.receivedHash) {
      throw new FilesLocalError("The file failed its integrity check.");
    }
    const merged = new Uint8Array(entry.size);
    let cursor = 0;
    for (const part of parts) {
      merged.set(part, cursor);
      cursor += part.byteLength;
    }
    const decoded = new TextDecoder("utf-8", { fatal: false }).decode(merged);
    setFilesTextCache(filesCacheOwner(), entry, decoded);
    return decoded;
  },
  async download(
    entry: FileEntry,
    signal: AbortSignal,
    resume?: DownloadCheckpoint,
  ): Promise<void> {
    const picker = (
      window as unknown as {
        showSaveFilePicker?: (options: {
          suggestedName: string;
        }) => Promise<DownloadHandle>;
      }
    ).showSaveFilePicker;
    if (!picker && entry.size > 32 * 1024 * 1024)
      throw new FilesLocalError(
        "Use a browser with direct file saving for this large download.",
      );
    if (
      resume &&
      (resume.fileId !== entry.id ||
        resume.size !== entry.size ||
        resume.contentHash !== entry.receivedHash)
    )
      throw new FilesLocalError("The download no longer matches this file.");
    const handle =
      resume?.handle ??
      (picker ? await picker({ suggestedName: entry.name }) : null);
    let chain = new Uint8Array(32);
    let offset = resume?.offset ?? 0;
    if (resume) {
      const saved = await resume.handle.getFile();
      if (saved.size !== offset)
        throw new FilesLocalError(
          "The partial download changed. Start a new download.",
        );
      for (let position = 0; position < offset; position += CHUNK_BYTES) {
        signal.throwIfAborted();
        chain = await hashChunk(
          chain,
          await saved
            .slice(position, Math.min(offset, position + CHUNK_BYTES))
            .arrayBuffer(),
        );
      }
      if (hex(chain) !== resume.prefixHash)
        throw new FilesLocalError(
          "The partial download changed. Start a new download.",
        );
    }
    const writer = handle
      ? await handle.createWritable({ keepExistingData: Boolean(resume) })
      : null;
    const chunks: BlobPart[] = [];
    try {
      if (writer && offset) await writer.seek(offset);
      for (; offset < entry.size;) {
        signal.throwIfAborted();
        const response = await filesRequest(
          `chunk?${new URLSearchParams({ file_id: entry.id, index: String(offset / CHUNK_BYTES) })}`,
          { signal },
        );
        if (!response.ok)
          throw new FilesLocalError(
            "Download interrupted. Resume to continue.",
          );
        const bytes = await response.arrayBuffer();
        if (bytes.byteLength !== Math.min(CHUNK_BYTES, entry.size - offset))
          throw new FilesLocalError("The download chunk was incomplete.");
        const nextHash = await hashChunk(chain, bytes);
        if (writer) await writer.write(new Uint8Array(bytes));
        else chunks.push(bytes);
        chain = nextHash;
        offset += bytes.byteLength;
      }
      if (hex(chain) !== entry.receivedHash)
        throw new FilesLocalError(
          "The downloaded file failed its integrity check.",
        );
      if (writer) await writer.close();
      else {
        const url = URL.createObjectURL(
          new Blob(chunks, { type: "application/octet-stream" }),
        );
        const anchor = document.createElement("a");
        anchor.href = url;
        anchor.download = entry.name;
        anchor.click();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
      }
    } catch (error) {
      if (writer && handle && offset < entry.size && !signal.aborted) {
        try {
          await writer.close();
        } catch {
          await writer.abort().catch(() => undefined);
          throw error;
        }
        throw new DownloadPaused({
          handle,
          fileId: entry.id,
          size: entry.size,
          contentHash: entry.receivedHash,
          offset,
          prefixHash: hex(chain),
        });
      }
      await writer?.abort().catch(() => undefined);
      throw error;
    }
  },
  sharedWiki: () => sharedWikiLibrary(),
  wikiOverview: async (signal?: AbortSignal): Promise<WikiOverview> => {
    const raw = await json<WikiOverview>(
      "wiki/overview",
      undefined,
      "GET",
      signal,
    );
    const access = activeFilesAccess();
    for (const c of raw.candidateReceipts) {
      latestCandidateHints.set(c.receiptId, c);
    }
    if (!access) return raw;

    // Reconcile any un-retracted stale projections from Pod background reviews
    if (Array.isArray(raw.staleReceipts) && raw.staleReceipts.length > 0) {
      await retractStaleWikiProjectionsFromPkm(access, raw.staleReceipts).catch(
        () => undefined,
      );
    }

    if (raw.candidateReceipts.length === 0) return raw;
    const enrichedCandidates = await Promise.all(
      raw.candidateReceipts.map(async (cand) => {
        if (cand.state !== "private_candidate" || !cand.jsonPath) return cand;
        try {
          const impact = await fetchProjectionSharingImpact(
            access,
            cand.domain,
            cand.jsonPath,
          );
          return {
            ...cand,
            activeRecipientCount: impact.activeRecipientCount,
            recipientLabels: impact.recipientLabels,
          };
        } catch {
          return cand;
        }
      }),
    );
    for (const c of enrichedCandidates) {
      latestCandidateHints.set(c.receiptId, c);
    }
    const nextOverview = { ...raw, candidateReceipts: enrichedCandidates };
    setFilesWikiOverviewCache(filesCacheOwner(), nextOverview);
    return nextOverview;
  },
  wikiPage: async (pageId: string, signal?: AbortSignal) => {
    const detail = await json<WikiPageDetail>(
      `wiki/page?${new URLSearchParams({ page_id: pageId })}`,
      undefined,
      "GET",
      signal,
    );
    setFilesWikiPageCache(filesCacheOwner(), pageId, detail);
    return detail;
  },
  wikiSetOptIn: async (enabled: boolean, signal?: AbortSignal) => {
    const res = await json<{ captureOptIn: boolean }>(
      "wiki/opt-in",
      { enabled },
      "POST",
      signal,
    );
    invalidateFilesMutationCache(filesCacheOwner());
    return res;
  },
  wikiSavePage: async (
    input: {
      pageId: string;
      expectedRevision: number;
      title: string;
      tldr: string;
      body: string;
    },
    signal?: AbortSignal,
  ) => {
    const res = await json<{
      pageId: string;
      revision: number;
      staledReceipts?: StaledWikiProjectionDescriptor[];
    }>(
      "wiki/page",
      {
        page_id: input.pageId,
        expected_revision: input.expectedRevision,
        title: input.title,
        tldr: input.tldr,
        body: input.body,
        request_id: crypto.randomUUID(),
      },
      "POST",
      signal,
    );
    const access = activeFilesAccess();
    if (access && Array.isArray(res.staledReceipts) && res.staledReceipts.length > 0) {
      await retractStaleWikiProjectionsFromPkm(access, res.staledReceipts).catch(
        () => undefined,
      );
    }
    if (access) {
      await syncWikiPagesToPkmProjections(access, filesWikiSyncTransport(), {
        explicitChatSave: true,
        surface: "web",
        signal,
      }).catch(() => undefined);
    }
    invalidateFilesMutationCache(filesCacheOwner());
    return res;
  },
  wikiConfirmCandidate: async (
    receiptId: string,
    signal?: AbortSignal,
    candidateHint?: WikiCandidateItem,
  ) => {
    const access = activeFilesAccess();
    let hint = candidateHint ?? latestCandidateHints.get(receiptId);
    let proposedValue: unknown;
    if (
      access &&
      hint?.statement &&
      (!hint.jsonPath ||
        hint.domain === "agent_memory" ||
        hint.jsonPath.startsWith("agent_memory.item_"))
    ) {
      const classified = await classifyWikiClaimsForPkm(
        access,
        [hint.statement],
        signal,
      ).catch(() => []);
      const semantic = classified[0];
      if (semantic) {
        hint = {
          ...hint,
          domain: semantic.targetDomain,
          jsonPath: semantic.jsonPath,
        };
        proposedValue = semantic.proposedValue;
      }
    }
    if (access && hint?.jsonPath && hint.pageId && hint.claimId) {
      const { conflict } = await inspectPkmConflictsForProjection(access, {
        domain: hint.domain,
        jsonPath: hint.jsonPath,
        statement: hint.statement,
        ...(proposedValue !== undefined ? { proposedValue } : {}),
      });
      if (conflict) {
        await json<{ receiptId: string; state: string }>(
          "wiki/projection/derive",
          {
            page_id: hint.pageId,
            claim_id: hint.claimId,
            target_domain: hint.domain,
            json_path: hint.jsonPath,
            conflict_authority: conflict.authority,
            conflict_reason: conflict.reason,
            conflict_path: conflict.path,
            request_id: crypto.randomUUID(),
          },
          "POST",
          signal,
        );
        return { receiptId, state: "conflicted" };
      }

      const pkmOutcome = await materializeWikiReceiptToPkm(
        access,
        {
          receiptId,
          domain: hint.domain,
          jsonPath: hint.jsonPath,
          pageId: hint.pageId,
          pageRevision: hint.pageRevision ?? 1,
          claimId: hint.claimId,
          sourceRevision: (hint.sourceRevision ?? 1) + 1,
          statement: hint.statement,
          ...(proposedValue !== undefined ? { proposedValue } : {}),
        },
        { ownerConfirmed: true },
      );
      if (pkmOutcome.outcome === "conflicted") {
        await json<{ receiptId: string; state: string }>(
          "wiki/projection/derive",
          {
            page_id: hint.pageId,
            claim_id: hint.claimId,
            target_domain: hint.domain,
            json_path: hint.jsonPath,
            conflict_authority: pkmOutcome.conflict.authority,
            conflict_reason: pkmOutcome.conflict.reason,
            conflict_path: pkmOutcome.conflict.path,
            request_id: crypto.randomUUID(),
          },
          "POST",
          signal,
        );
        return { receiptId, state: "conflicted" };
      }
      if (pkmOutcome.outcome === "requires_upgrade") {
        throw new Error(
          pkmOutcome.message ||
            "Upgrade your Memory domain before confirming this update.",
        );
      }
    }

    const confirmed = await json<{
      receiptId: string;
      state: string;
      domain?: string;
      jsonPath?: string;
      pageId?: string;
      pageRevision?: number;
      claimId?: string;
      sourceRevision?: number;
      statement?: string;
    }>(
      "wiki/confirm",
      { receipt_id: receiptId, request_id: crypto.randomUUID() },
      "POST",
      signal,
    );

    if (
      access &&
      (!hint || !hint.jsonPath) &&
      confirmed.domain &&
      confirmed.jsonPath &&
      confirmed.pageId &&
      confirmed.claimId
    ) {
      await materializeWikiReceiptToPkm(
        access,
        {
          receiptId: confirmed.receiptId,
          domain: confirmed.domain,
          jsonPath: confirmed.jsonPath,
          pageId: confirmed.pageId,
          pageRevision: confirmed.pageRevision ?? 1,
          claimId: confirmed.claimId,
          sourceRevision: confirmed.sourceRevision ?? 1,
          statement: confirmed.statement ?? "",
        },
        { ownerConfirmed: true },
      );
    }

    invalidateFilesMutationCache(filesCacheOwner());
    return { receiptId: confirmed.receiptId, state: confirmed.state };
  },
  wikiForgetClaim: async (
    input: {
      pageId: string;
      claimId: string;
      replacementStatement?: string;
    },
    signal?: AbortSignal,
  ) => {
    const res = await json<{
      pageId: string;
      revision: number;
      outcomes: Record<string, boolean>;
      staledReceipts?: StaledWikiProjectionDescriptor[];
    }>(
      "wiki/forget",
      {
        page_id: input.pageId,
        claim_id: input.claimId,
        ...(input.replacementStatement !== undefined
          ? { replacement_statement: input.replacementStatement }
          : {}),
        request_id: crypto.randomUUID(),
      },
      "POST",
      signal,
    );
    const access = activeFilesAccess();
    if (access && Array.isArray(res.staledReceipts) && res.staledReceipts.length > 0) {
      const retraction = await retractStaleWikiProjectionsFromPkm(
        access,
        res.staledReceipts,
      );
      res.outcomes = {
        ...res.outcomes,
        revoked_future_access:
          Boolean(res.outcomes.revoked_future_access) && retraction.allSucceeded,
      };
    }
    invalidateFilesMutationCache(filesCacheOwner());
    return res;
  },
  wikiMigrateCohort: async (
    input: {
      action: WikiMigrationAction;
      expectedMigrationRevision?: number;
      v1Markdown?: string;
    },
    signal?: AbortSignal,
  ): Promise<WikiMigrationResult> => {
    const access = activeFilesAccess();
    let v1Markdown = input.v1Markdown ?? "";
    let chatKeyVerified = false;
    if (input.action === "compile_and_verify" && access) {
      if (!v1Markdown) {
        const { loadMarkdownMemory } = await import("@/lib/pkm/markdown-memory");
        const loaded = await loadMarkdownMemory({
          userId: access.owner,
          vaultKey: access.vaultKey,
          vaultOwnerToken: access.ownerToken,
          forceRefresh: true,
        }).catch(() => null);
        v1Markdown = loaded?.markdown ?? "";
      }
      try {
        const { oneChatKeyHeaders } = await import("@/lib/vault/one-chat-key");
        const headers = await oneChatKeyHeaders(access.vaultKey);
        chatKeyVerified = Object.values(headers).some((v) =>
          String(v || "").startsWith("hck1."),
        );
      } catch {
        chatKeyVerified = false;
      }
    }
    const res = await json<WikiMigrationResult>(
      "wiki/migrate",
      {
        action: input.action,
        ...(input.action === "compile_and_verify"
          ? { v1_markdown: v1Markdown, chat_key_verified: chatKeyVerified }
          : {}),
        ...(input.expectedMigrationRevision !== undefined
          ? { expected_migration_revision: input.expectedMigrationRevision }
          : {}),
        request_id: crypto.randomUUID(),
      },
      "POST",
      signal,
    );
    if (input.action === "compile_and_verify" && access) {
      await syncWikiPagesToPkmProjections(access, filesWikiSyncTransport(), {
        explicitChatSave: true,
        surface: "web",
        signal,
      }).catch(() => undefined);
    }
    invalidateFilesMutationCache(filesCacheOwner());
    return res;
  },
  wikiRollbackClassic: async (
    signal?: AbortSignal,
    options?: {
      expectedMigrationRevision?: number;
      allowPostGraduation?: boolean;
    },
  ) => {
    const access = activeFilesAccess();
    let priorV1Markdown = "";
    let expectedPersisted = false;
    if (access) {
      const { loadMarkdownMemory } = await import("@/lib/pkm/markdown-memory");
      const currentDoc = await loadMarkdownMemory({
        userId: access.owner,
        vaultKey: access.vaultKey,
        vaultOwnerToken: access.ownerToken,
        forceRefresh: true,
      }).catch(() => null);
      priorV1Markdown = currentDoc?.markdown ?? "";
      expectedPersisted = Boolean(currentDoc?.persisted);
    }
    const rolledBack = await json<{
      migrationState: string;
      migrationRevision: number;
      v1Markdown?: string;
    }>(
      "wiki/rollback",
      {
        prior_v1_markdown: priorV1Markdown,
        ...(options?.expectedMigrationRevision !== undefined
          ? { expected_migration_revision: options.expectedMigrationRevision }
          : {}),
        ...(options?.allowPostGraduation
          ? { allow_post_graduation: true }
          : {}),
        request_id: crypto.randomUUID(),
      },
      "POST",
      signal,
    );
    if (access && typeof rolledBack.v1Markdown === "string") {
      const { replaceMarkdownMemoryDocument } = await import(
        "@/lib/pkm/markdown-memory"
      );
      await replaceMarkdownMemoryDocument({
        userId: access.owner,
        vaultKey: access.vaultKey,
        vaultOwnerToken: access.ownerToken,
        markdown: rolledBack.v1Markdown,
        expectedMarkdown: priorV1Markdown,
        expectedPersisted,
        beforeEffect: async () => {
          signal?.throwIfAborted();
          access.check();
        },
      });
    }
    invalidateFilesMutationCache(filesCacheOwner());
    return rolledBack;
  },
  wikiImportArchive: async (
    input: {
      fileId: string;
      sourceProvider?: "auto" | "chatgpt" | "claude";
      idempotencyKey?: string;
    },
    signal?: AbortSignal,
  ) => {
    const imported = await json<WikiArchiveImportResult>(
      "wiki/import",
      {
        file_id: input.fileId,
        source_provider: input.sourceProvider ?? "auto",
        request_id: input.idempotencyKey ?? crypto.randomUUID(),
      },
      "POST",
      signal,
    );
    const access = activeFilesAccess();
    if (access && imported.claimsImported > 0) {
      try {
        const overview = await json<WikiOverview>(
          "wiki/overview",
          undefined,
          "GET",
          signal,
        );
        const defaultCandidates = overview.candidateReceipts.filter(
          (c) =>
            c.state === "private_candidate" &&
            c.statement &&
            c.jsonPath?.startsWith("imported_notes."),
        );
        if (defaultCandidates.length > 0) {
          const classified = await classifyWikiClaimsForPkm(
            access,
            defaultCandidates.map((c) => c.statement),
            signal,
          );
          for (const cand of defaultCandidates) {
            const match = classified.find(
              (m) => m.statement.toLowerCase() === cand.statement.toLowerCase(),
            );
            if (!match) continue;
            await json<{ receiptId: string; state: string }>(
              "wiki/projection/derive",
              {
                page_id: cand.pageId,
                claim_id: cand.claimId,
                target_domain: match.targetDomain,
                json_path: match.jsonPath,
                require_owner_confirmation: true,
                request_id: crypto.randomUUID(),
              },
              "POST",
              signal,
            ).catch(() => undefined);
          }
        }
      } catch {
        // Semantic refinement is additive; archive import already succeeded.
      }
    }
    invalidateFilesMutationCache(filesCacheOwner());
    return imported;
  },
};

const CHUNK_BYTES = 4 * 1024 * 1024;
interface DownloadWriter {
  write(value: Uint8Array): Promise<void>;
  seek(position: number): Promise<void>;
  close(): Promise<void>;
  abort(): Promise<void>;
}
interface DownloadHandle {
  getFile(): Promise<File>;
  createWritable(options: {
    keepExistingData: boolean;
  }): Promise<DownloadWriter>;
}
export type DownloadCheckpoint = {
  handle: DownloadHandle;
  fileId: string;
  size: number;
  contentHash: string;
  offset: number;
  prefixHash: string;
};
export class DownloadPaused extends FilesLocalError {
  constructor(public readonly checkpoint: DownloadCheckpoint) {
    super(
      "Download paused. Keep this page open and choose Resume download to continue.",
    );
  }
}
function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join(
    "",
  );
}
async function hashChunk(
  chain: Uint8Array,
  bytes: ArrayBuffer,
): Promise<Uint8Array<ArrayBuffer>> {
  const value = new Uint8Array(64);
  value.set(chain);
  value.set(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), 32);
  return new Uint8Array(await crypto.subtle.digest("SHA-256", value));
}
