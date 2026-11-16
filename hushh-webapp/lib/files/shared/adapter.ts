import type { FilesSettings } from "../service";
import { SharedFilesLibrary, publicEntry } from "./library";
import { SharedFilesForeground } from "./foreground";
import type { SharedFilesAccess } from "./store";
import {
  MAX_ARCHIVE_COMPRESSED_BYTES,
  SharedWikiArchiveImporter,
  SharedWikiKnowledgeWriter,
  SharedWikiLibrary,
  SharedWikiOwnerMigrator,
  SharedWikiProjectionEngine,
  type ArchiveSourceProvider,
} from "../wiki";

const SOURCE_KIND_LABELS: Record<string, string> = {
  chat_turn: "Conversation",
  file_object: "Uploaded file",
  pkm_record: "Saved profile",
  live_activity: "Live session",
  owner_direct: "Direct note",
};

/** Mirrors Files' existing browser service, keeping crypto on the unlocked client. */
export class SharedFilesAdapter {
  private readonly library: SharedFilesLibrary;
  private readonly foreground: SharedFilesForeground;
  private readonly wiki: SharedWikiLibrary;
  constructor(access: SharedFilesAccess) {
    this.library = new SharedFilesLibrary(access);
    this.foreground = new SharedFilesForeground(this.library);
    this.wiki = new SharedWikiLibrary(access);
  }
  async request(path: string, init: RequestInit = {}): Promise<Response> {
    this.library.store.check();
    const url = new URL(path, "https://files.invalid/");
    const method = init.method ?? "GET";
    const signal = init.signal ?? undefined;
    const fileId = url.searchParams.get("file_id") ?? "";
    const cursor = url.searchParams.get("cursor") ?? "";
    const body = typeof init.body === "string" ? JSON.parse(init.body) : {};
    let result: unknown;
    switch (url.pathname) {
      case "/entry":
        result = publicEntry((await this.library.entry(fileId, signal)).entry);
        break;
      case "/list":
        result = await this.library.list(
          url.searchParams.get("parent") ?? "root",
          cursor,
          url.searchParams.get("trash") === "true",
          signal,
        );
        break;
      case "/settings":
        result =
          method === "PUT"
            ? await this.library.configure(body as FilesSettings, signal)
            : await this.library.settings(signal);
        break;
      case "/create":
        result = await this.library.create(body, signal);
        break;
      case "/mutate":
        result = await this.library.mutate(body, signal);
        break;
      case "/complete":
        result = await this.library.complete(body.file_id, signal);
        break;
      case "/chunk": {
        if (!url.searchParams.has("index"))
          throw new Error("FILES_CHUNK_INVALID");
        const data =
          method === "PUT"
            ? new Uint8Array(await new Response(init.body).arrayBuffer())
            : undefined;
        result = await this.library.chunk(
          fileId,
          Number(url.searchParams.get("index")),
          data,
          signal,
        );
        if (result instanceof Uint8Array) {
          this.library.store.check();
          return new Response(new Uint8Array(result).buffer);
        }
        break;
      }
      case "/usage": {
        const page = await this.library.store.page("entries", cursor, signal);
        const files = page.values as Array<{ kind: string; received: number }>;
        result = {
          bytes: files.reduce(
            (total, entry) =>
              total + (entry.kind === "file" ? entry.received : 0),
            0,
          ),
          files: files.filter((entry) => entry.kind === "file").length,
          cursor: page.cursor,
        };
        break;
      }
      case "/jobs": {
        if (method === "POST")
          result = await this.foreground.run(
            body.file_id,
            body.cancel === true,
            signal,
          );
        else if (fileId) result = await this.foreground.job(fileId, signal);
        else {
          const page = await this.library.store.page("jobs", cursor, signal);
          result = { entries: page.values, cursor: page.cursor };
        }
        break;
      }
      case "/wiki/overview": {
        const migrator = new SharedWikiOwnerMigrator(this.wiki);
        const cp = await this.wiki.readCaptureCheckpoint(signal);
        const mig = await migrator.getMigrationStatus(signal);
        const pages = await this.wiki.listPages(undefined, signal);
        const receipts = await this.wiki.listProjectionReceipts(undefined, signal);
        const candidates = [];
        for (const rec of receipts) {
          if (
            rec.state !== "private_candidate" &&
            rec.state !== "conflicted" &&
            rec.state !== "stale"
          ) {
            continue;
          }
          let statement = "";
          try {
            const pdoc = await this.wiki.readPage(rec.page_id, undefined, signal);
            statement =
              pdoc.claims.find((c) => c.claim_id === rec.claim_id)?.statement ?? "";
          } catch {
            statement = "";
          }
          candidates.push({
            receiptId: rec.receipt_id,
            pageId: rec.page_id,
            claimId: rec.claim_id,
            domain: rec.domain,
            statement,
            state: rec.state,
          });
        }
        result = {
          captureOptIn: cp.capture_opt_in,
          migrationState: mig.state,
          migrationRevision: mig.migration_revision,
          pages: pages.map((p) => ({
            pageId: p.page_id,
            title: p.title,
            folder: p.folder,
            tldr: (p as { tldr?: string }).tldr ?? "",
            revision: p.revision,
            updatedAt: p.updated_at,
          })),
          candidateReceipts: candidates,
        };
        break;
      }
      case "/wiki/page": {
        if (method === "POST") {
          const updated = await this.wiki.editPage(
            String(body.page_id ?? ""),
            {
              expected_revision: Number(body.expected_revision ?? 1),
              idempotency_key: String(body.request_id ?? ""),
              title: String(body.title ?? ""),
              tldr: String(body.tldr ?? ""),
              body: String(body.body ?? ""),
            },
            signal,
          );
          await new SharedWikiProjectionEngine(this.wiki).syncPageLifecycle(
            updated.page_id,
            undefined,
            signal,
          );
          await this.wiki.rebuildIndexes(signal);
          await new SharedWikiKnowledgeWriter(this.wiki).refreshHotDigest(signal);
          result = { pageId: updated.page_id, revision: updated.revision };
        } else {
          const pageId = url.searchParams.get("page_id") ?? "";
          const page = await this.wiki.readPage(pageId, undefined, signal);
          const sourceLabels = new Map<string, string>();
          for (const sid of page.source_ids) {
            try {
              const src = await this.wiki.getSource(sid, signal);
              const label = SOURCE_KIND_LABELS[src.kind] ?? "Saved source";
              const obs = (src.observed_at ?? "").slice(0, 10);
              sourceLabels.set(sid, obs ? `${label} · ${obs}` : label);
            } catch {
              sourceLabels.set(sid, "Saved source");
            }
          }
          result = {
            pageId: page.page_id,
            title: page.title,
            folder: page.folder,
            tldr: page.tldr,
            body: page.body,
            revision: page.revision,
            statusAsOf: page.status_as_of,
            claims: page.claims.map((c) => ({
              claimId: c.claim_id,
              statement: c.statement,
              status: c.status ?? "active",
              observedAt: c.observed_at ?? "",
              origins: (c.source_ids ?? []).map(
                (sid) => sourceLabels.get(sid) ?? "Saved source",
              ),
            })),
          };
        }
        break;
      }
      case "/wiki/opt-in": {
        const saved = await new SharedWikiKnowledgeWriter(this.wiki).setCaptureOptIn(
          Boolean(body.enabled),
          signal,
        );
        result = { captureOptIn: saved.capture_opt_in };
        break;
      }
      case "/wiki/confirm": {
        const saved = await new SharedWikiProjectionEngine(
          this.wiki,
        ).confirmCandidateProjection(
          String(body.receipt_id ?? ""),
          { idempotencyKey: String(body.request_id ?? "") },
          signal,
        );
        result = { receiptId: saved.receipt_id, state: saved.state };
        break;
      }
      case "/wiki/forget": {
        const res = await new SharedWikiOwnerMigrator(
          this.wiki,
        ).propagateForgetAndCorrection({
          pageId: String(body.page_id ?? ""),
          claimId: String(body.claim_id ?? ""),
          idempotencyKey: String(body.request_id ?? ""),
          ...(typeof body.replacement_statement === "string"
            ? { replacementStatement: body.replacement_statement }
            : {}),
          destroyPageKey: true,
          signal,
        });
        result = {
          pageId: res.page_id,
          revision: res.revision,
          outcomes: res.outcomes,
        };
        break;
      }
      case "/wiki/rollback": {
        const res = await new SharedWikiOwnerMigrator(
          this.wiki,
        ).rollbackToV1Markdown({ signal });
        result = {
          migrationState: res.state,
          migrationRevision: res.migration_revision,
        };
        break;
      }
      case "/wiki/import": {
        const targetId = String(body.file_id ?? "");
        const { entry } = await this.library.entry(targetId, signal);
        if (entry.kind !== "file" || entry.state !== "ready") {
          throw new Error("FILES_NOT_READY");
        }
        if (entry.size <= 0) {
          throw new Error("WIKI_ARCHIVE_EMPTY");
        }
        if (entry.size > MAX_ARCHIVE_COMPRESSED_BYTES) {
          throw new Error("WIKI_ARCHIVE_TOO_LARGE");
        }
        const combined = new Uint8Array(entry.size);
        let writeOffset = 0;
        for (let idx = 0; idx < entry.chunks; idx++) {
          const part = await this.library.chunk(targetId, idx, undefined, signal);
          if (!ArrayBuffer.isView(part)) {
            throw new Error("FILES_CHUNK_INVALID");
          }
          const partBytes = new Uint8Array(
            part.buffer,
            part.byteOffset,
            part.byteLength,
          );
          if (writeOffset + partBytes.byteLength > entry.size) {
            throw new Error("WIKI_ARCHIVE_TOO_LARGE");
          }
          combined.set(partBytes, writeOffset);
          writeOffset += partBytes.byteLength;
        }
        const providerRaw = String(body.source_provider ?? "auto");
        const sourceProvider: ArchiveSourceProvider =
          providerRaw === "chatgpt" || providerRaw === "claude"
            ? providerRaw
            : "auto";
        const res = await new SharedWikiArchiveImporter(
          this.wiki,
        ).importArchiveBytes(
          {
            fileId: targetId,
            fileName: entry.name,
            rawBytes: combined.subarray(0, writeOffset),
            idempotencyKey: String(body.request_id ?? ""),
            sourceProvider,
          },
          signal,
        );
        result = {
          provider: res.provider,
          fileId: res.file_id,
          pagesUpdated: res.pages_updated,
          claimsImported: res.claims_imported,
          claimsDeduplicated: res.claims_deduplicated,
          claimsSkippedTombstoned: res.claims_skipped_tombstoned,
          candidateCount: res.candidate_receipt_ids.length,
        };
        break;
      }
      default:
        throw new Error("FILES_OPERATION_UNSUPPORTED");
    }
    this.library.store.check();
    signal?.throwIfAborted();
    return Response.json(result);
  }
}
