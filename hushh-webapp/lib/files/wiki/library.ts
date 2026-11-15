/** Shared-runtime encrypted Personal Wiki library built over SharedFilesStore. */

import * as cipher from "../shared/crypto";
import { SharedFilesStore, type SharedFilesAccess } from "../shared/store";
import {
  MAX_BATCH_PAGES,
  type PublicWikiPage,
  type StoredWikiPageRevision,
  type WikiClaim,
  type WikiLinkEdge,
  WikiRefusedError,
  type WikiSourceRef,
  buildRevisionRecord,
  canonicalJson,
  normalizeSourceRef,
  renderWikiMarkdown,
  replaceMarkdownSection,
  sha256Hex,
  validateBatchId,
  validateFolder,
  validateIdempotencyKey,
  validatePageId,
  validateSourceId,
  validateTitle,
} from "./contracts";
import { BacklinkGraph, LexicalSearchIndex } from "./index-and-search";

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

interface RecentCommitRecord {
  idempotency_key: string;
  fingerprint: string;
  base_revision: number;
  revision: number;
}

interface StagedHeadSpec {
  batch_id: string;
  target_revision: number;
  target_revision_id: string;
  title: string;
  folder: string;
  status_as_of: string;
  updated_at: number;
}

interface StoredWikiHead {
  format: 1;
  page_id: string;
  revision: number;
  title: string;
  folder: string;
  status_as_of: string;
  updated_at: number;
  state: "ready" | "trashed";
  content_key_hex: string;
  revision_ids: Record<string, string>;
  recent_commits: RecentCommitRecord[];
  last_batch_id?: string;
  staged?: StagedHeadSpec;
}

interface StoredBatchItem {
  page_id: string;
  base_revision: number;
  target_revision: number;
  target_revision_id: string;
  title: string;
  folder: string;
  status_as_of: string;
  updated_at: number;
  content_sha256: string;
  content_key_hex: string;
}

interface StoredSynthesisBatch {
  format: 1;
  batch_id: string;
  idempotency_key: string;
  fingerprint: string;
  state: "committing" | "committed" | "finalized" | "aborted";
  created_at: number;
  items: StoredBatchItem[];
}

export interface SynthesisBatchItemInput {
  page_id?: string;
  expected_revision: number;
  title?: string;
  folder?: string;
  tldr?: string;
  status_as_of?: string;
  body?: string;
  claims?: WikiClaim[];
  links?: WikiLinkEdge[];
  source_ids?: string[];
}

export interface PublicBatchReceipt {
  batch_id: string;
  state: StoredSynthesisBatch["state"];
  complete: boolean;
  pages: Array<{
    page_id: string;
    base_revision: number;
    target_revision: number;
  }>;
}

function translateStoreError(error: unknown): never {
  if (error instanceof WikiRefusedError) throw error;
  if (error instanceof Error) {
    if (error.message === "FILES_REVISION_CONFLICT") {
      throw new WikiRefusedError("WIKI_REVISION_CONFLICT", 409);
    }
    if (
      error.message === "FILES_INTEGRITY_FAILURE" ||
      error.message === "FILES_KEY_INVALID" ||
      error.message === "FILES_LIBRARY_CHANGED"
    ) {
      throw new WikiRefusedError("WIKI_INTEGRITY_FAILURE", 409);
    }
  }
  throw error;
}

function parseRevisionBytes(bytes: Uint8Array): StoredWikiPageRevision {
  let decoded: unknown;
  try {
    decoded = JSON.parse(decoder.decode(bytes));
  } catch {
    throw new WikiRefusedError("WIKI_SCHEMA_INVALID", 409);
  }
  if (
    !decoded ||
    typeof decoded !== "object" ||
    (decoded as { format?: unknown }).format !== 1
  ) {
    throw new WikiRefusedError("WIKI_SCHEMA_INVALID", 409);
  }
  const raw = decoded as StoredWikiPageRevision;
  return buildRevisionRecord({
    page_id: raw.page_id,
    revision: raw.revision,
    title: raw.title,
    folder: raw.folder,
    tldr: raw.tldr,
    status_as_of: raw.status_as_of,
    body: raw.body,
    claims: raw.claims,
    links: raw.links,
    source_ids: raw.source_ids,
    updated_at: raw.updated_at,
  });
}

async function toPublicPage(
  page: StoredWikiPageRevision,
  pendingBatchId?: string,
): Promise<PublicWikiPage> {
  const { format: _format, ...rest } = page;
  const content_sha256 = await sha256Hex(canonicalJson(page));
  return {
    ...rest,
    content_sha256,
    markdown: renderWikiMarkdown(page),
    ...(pendingBatchId ? { pending_batch_id: pendingBatchId } : {}),
  };
}

export class SharedWikiLibrary {
  readonly store: SharedFilesStore;

  constructor(readonly access: SharedFilesAccess) {
    this.store = new SharedFilesStore(access);
  }

  private async derivePageContentKeyHex(pageId: string): Promise<string> {
    const left = await this.store.id(`wiki:key:a:${pageId}`);
    const right = await this.store.id(`wiki:key:b:${pageId}`);
    return `${left}${right}`;
  }

  private async makeRevisionId(
    pageId: string,
    revision: number,
    commitToken: string,
  ): Promise<string> {
    return this.store.id(`wiki:rev:${pageId}:${revision}:${commitToken}`);
  }

  private async readJson<T>(
    group: string,
    id: string,
    signal?: AbortSignal,
  ): Promise<{ value: T | null; generation: string }> {
    try {
      return await this.store.read<T>(group, id, signal);
    } catch (error) {
      translateStoreError(error);
    }
  }

  private async writeJsonHeld(
    group: string,
    id: string,
    value: unknown,
    expectedGeneration: string,
    signal?: AbortSignal,
  ): Promise<void> {
    try {
      await this.store.writeHeld(group, id, value, expectedGeneration, signal);
    } catch (error) {
      translateStoreError(error);
    }
  }

  private async listGroup<T>(
    group: string,
    signal?: AbortSignal,
  ): Promise<T[]> {
    const out: T[] = [];
    let cursor = "";
    try {
      do {
        const page = await this.store.page(group, cursor, signal);
        out.push(...(page.values as T[]));
        cursor = page.cursor;
      } while (cursor);
    } catch (error) {
      translateStoreError(error);
    }
    return out;
  }

  private async writeImmutableRevisionHeld(
    revision: StoredWikiPageRevision,
    revisionId: string,
    contentKeyHex: string,
    signal?: AbortSignal,
  ): Promise<void> {
    const pageKey = await cipher.aes(cipher.unhex(contentKeyHex));
    const bytes = encoder.encode(canonicalJson(revision));
    try {
      await this.store.writeBytesHeld(
        "wiki:revisions",
        revisionId,
        bytes,
        "",
        signal,
        pageKey,
      );
    } catch (error) {
      if (error instanceof Error && error.message === "FILES_REVISION_CONFLICT") {
        const existing = await this.readRevisionWithKey(
          revisionId,
          contentKeyHex,
          signal,
        );
        const existingDigest = await sha256Hex(canonicalJson(existing));
        const targetDigest = await sha256Hex(canonicalJson(revision));
        if (existingDigest !== targetDigest) {
          throw new WikiRefusedError("WIKI_IDEMPOTENCY_CONFLICT", 409);
        }
        return;
      }
      translateStoreError(error);
    }
  }

  async readRevisionWithKey(
    revisionId: string,
    contentKeyHex: string,
    signal?: AbortSignal,
  ): Promise<StoredWikiPageRevision> {
    const pageKey = await cipher.aes(cipher.unhex(contentKeyHex));
    let snapshot: { value: Uint8Array | null; generation: string };
    try {
      snapshot = await this.store.readBytes(
        "wiki:revisions",
        revisionId,
        signal,
        pageKey,
      );
    } catch (error) {
      translateStoreError(error);
    }
    if (!snapshot.value) {
      throw new WikiRefusedError("WIKI_NOT_FOUND", 404);
    }
    return parseRevisionBytes(snapshot.value);
  }

  private lookupIdempotentCommit(
    head: StoredWikiHead,
    idempotencyKey: string,
    fingerprint: string,
  ): number | null {
    for (const commit of head.recent_commits ?? []) {
      if (commit.idempotency_key === idempotencyKey) {
        if (commit.fingerprint !== fingerprint) {
          throw new WikiRefusedError("WIKI_IDEMPOTENCY_CONFLICT", 409);
        }
        return commit.revision;
      }
    }
    return null;
  }

  private revisionIdFor(head: StoredWikiHead, revision: number): string {
    const revId = head.revision_ids?.[String(revision)];
    if (!revId || typeof revId !== "string") {
      throw new WikiRefusedError("WIKI_NOT_FOUND", 404);
    }
    return revId;
  }

  private async resolveEffectiveHead(
    head: StoredWikiHead,
    signal?: AbortSignal,
  ): Promise<{ effective: StoredWikiHead | null; pendingBatchId?: string }> {
    if (!head.staged) {
      return { effective: head.revision >= 1 ? head : null };
    }
    const batchId = validateBatchId(head.staged.batch_id);
    const batchSnap = await this.readJson<StoredSynthesisBatch>(
      "wiki:batches",
      batchId,
      signal,
    );
    const state = batchSnap.value?.state ?? "aborted";
    if (state === "committed" || state === "finalized") {
      const { staged, ...rest } = head;
      return {
        effective: {
          ...rest,
          revision: staged.target_revision,
          title: staged.title,
          folder: staged.folder,
          status_as_of: staged.status_as_of,
          updated_at: staged.updated_at,
          last_batch_id: batchId,
          revision_ids: {
            ...head.revision_ids,
            [String(staged.target_revision)]: staged.target_revision_id,
          },
        },
      };
    }
    if (state === "committing") {
      return {
        effective: head.revision >= 1 ? head : null,
        pendingBatchId: batchId,
      };
    }
    const { staged: _discarded, ...clean } = head;
    return { effective: clean.revision >= 1 ? clean : null };
  }

  private async refreshIndexesHeld(
    page: StoredWikiPageRevision,
    signal?: AbortSignal,
  ): Promise<void> {
    const backlinkSnap = await this.readJson<unknown>(
      "wiki:indexes",
      "backlinks",
      signal,
    );
    const graph = backlinkSnap.value
      ? BacklinkGraph.fromStored(backlinkSnap.value)
      : new BacklinkGraph();
    graph.upsertPage(page);
    await this.writeJsonHeld(
      "wiki:indexes",
      "backlinks",
      graph.toStored(),
      backlinkSnap.generation,
      signal,
    );

    const lexicalSnap = await this.readJson<unknown>(
      "wiki:indexes",
      "lexical",
      signal,
    );
    const lexical = lexicalSnap.value
      ? LexicalSearchIndex.fromStored(lexicalSnap.value)
      : new LexicalSearchIndex();
    lexical.upsertPage(page);
    await this.writeJsonHeld(
      "wiki:indexes",
      "lexical",
      lexical.toStored(),
      lexicalSnap.generation,
      signal,
    );
  }

  async registerSource(
    source: WikiSourceRef,
    idempotencyKey: string,
    signal?: AbortSignal,
  ): Promise<Required<WikiSourceRef>> {
    validateIdempotencyKey(idempotencyKey);
    const normalized = normalizeSourceRef(source);
    return this.store.serialize(async () => {
      const existing = await this.readJson<
        Required<WikiSourceRef> & { format: 1 }
      >("wiki:sources", normalized.source_id, signal);
      if (existing.value) {
        const stored = normalizeSourceRef(existing.value);
        if (canonicalJson(stored) !== canonicalJson(normalized)) {
          throw new WikiRefusedError("WIKI_IDEMPOTENCY_CONFLICT", 409);
        }
        return stored;
      }
      await this.writeJsonHeld(
        "wiki:sources",
        normalized.source_id,
        { format: 1, ...normalized },
        "",
        signal,
      );
      return normalized;
    });
  }

  async getSource(
    sourceId: string,
    signal?: AbortSignal,
  ): Promise<Required<WikiSourceRef>> {
    const validated = validateSourceId(sourceId);
    const snap = await this.readJson<Required<WikiSourceRef> & { format: 1 }>(
      "wiki:sources",
      validated,
      signal,
    );
    if (!snap.value) throw new WikiRefusedError("WIKI_NOT_FOUND", 404);
    return normalizeSourceRef(snap.value);
  }

  async createPage(
    input: {
      title: string;
      idempotency_key: string;
      folder?: string;
      tldr?: string;
      status_as_of?: string;
      body?: string;
      claims?: WikiClaim[];
      links?: WikiLinkEdge[];
      source_ids?: string[];
      page_id?: string;
    },
    signal?: AbortSignal,
  ): Promise<PublicWikiPage> {
    const idem = validateIdempotencyKey(input.idempotency_key);
    return this.store.serialize(async () => {
      const pageId = input.page_id
        ? validatePageId(input.page_id)
        : `wpg_${(await this.store.id(`wiki:page:${idem}`)).slice(0, 16)}`;
      const fingerprint = await sha256Hex(
        canonicalJson({
          op: "createPage",
          page_id: pageId,
          title: input.title,
          folder: input.folder ?? "root",
          tldr: input.tldr ?? "",
          status_as_of: input.status_as_of ?? "2026-01-01",
          body: input.body ?? "",
          claims: input.claims ?? [],
          links: input.links ?? [],
          source_ids: input.source_ids ?? [],
        }),
      );

      const existing = await this.readJson<StoredWikiHead>(
        "wiki:heads",
        pageId,
        signal,
      );
      if (existing.value) {
        const replayRev = this.lookupIdempotentCommit(
          existing.value,
          idem,
          fingerprint,
        );
        if (replayRev !== null) {
          return this.readPage(pageId, { revision: replayRev }, signal);
        }
        throw new WikiRefusedError("WIKI_REVISION_CONFLICT", 409);
      }

      const contentKeyHex = await this.derivePageContentKeyHex(pageId);
      const revId = await this.makeRevisionId(pageId, 1, idem);
      let updatedAt = Date.now();
      const pageKey = await cipher.aes(cipher.unhex(contentKeyHex));
      const priorRevSnap = await this.store.readBytes(
        "wiki:revisions",
        revId,
        signal,
        pageKey,
      );
      if (priorRevSnap.value) {
        updatedAt = parseRevisionBytes(priorRevSnap.value).updated_at;
      }

      const revisionDoc = buildRevisionRecord({
        page_id: pageId,
        revision: 1,
        title: input.title,
        folder: input.folder ?? "root",
        tldr: input.tldr ?? "",
        status_as_of: input.status_as_of ?? "2026-01-01",
        body: input.body ?? "",
        claims: input.claims ?? [],
        links: input.links ?? [],
        source_ids: input.source_ids ?? [],
        updated_at: updatedAt,
      });

      await this.writeImmutableRevisionHeld(
        revisionDoc,
        revId,
        contentKeyHex,
        signal,
      );

      const head: StoredWikiHead = {
        format: 1,
        page_id: pageId,
        revision: 1,
        title: revisionDoc.title,
        folder: revisionDoc.folder,
        status_as_of: revisionDoc.status_as_of,
        updated_at: updatedAt,
        state: "ready",
        content_key_hex: contentKeyHex,
        revision_ids: { "1": revId },
        recent_commits: [
          {
            idempotency_key: idem,
            fingerprint,
            base_revision: 0,
            revision: 1,
          },
        ],
      };
      await this.writeJsonHeld("wiki:heads", pageId, head, "", signal);
      await this.refreshIndexesHeld(revisionDoc, signal);
      return toPublicPage(revisionDoc);
    });
  }

  async readPage(
    pageId: string,
    options?: { revision?: number; requireSettled?: boolean },
    signal?: AbortSignal,
  ): Promise<PublicWikiPage> {
    const validated = validatePageId(pageId);
    const snap = await this.readJson<StoredWikiHead>(
      "wiki:heads",
      validated,
      signal,
    );
    if (!snap.value) throw new WikiRefusedError("WIKI_NOT_FOUND", 404);
    const { effective, pendingBatchId } = await this.resolveEffectiveHead(
      snap.value,
      signal,
    );
    if (options?.requireSettled && pendingBatchId) {
      throw new WikiRefusedError("WIKI_BATCH_INCOMPLETE", 409);
    }
    if (!effective) {
      if (pendingBatchId) {
        throw new WikiRefusedError("WIKI_BATCH_INCOMPLETE", 409);
      }
      throw new WikiRefusedError("WIKI_NOT_FOUND", 404);
    }
    if (effective.state === "trashed") {
      throw new WikiRefusedError("WIKI_NOT_FOUND", 404);
    }
    const targetRev = options?.revision ?? effective.revision;
    if (
      !Number.isSafeInteger(targetRev) ||
      targetRev < 1 ||
      targetRev > effective.revision
    ) {
      throw new WikiRefusedError("WIKI_NOT_FOUND", 404);
    }
    const revId = this.revisionIdFor(effective, targetRev);
    const revDoc = await this.readRevisionWithKey(
      revId,
      effective.content_key_hex,
      signal,
    );
    return toPublicPage(revDoc, pendingBatchId);
  }

  async exportNarrowPageKey(
    pageId: string,
    signal?: AbortSignal,
  ): Promise<{ contentKeyHex: string; revisionId: string }> {
    const validated = validatePageId(pageId);
    const snap = await this.readJson<StoredWikiHead>(
      "wiki:heads",
      validated,
      signal,
    );
    if (!snap.value) throw new WikiRefusedError("WIKI_NOT_FOUND", 404);
    const { effective } = await this.resolveEffectiveHead(snap.value, signal);
    if (!effective) throw new WikiRefusedError("WIKI_NOT_FOUND", 404);
    return {
      contentKeyHex: effective.content_key_hex,
      revisionId: this.revisionIdFor(effective, effective.revision),
    };
  }

  async editPage(
    pageId: string,
    input: {
      expected_revision: number;
      idempotency_key: string;
      title?: string;
      folder?: string;
      tldr?: string;
      status_as_of?: string;
      body?: string;
      claims?: WikiClaim[];
      links?: WikiLinkEdge[];
      source_ids?: string[];
      _fingerprintOverride?: string;
    },
    signal?: AbortSignal,
  ): Promise<PublicWikiPage> {
    const validated = validatePageId(pageId);
    const idem = validateIdempotencyKey(input.idempotency_key);
    if (
      !Number.isSafeInteger(input.expected_revision) ||
      input.expected_revision < 1
    ) {
      throw new WikiRefusedError("WIKI_SCHEMA_INVALID", 400);
    }
    return this.store.serialize(async () => {
      const fingerprint =
        input._fingerprintOverride ??
        (await sha256Hex(
          canonicalJson({
            op: "editPage",
            page_id: validated,
            expected_revision: input.expected_revision,
            title: input.title ?? null,
            folder: input.folder ?? null,
            tldr: input.tldr ?? null,
            status_as_of: input.status_as_of ?? null,
            body: input.body ?? null,
            claims: input.claims ?? null,
            links: input.links ?? null,
            source_ids: input.source_ids ?? null,
          }),
        ));

      const headSnap = await this.readJson<StoredWikiHead>(
        "wiki:heads",
        validated,
        signal,
      );
      if (!headSnap.value) throw new WikiRefusedError("WIKI_NOT_FOUND", 404);

      const replayRev = this.lookupIdempotentCommit(
        headSnap.value,
        idem,
        fingerprint,
      );
      if (replayRev !== null) {
        return this.readPage(validated, { revision: replayRev }, signal);
      }

      const { effective, pendingBatchId } = await this.resolveEffectiveHead(
        headSnap.value,
        signal,
      );
      if (pendingBatchId) {
        throw new WikiRefusedError("WIKI_BATCH_INCOMPLETE", 409);
      }
      if (!effective || effective.state === "trashed") {
        throw new WikiRefusedError("WIKI_NOT_FOUND", 404);
      }
      if (effective.revision !== input.expected_revision) {
        throw new WikiRefusedError("WIKI_REVISION_CONFLICT", 409);
      }

      const currentDoc = await this.readRevisionWithKey(
        this.revisionIdFor(effective, input.expected_revision),
        effective.content_key_hex,
        signal,
      );
      const targetRev = input.expected_revision + 1;
      const revId = await this.makeRevisionId(validated, targetRev, idem);
      let updatedAt = Math.max(Date.now(), currentDoc.updated_at + 1);

      const pageKey = await cipher.aes(cipher.unhex(effective.content_key_hex));
      const priorRevSnap = await this.store.readBytes(
        "wiki:revisions",
        revId,
        signal,
        pageKey,
      );
      if (priorRevSnap.value) {
        updatedAt = parseRevisionBytes(priorRevSnap.value).updated_at;
      }

      const nextDoc = buildRevisionRecord({
        page_id: validated,
        revision: targetRev,
        title: input.title ?? currentDoc.title,
        folder: input.folder ?? currentDoc.folder,
        tldr: input.tldr ?? currentDoc.tldr,
        status_as_of: input.status_as_of ?? currentDoc.status_as_of,
        body: input.body ?? currentDoc.body,
        claims: input.claims ?? currentDoc.claims,
        links: input.links ?? currentDoc.links,
        source_ids: input.source_ids ?? currentDoc.source_ids,
        updated_at: updatedAt,
      });

      await this.writeImmutableRevisionHeld(
        nextDoc,
        revId,
        effective.content_key_hex,
        signal,
      );

      const nextHead: StoredWikiHead = {
        ...effective,
        format: 1,
        revision: targetRev,
        title: nextDoc.title,
        folder: nextDoc.folder,
        status_as_of: nextDoc.status_as_of,
        updated_at: updatedAt,
        revision_ids: {
          ...effective.revision_ids,
          [String(targetRev)]: revId,
        },
        recent_commits: [
          ...(effective.recent_commits ?? []),
          {
            idempotency_key: idem,
            fingerprint,
            base_revision: input.expected_revision,
            revision: targetRev,
          },
        ].slice(-16),
      };
      delete nextHead.staged;
      await this.writeJsonHeld(
        "wiki:heads",
        validated,
        nextHead,
        headSnap.generation,
        signal,
      );
      await this.refreshIndexesHeld(nextDoc, signal);
      return toPublicPage(nextDoc);
    });
  }

  async editSection(
    pageId: string,
    input: {
      heading: string;
      content: string | null;
      expected_revision: number;
      idempotency_key: string;
      level?: number;
      createIfMissing?: boolean;
      status_as_of?: string;
    },
    signal?: AbortSignal,
  ): Promise<PublicWikiPage> {
    const validated = validatePageId(pageId);
    const idem = validateIdempotencyKey(input.idempotency_key);
    const fingerprint = await sha256Hex(
      canonicalJson({
        op: "editSection",
        page_id: validated,
        expected_revision: input.expected_revision,
        heading: input.heading,
        content: input.content,
        level: input.level ?? 2,
        createIfMissing: input.createIfMissing ?? true,
        status_as_of: input.status_as_of ?? null,
      }),
    );

    const headSnap = await this.readJson<StoredWikiHead>(
      "wiki:heads",
      validated,
      signal,
    );
    if (!headSnap.value) throw new WikiRefusedError("WIKI_NOT_FOUND", 404);
    const replayRev = this.lookupIdempotentCommit(
      headSnap.value,
      idem,
      fingerprint,
    );
    if (replayRev !== null) {
      return this.readPage(validated, { revision: replayRev }, signal);
    }

    const current = await this.readPage(
      validated,
      { requireSettled: true },
      signal,
    );
    if (current.revision !== input.expected_revision) {
      throw new WikiRefusedError("WIKI_REVISION_CONFLICT", 409);
    }
    const updatedBody = replaceMarkdownSection(current.body, {
      heading: input.heading,
      content: input.content,
      level: input.level,
      createIfMissing: input.createIfMissing,
    });
    return this.editPage(
      validated,
      {
        expected_revision: input.expected_revision,
        idempotency_key: idem,
        body: updatedBody,
        status_as_of: input.status_as_of,
        _fingerprintOverride: fingerprint,
      },
      signal,
    );
  }

  async renamePage(
    pageId: string,
    input: {
      title: string;
      expected_revision: number;
      idempotency_key: string;
    },
    signal?: AbortSignal,
  ): Promise<PublicWikiPage> {
    return this.editPage(
      pageId,
      {
        expected_revision: input.expected_revision,
        idempotency_key: input.idempotency_key,
        title: validateTitle(input.title),
      },
      signal,
    );
  }

  async movePage(
    pageId: string,
    input: {
      folder: string;
      expected_revision: number;
      idempotency_key: string;
    },
    signal?: AbortSignal,
  ): Promise<PublicWikiPage> {
    return this.editPage(
      pageId,
      {
        expected_revision: input.expected_revision,
        idempotency_key: input.idempotency_key,
        folder: validateFolder(input.folder),
      },
      signal,
    );
  }

  async listPages(
    folder?: string,
    signal?: AbortSignal,
  ): Promise<
    Array<{
      page_id: string;
      revision: number;
      title: string;
      folder: string;
      status_as_of: string;
      updated_at: number;
      pending_batch_id?: string;
    }>
  > {
    const normalizedFolder =
      folder === undefined ? undefined : validateFolder(folder);
    const heads = await this.listGroup<StoredWikiHead>("wiki:heads", signal);
    const out: Array<{
      page_id: string;
      revision: number;
      title: string;
      folder: string;
      status_as_of: string;
      updated_at: number;
      pending_batch_id?: string;
    }> = [];
    for (const rawHead of heads) {
      const { effective, pendingBatchId } = await this.resolveEffectiveHead(
        rawHead,
        signal,
      );
      if (!effective || effective.state === "trashed") continue;
      if (normalizedFolder && effective.folder !== normalizedFolder) continue;
      out.push({
        page_id: effective.page_id,
        revision: effective.revision,
        title: effective.title,
        folder: effective.folder,
        status_as_of: effective.status_as_of,
        updated_at: effective.updated_at,
        ...(pendingBatchId ? { pending_batch_id: pendingBatchId } : {}),
      });
    }
    return out.sort((a, b) => a.page_id.localeCompare(b.page_id));
  }

  async commitSynthesisBatch(
    input: {
      items: SynthesisBatchItemInput[];
      idempotency_key: string;
      _failAfterStagedCount?: number;
      _failAfterCommitFlip?: boolean;
    },
    signal?: AbortSignal,
  ): Promise<PublicBatchReceipt> {
    const idem = validateIdempotencyKey(input.idempotency_key);
    if (
      !Array.isArray(input.items) ||
      input.items.length < 1 ||
      input.items.length > MAX_BATCH_PAGES
    ) {
      throw new WikiRefusedError("WIKI_SCHEMA_INVALID", 400);
    }

    return this.store.serialize(async () => {
      const batchId = `wbt_${(await this.store.id(`wiki:batch:${idem}`)).slice(0, 16)}`;
      const fingerprint = await sha256Hex(
        canonicalJson({ op: "synthesisBatch", items: input.items }),
      );
      const existingBatch = await this.readJson<StoredSynthesisBatch>(
        "wiki:batches",
        batchId,
        signal,
      );
      if (existingBatch.value) {
        if (existingBatch.value.fingerprint !== fingerprint) {
          throw new WikiRefusedError("WIKI_IDEMPOTENCY_CONFLICT", 409);
        }
        if (existingBatch.value.state === "finalized") {
          return this.publicBatch(existingBatch.value);
        }
        return this.driveBatchHeld(batchId, {}, signal);
      }

      const prepared: StoredBatchItem[] = [];
      const seenPages = new Set<string>();
      const nowMs = Date.now();

      for (let idx = 0; idx < input.items.length; idx++) {
        const raw = input.items[idx];
        if (
          !raw ||
          !Number.isSafeInteger(raw.expected_revision) ||
          raw.expected_revision < 0
        ) {
          throw new WikiRefusedError("WIKI_SCHEMA_INVALID", 400);
        }
        const pageId = raw.page_id
          ? validatePageId(raw.page_id)
          : `wpg_${(await this.store.id(`wiki:batch_page:${idem}:${idx}`)).slice(0, 16)}`;
        if (seenPages.has(pageId)) {
          throw new WikiRefusedError("WIKI_SCHEMA_INVALID", 400);
        }
        seenPages.add(pageId);

        const headSnap = await this.readJson<StoredWikiHead>(
          "wiki:heads",
          pageId,
          signal,
        );
        let contentKeyHex: string;
        let targetDoc: StoredWikiPageRevision;

        if (raw.expected_revision === 0) {
          if (headSnap.value) {
            const { effective, pendingBatchId } =
              await this.resolveEffectiveHead(headSnap.value, signal);
            if (pendingBatchId) {
              throw new WikiRefusedError("WIKI_BATCH_INCOMPLETE", 409);
            }
            if (effective) {
              throw new WikiRefusedError("WIKI_REVISION_CONFLICT", 409);
            }
          }
          contentKeyHex = await this.derivePageContentKeyHex(pageId);
          targetDoc = buildRevisionRecord({
            page_id: pageId,
            revision: 1,
            title: raw.title ?? "",
            folder: raw.folder ?? "root",
            tldr: raw.tldr ?? "",
            status_as_of: raw.status_as_of ?? "2026-01-01",
            body: raw.body ?? "",
            claims: raw.claims ?? [],
            links: raw.links ?? [],
            source_ids: raw.source_ids ?? [],
            updated_at: nowMs + idx,
          });
        } else {
          if (!headSnap.value) {
            throw new WikiRefusedError("WIKI_NOT_FOUND", 404);
          }
          const { effective, pendingBatchId } = await this.resolveEffectiveHead(
            headSnap.value,
            signal,
          );
          if (pendingBatchId) {
            throw new WikiRefusedError("WIKI_BATCH_INCOMPLETE", 409);
          }
          if (!effective || effective.state === "trashed") {
            throw new WikiRefusedError("WIKI_NOT_FOUND", 404);
          }
          if (effective.revision !== raw.expected_revision) {
            throw new WikiRefusedError("WIKI_REVISION_CONFLICT", 409);
          }
          contentKeyHex = effective.content_key_hex;
          const currentDoc = await this.readRevisionWithKey(
            this.revisionIdFor(effective, raw.expected_revision),
            contentKeyHex,
            signal,
          );
          targetDoc = buildRevisionRecord({
            page_id: pageId,
            revision: raw.expected_revision + 1,
            title: raw.title ?? currentDoc.title,
            folder: raw.folder ?? currentDoc.folder,
            tldr: raw.tldr ?? currentDoc.tldr,
            status_as_of: raw.status_as_of ?? currentDoc.status_as_of,
            body: raw.body ?? currentDoc.body,
            claims: raw.claims ?? currentDoc.claims,
            links: raw.links ?? currentDoc.links,
            source_ids: raw.source_ids ?? currentDoc.source_ids,
            updated_at: Math.max(nowMs + idx, currentDoc.updated_at + 1),
          });
        }

        const targetRevId = await this.makeRevisionId(
          pageId,
          targetDoc.revision,
          `${batchId}:${idx}`,
        );
        await this.writeImmutableRevisionHeld(
          targetDoc,
          targetRevId,
          contentKeyHex,
          signal,
        );
        prepared.push({
          page_id: pageId,
          base_revision: raw.expected_revision,
          target_revision: targetDoc.revision,
          target_revision_id: targetRevId,
          title: targetDoc.title,
          folder: targetDoc.folder,
          status_as_of: targetDoc.status_as_of,
          updated_at: targetDoc.updated_at,
          content_sha256: await sha256Hex(canonicalJson(targetDoc)),
          content_key_hex: contentKeyHex,
        });
      }

      const batch: StoredSynthesisBatch = {
        format: 1,
        batch_id: batchId,
        idempotency_key: idem,
        fingerprint,
        state: "committing",
        created_at: nowMs,
        items: prepared,
      };
      await this.writeJsonHeld("wiki:batches", batchId, batch, "", signal);
      return this.driveBatchHeld(
        batchId,
        {
          failAfterStagedCount: input._failAfterStagedCount,
          failAfterCommitFlip: input._failAfterCommitFlip,
        },
        signal,
      );
    });
  }

  private async driveBatchHeld(
    batchId: string,
    faults: {
      failAfterStagedCount?: number;
      failAfterCommitFlip?: boolean;
    },
    signal?: AbortSignal,
  ): Promise<PublicBatchReceipt> {
    let batchSnap = await this.readJson<StoredSynthesisBatch>(
      "wiki:batches",
      batchId,
      signal,
    );
    if (!batchSnap.value) throw new WikiRefusedError("WIKI_NOT_FOUND", 404);
    let batch = batchSnap.value;
    if (batch.state === "finalized" || batch.state === "aborted") {
      return this.publicBatch(batch);
    }

    if (batch.state === "committing") {
      let stagedCount = 0;
      for (const spec of batch.items) {
        const headSnap = await this.readJson<StoredWikiHead>(
          "wiki:heads",
          spec.page_id,
          signal,
        );
        const alreadyStaged = headSnap.value?.staged?.batch_id === batchId;
        if (!alreadyStaged) {
          const staged: StagedHeadSpec = {
            batch_id: batchId,
            target_revision: spec.target_revision,
            target_revision_id: spec.target_revision_id,
            title: spec.title,
            folder: spec.folder,
            status_as_of: spec.status_as_of,
            updated_at: spec.updated_at,
          };
          try {
            if (spec.base_revision === 0) {
              if (headSnap.value && headSnap.value.revision >= 1) {
                throw new WikiRefusedError("WIKI_REVISION_CONFLICT", 409);
              }
              const stagingHead: StoredWikiHead = {
                format: 1,
                page_id: spec.page_id,
                revision: 0,
                title: spec.title,
                folder: spec.folder,
                status_as_of: spec.status_as_of,
                updated_at: spec.updated_at,
                state: "ready",
                content_key_hex: spec.content_key_hex,
                revision_ids: {},
                recent_commits: [],
                staged,
              };
              await this.writeJsonHeld(
                "wiki:heads",
                spec.page_id,
                stagingHead,
                headSnap.value ? headSnap.generation : "",
                signal,
              );
            } else {
              if (!headSnap.value) {
                throw new WikiRefusedError("WIKI_REVISION_CONFLICT", 409);
              }
              const { effective, pendingBatchId } =
                await this.resolveEffectiveHead(headSnap.value, signal);
              if (pendingBatchId && pendingBatchId !== batchId) {
                throw new WikiRefusedError("WIKI_REVISION_CONFLICT", 409);
              }
              if (!effective || effective.revision !== spec.base_revision) {
                throw new WikiRefusedError("WIKI_REVISION_CONFLICT", 409);
              }
              await this.writeJsonHeld(
                "wiki:heads",
                spec.page_id,
                { ...effective, staged },
                headSnap.generation,
                signal,
              );
            }
          } catch (error) {
            if (
              error instanceof WikiRefusedError &&
              error.code === "WIKI_REVISION_CONFLICT"
            ) {
              const aborted: StoredSynthesisBatch = {
                ...batch,
                state: "aborted",
              };
              await this.writeJsonHeld(
                "wiki:batches",
                batchId,
                aborted,
                batchSnap.generation,
                signal,
              );
              await this.cleanupAbortedBatchHeld(aborted, signal);
              throw error;
            }
            throw error;
          }
        }
        stagedCount += 1;
        if (
          faults.failAfterStagedCount !== undefined &&
          stagedCount >= faults.failAfterStagedCount
        ) {
          throw new Error("simulated_synthesis_interruption_during_staging");
        }
      }

      const committed: StoredSynthesisBatch = { ...batch, state: "committed" };
      await this.writeJsonHeld(
        "wiki:batches",
        batchId,
        committed,
        batchSnap.generation,
        signal,
      );
      if (faults.failAfterCommitFlip) {
        throw new Error("simulated_synthesis_interruption_after_commit");
      }
      batchSnap = await this.readJson<StoredSynthesisBatch>(
        "wiki:batches",
        batchId,
        signal,
      );
      batch = batchSnap.value!;
    }

    for (const spec of batch.items) {
      const headSnap = await this.readJson<StoredWikiHead>(
        "wiki:heads",
        spec.page_id,
        signal,
      );
      if (headSnap.value?.staged?.batch_id === batchId) {
        const { staged: _staged, ...rest } = headSnap.value;
        const finalizedHead: StoredWikiHead = {
          ...rest,
          revision: spec.target_revision,
          title: spec.title,
          folder: spec.folder,
          status_as_of: spec.status_as_of,
          updated_at: spec.updated_at,
          last_batch_id: batchId,
          revision_ids: {
            ...rest.revision_ids,
            [String(spec.target_revision)]: spec.target_revision_id,
          },
          recent_commits: [
            ...(rest.recent_commits ?? []),
            {
              idempotency_key: `${batch.idempotency_key}:${spec.page_id}`,
              fingerprint: spec.content_sha256,
              base_revision: spec.base_revision,
              revision: spec.target_revision,
            },
          ].slice(-16),
        };
        await this.writeJsonHeld(
          "wiki:heads",
          spec.page_id,
          finalizedHead,
          headSnap.generation,
          signal,
        );
      }
      const revDoc = await this.readRevisionWithKey(
        spec.target_revision_id,
        spec.content_key_hex,
        signal,
      );
      await this.refreshIndexesHeld(revDoc, signal);
    }

    const finalized: StoredSynthesisBatch = { ...batch, state: "finalized" };
    await this.writeJsonHeld(
      "wiki:batches",
      batchId,
      finalized,
      batchSnap.generation,
      signal,
    );
    return this.publicBatch(finalized);
  }

  private async cleanupAbortedBatchHeld(
    batch: StoredSynthesisBatch,
    signal?: AbortSignal,
  ): Promise<void> {
    for (const spec of batch.items) {
      const headSnap = await this.readJson<StoredWikiHead>(
        "wiki:heads",
        spec.page_id,
        signal,
      );
      if (headSnap.value?.staged?.batch_id !== batch.batch_id) continue;
      const { staged: _staged, ...clean } = headSnap.value;
      await this.writeJsonHeld(
        "wiki:heads",
        spec.page_id,
        clean.revision >= 1 ? clean : { ...clean, state: "trashed" },
        headSnap.generation,
        signal,
      );
    }
  }

  async recoverBatch(
    batchId: string,
    signal?: AbortSignal,
  ): Promise<PublicBatchReceipt> {
    const validated = validateBatchId(batchId);
    return this.store.serialize(async () => {
      try {
        return await this.driveBatchHeld(validated, {}, signal);
      } catch (error) {
        if (
          error instanceof WikiRefusedError &&
          error.code === "WIKI_REVISION_CONFLICT"
        ) {
          const snap = await this.readJson<StoredSynthesisBatch>(
            "wiki:batches",
            validated,
            signal,
          );
          if (snap.value?.state === "aborted") {
            return this.publicBatch(snap.value);
          }
        }
        throw error;
      }
    });
  }

  async incompleteBatches(signal?: AbortSignal): Promise<PublicBatchReceipt[]> {
    const batches = await this.listGroup<StoredSynthesisBatch>(
      "wiki:batches",
      signal,
    );
    return batches
      .filter((b) => b.state === "committing" || b.state === "committed")
      .map((b) => this.publicBatch(b))
      .sort((a, b) => a.batch_id.localeCompare(b.batch_id));
  }

  private publicBatch(batch: StoredSynthesisBatch): PublicBatchReceipt {
    return {
      batch_id: batch.batch_id,
      state: batch.state,
      complete: batch.state === "committed" || batch.state === "finalized",
      pages: batch.items.map((item) => ({
        page_id: item.page_id,
        base_revision: item.base_revision,
        target_revision: item.target_revision,
      })),
    };
  }

  async backlinks(pageId: string, signal?: AbortSignal) {
    const validated = validatePageId(pageId);
    const targetPage = await this.readPage(validated, undefined, signal);
    let graphSnap = await this.readJson<unknown>(
      "wiki:indexes",
      "backlinks",
      signal,
    );
    if (!graphSnap.value) {
      await this.rebuildIndexes(signal);
      graphSnap = await this.readJson<unknown>(
        "wiki:indexes",
        "backlinks",
        signal,
      );
    }
    const graph = graphSnap.value
      ? BacklinkGraph.fromStored(graphSnap.value)
      : new BacklinkGraph();

    const inbound: Array<{
      source_page_id: string;
      source_title: string;
      source_folder: string;
      source_revision: number;
      relation: string;
      anchor_claim_id?: string;
      note?: string;
    }> = [];
    for (const candidate of graph.inboundFor(validated)) {
      let liveSource: PublicWikiPage;
      try {
        liveSource = await this.readPage(
          candidate.source_page_id,
          undefined,
          signal,
        );
      } catch (error) {
        if (
          error instanceof WikiRefusedError &&
          (error.code === "WIKI_NOT_FOUND" ||
            error.code === "WIKI_BATCH_INCOMPLETE")
        ) {
          continue;
        }
        throw error;
      }
      for (const edge of liveSource.links) {
        if (
          edge.target_page_id === validated &&
          edge.relation === candidate.relation &&
          (edge.anchor_claim_id ?? "") === (candidate.anchor_claim_id ?? "")
        ) {
          inbound.push({
            source_page_id: candidate.source_page_id,
            source_title: liveSource.title,
            source_folder: liveSource.folder,
            source_revision: liveSource.revision,
            relation: edge.relation,
            ...(edge.anchor_claim_id
              ? { anchor_claim_id: edge.anchor_claim_id }
              : {}),
            ...(edge.note ? { note: edge.note } : {}),
          });
        }
      }
    }

    const outbound: Array<{
      target_page_id: string;
      target_title: string;
      target_folder: string;
      target_revision: number;
      relation: string;
      anchor_claim_id?: string;
      note?: string;
    }> = [];
    for (const edge of targetPage.links) {
      let liveDest: PublicWikiPage;
      try {
        liveDest = await this.readPage(edge.target_page_id, undefined, signal);
      } catch (error) {
        if (
          error instanceof WikiRefusedError &&
          (error.code === "WIKI_NOT_FOUND" ||
            error.code === "WIKI_BATCH_INCOMPLETE")
        ) {
          continue;
        }
        throw error;
      }
      outbound.push({
        target_page_id: edge.target_page_id,
        target_title: liveDest.title,
        target_folder: liveDest.folder,
        target_revision: liveDest.revision,
        relation: edge.relation,
        ...(edge.anchor_claim_id
          ? { anchor_claim_id: edge.anchor_claim_id }
          : {}),
        ...(edge.note ? { note: edge.note } : {}),
      });
    }

    return {
      page_id: validated,
      revision: targetPage.revision,
      inbound,
      outbound,
    };
  }

  async search(
    query: string,
    options?: { limit?: number; folder?: string },
    signal?: AbortSignal,
  ) {
    if (typeof query !== "string") {
      throw new WikiRefusedError("WIKI_SCHEMA_INVALID", 400);
    }
    const limit = options?.limit ?? 10;
    const normalizedFolder =
      options?.folder === undefined
        ? undefined
        : validateFolder(options.folder);
    let lexicalSnap = await this.readJson<unknown>(
      "wiki:indexes",
      "lexical",
      signal,
    );
    if (!lexicalSnap.value) {
      await this.rebuildIndexes(signal);
      lexicalSnap = await this.readJson<unknown>(
        "wiki:indexes",
        "lexical",
        signal,
      );
    }
    const index = lexicalSnap.value
      ? LexicalSearchIndex.fromStored(lexicalSnap.value)
      : new LexicalSearchIndex();

    const candidates = index.queryCandidates(
      query,
      Math.min(Math.max(limit * 2, limit), 50),
    );
    const results: Array<{
      page_id: string;
      revision: number;
      title: string;
      folder: string;
      status_as_of: string;
      score: number;
      matched_terms: string[];
      snippet: string;
      source_ids: string[];
    }> = [];

    for (const candidate of candidates) {
      if (results.length >= limit) break;
      let livePage: PublicWikiPage;
      try {
        livePage = await this.readPage(candidate.page_id, undefined, signal);
      } catch (error) {
        if (
          error instanceof WikiRefusedError &&
          (error.code === "WIKI_NOT_FOUND" ||
            error.code === "WIKI_BATCH_INCOMPLETE")
        ) {
          continue;
        }
        throw error;
      }
      if (normalizedFolder && livePage.folder !== normalizedFolder) continue;
      const activeClaim = livePage.claims.find(
        (c) => c.status === "active" || c.status === "uncertain",
      );
      const snippet =
        livePage.tldr || activeClaim?.statement || livePage.body.slice(0, 200);
      results.push({
        page_id: livePage.page_id,
        revision: livePage.revision,
        title: livePage.title,
        folder: livePage.folder,
        status_as_of: livePage.status_as_of,
        score: candidate.score,
        matched_terms: candidate.matched_terms,
        snippet,
        source_ids: livePage.source_ids,
      });
    }
    return results;
  }

  async rebuildIndexes(signal?: AbortSignal): Promise<{
    page_count: number;
    backlinks_digest: string;
    lexical_digest: string;
  }> {
    return this.store.serialize(async () => {
      const heads = await this.listGroup<StoredWikiHead>("wiki:heads", signal);
      const liveRevisions: StoredWikiPageRevision[] = [];
      for (const rawHead of heads) {
        const { effective } = await this.resolveEffectiveHead(rawHead, signal);
        if (!effective || effective.state === "trashed") continue;
        const revId = this.revisionIdFor(effective, effective.revision);
        liveRevisions.push(
          await this.readRevisionWithKey(
            revId,
            effective.content_key_hex,
            signal,
          ),
        );
      }

      const graph = BacklinkGraph.fromPages(liveRevisions);
      const lexical = LexicalSearchIndex.fromPages(liveRevisions);

      const backlinkSnap = await this.readJson<unknown>(
        "wiki:indexes",
        "backlinks",
        signal,
      );
      await this.writeJsonHeld(
        "wiki:indexes",
        "backlinks",
        graph.toStored(),
        backlinkSnap.generation,
        signal,
      );

      const lexicalSnap = await this.readJson<unknown>(
        "wiki:indexes",
        "lexical",
        signal,
      );
      await this.writeJsonHeld(
        "wiki:indexes",
        "lexical",
        lexical.toStored(),
        lexicalSnap.generation,
        signal,
      );

      return {
        page_count: liveRevisions.length,
        backlinks_digest: await graph.digest(),
        lexical_digest: await lexical.digest(),
      };
    });
  }

  async exportWiki(signal?: AbortSignal) {
    this.store.check();
    const summaries = await this.listPages(undefined, signal);
    const pages: PublicWikiPage[] = [];
    for (const summary of summaries) {
      pages.push(await this.readPage(summary.page_id, undefined, signal));
    }

    const rawSources = await this.listGroup<
      Required<WikiSourceRef> & { format: 1 }
    >("wiki:sources", signal);
    const sources = rawSources
      .map((s) => normalizeSourceRef(s))
      .sort((a, b) => a.source_id.localeCompare(b.source_id));

    const revisions = pages.map((p) =>
      buildRevisionRecord({
        page_id: p.page_id,
        revision: p.revision,
        title: p.title,
        folder: p.folder,
        tldr: p.tldr,
        status_as_of: p.status_as_of,
        body: p.body,
        claims: p.claims,
        links: p.links,
        source_ids: p.source_ids,
        updated_at: p.updated_at,
      }),
    );
    const graph = BacklinkGraph.fromPages(revisions);
    const storageInfo = await this.store.storage(signal);
    const bundle = {
      schema: "hussh.personal_wiki.export.v1" as const,
      owner: this.access.owner,
      library_id: String(storageInfo.libraryId ?? ""),
      pages,
      sources,
      backlinks: graph.toStored().outbound,
    };
    const export_sha256 = await sha256Hex(canonicalJson(bundle));
    return { ...bundle, export_sha256 };
  }
}
