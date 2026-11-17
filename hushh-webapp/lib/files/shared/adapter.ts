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
  constructor(access: SharedFilesAccess, wiki?: SharedWikiLibrary) {
    this.wiki = wiki ?? new SharedWikiLibrary(access);
    this.library = new SharedFilesLibrary(access, this.wiki.store);
    this.foreground = new SharedFilesForeground(this.library);
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
        const staleReceipts = [];
        for (const rec of receipts) {
          if (rec.state === "stale") {
            staleReceipts.push({
              receiptId: rec.receipt_id,
              pageId: rec.page_id,
              pageRevision: rec.page_revision,
              claimId: rec.claim_id,
              sourceRevision: rec.source_revision,
              domain: rec.domain,
              jsonPath: rec.json_path,
              state: rec.state,
            });
            continue;
          }
          if (rec.state !== "private_candidate" && rec.state !== "conflicted") {
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
            pageRevision: rec.page_revision,
            claimId: rec.claim_id,
            sourceRevision: rec.source_revision,
            domain: rec.domain,
            jsonPath: rec.json_path,
            statement,
            state: rec.state,
          });
        }
        result = {
          captureOptIn: cp.capture_opt_in,
          migrationState: mig.state,
          migrationRevision: mig.migration_revision,
          dualReadQualified: Boolean(mig.dual_read_qualified),
          coldRecoveryQualified: Boolean(mig.cold_recovery_qualified),
          compiledClaimCount: Number(
            (mig as { compiled_claim_count?: number }).compiled_claim_count ?? 0,
          ),
          classicWriterRetired: mig.state === "wiki_primary",
          pages: pages.map((p) => ({
            pageId: p.page_id,
            title: p.title,
            folder: p.folder,
            tldr: (p as { tldr?: string }).tldr ?? "",
            revision: p.revision,
            updatedAt: p.updated_at,
          })),
          candidateReceipts: candidates,
          staleReceipts,
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
          const staled = await new SharedWikiProjectionEngine(
            this.wiki,
          ).syncPageLifecycle(updated.page_id, undefined, signal);
          await this.wiki.rebuildIndexes(signal);
          await new SharedWikiKnowledgeWriter(this.wiki).refreshHotDigest(signal);
          result = {
            pageId: updated.page_id,
            revision: updated.revision,
            staledReceipts: staled.map((r) => ({
              receiptId: r.receipt_id,
              domain: r.domain,
              jsonPath: r.json_path,
              pageId: r.page_id,
              pageRevision: r.page_revision,
              claimId: r.claim_id,
              sourceRevision: r.source_revision,
            })),
          };
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
        let statement = "";
        try {
          const pdoc = await this.wiki.readPage(saved.page_id, undefined, signal);
          statement =
            pdoc.claims.find((c) => c.claim_id === saved.claim_id)?.statement ?? "";
        } catch {
          statement = "";
        }
        result = {
          receiptId: saved.receipt_id,
          state: saved.state,
          domain: saved.domain,
          jsonPath: saved.json_path,
          pageId: saved.page_id,
          pageRevision: saved.page_revision,
          claimId: saved.claim_id,
          sourceRevision: saved.source_revision,
          statement,
        };
        break;
      }
      case "/wiki/projection/derive": {
        const engine = new SharedWikiProjectionEngine(this.wiki);
        let derived = await engine.deriveProjection(
          {
            pageId: String(body.page_id ?? ""),
            claimId: String(body.claim_id ?? ""),
            targetDomain: String(body.target_domain ?? ""),
            jsonPath: String(body.json_path ?? ""),
            idempotencyKey: String(body.request_id ?? ""),
            activeRecipientCount: Number(body.active_recipient_count ?? 0),
            ownerConfirmed: Boolean(body.owner_confirmed),
            requireOwnerConfirmation: Boolean(body.require_owner_confirmation),
          },
          signal,
        );
        if (
          typeof body.conflict_authority === "string" &&
          body.conflict_authority &&
          typeof body.conflict_reason === "string" &&
          body.conflict_reason &&
          typeof body.conflict_path === "string" &&
          body.conflict_path
        ) {
          derived = await this.wiki.putProjectionReceipt(
            {
              ...derived,
              source_revision: derived.source_revision + 1,
              state: "conflicted",
              exposure_eligibility: false,
              specialist_disagreement: {
                authority: body.conflict_authority,
                reason: body.conflict_reason,
                path: body.conflict_path,
              },
            },
            `${String(body.request_id ?? "")}:conflict`.slice(0, 128),
            signal,
          );
        }
        result = {
          receiptId: derived.receipt_id,
          state: derived.state,
          domain: derived.domain,
          jsonPath: derived.json_path,
          pageId: derived.page_id,
          pageRevision: derived.page_revision,
          claimId: derived.claim_id,
          sourceRevision: derived.source_revision,
        };
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
          staledReceipts: (res.staled_projection_receipts ?? []).map((r) => ({
            receiptId: r.receipt_id,
            domain: r.domain,
            jsonPath: r.json_path,
            pageId: r.page_id,
            pageRevision: r.page_revision,
            claimId: r.claim_id,
            sourceRevision: r.source_revision,
          })),
        };
        break;
      }
      case "/wiki/migrate": {
        const { SharedWikiMaintenanceRunner } = await import(
          "../wiki/migration-and-maintenance"
        );
        const migrator = new SharedWikiOwnerMigrator(this.wiki);
        const action = String(body.action ?? "");
        const requestId = String(body.request_id ?? crypto.randomUUID());
        const expectedMigrationRevision =
          typeof body.expected_migration_revision === "number"
            ? body.expected_migration_revision
            : undefined;

        if (action === "maintenance_tick") {
          const tick = await new SharedWikiMaintenanceRunner(this.wiki).runTick({
            idempotencyKey: requestId,
            signal,
          });
          const mig = await migrator.getMigrationStatus(signal);
          result = {
            action,
            migrationState: mig.state,
            migrationRevision: mig.migration_revision,
            dualReadQualified: Boolean(mig.dual_read_qualified),
            coldRecoveryQualified: Boolean(mig.cold_recovery_qualified),
            classicWriterRetired: mig.state === "wiki_primary",
            maintenance: tick,
          };
          break;
        }

        if (action === "compile_and_verify") {
          const v1Markdown = String(body.v1_markdown ?? "");
          const compiled = await migrator.compileLegacySources({
            v1Markdown,
            idempotencyKey: requestId,
            expectedMigrationRevision,
            signal,
          });
          await new SharedWikiMaintenanceRunner(this.wiki).runTick({
            idempotencyKey: `${requestId}:maint`.slice(0, 120),
            signal,
          });
          const parity = await migrator.verifyDualReadParity({
            v1Markdown,
            signal,
          });
          const chatKeyVerified = Boolean(body.chat_key_verified);
          const cold = await migrator.verifyColdReconstruction({
            chatSessionVerifier: async () => chatKeyVerified,
            signal,
          });
          const mig = await migrator.getMigrationStatus(signal);
          result = {
            action,
            migrationState: mig.state,
            migrationRevision: mig.migration_revision,
            dualReadQualified: Boolean(parity.qualified),
            coldRecoveryQualified: Boolean(cold.qualified),
            compiledClaimCount: compiled.compiled_claim_count,
            skippedTombstoned: compiled.skipped_tombstoned_count,
            classicWriterRetired: mig.state === "wiki_primary",
            parity,
            coldRecovery: cold,
          };
          break;
        }

        const currentMig = await migrator.getMigrationStatus(signal);
        const targetState =
          action === "cutover_rollback_safe"
            ? ("wiki_primary_with_v1_rollback" as const)
            : ("wiki_primary" as const);
        const advanced = await migrator.advanceMigrationState({
          targetState,
          expectedMigrationRevision:
            expectedMigrationRevision ?? currentMig.migration_revision,
          signal,
        });
        const migAfter = await migrator.getMigrationStatus(signal);
        result = {
          action,
          migrationState: advanced.state,
          migrationRevision: advanced.migration_revision,
          dualReadQualified: Boolean(migAfter.dual_read_qualified),
          coldRecoveryQualified: Boolean(migAfter.cold_recovery_qualified),
          classicWriterRetired: advanced.state === "wiki_primary",
        };
        break;
      }
      case "/wiki/rollback": {
        const res = await new SharedWikiOwnerMigrator(
          this.wiki,
        ).rollbackToV1Markdown({
          priorV1Markdown:
            typeof body.prior_v1_markdown === "string"
              ? body.prior_v1_markdown
              : "",
          expectedMigrationRevision:
            typeof body.expected_migration_revision === "number"
              ? body.expected_migration_revision
              : undefined,
          allowPostGraduation: Boolean(body.allow_post_graduation),
          signal,
        });
        result = {
          migrationState: res.state,
          migrationRevision: res.migration_revision,
          v1Markdown: res.v1_markdown,
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
        const explicitCandidateMappings = Array.isArray(
          body.explicit_candidate_mappings,
        )
          ? body.explicit_candidate_mappings.filter(
              (
                m: unknown,
              ): m is {
                statement: string;
                target_domain: string;
                json_path: string;
              } =>
                Boolean(
                  m &&
                    typeof m === "object" &&
                    typeof (m as Record<string, unknown>).statement === "string" &&
                    typeof (m as Record<string, unknown>).target_domain ===
                      "string" &&
                    typeof (m as Record<string, unknown>).json_path === "string",
                ),
            )
          : undefined;
        const res = await new SharedWikiArchiveImporter(
          this.wiki,
        ).importArchiveBytes(
          {
            fileId: targetId,
            fileName: entry.name,
            rawBytes: combined.subarray(0, writeOffset),
            idempotencyKey: String(body.request_id ?? ""),
            sourceProvider,
            ...(explicitCandidateMappings
              ? { explicitCandidateMappings }
              : {}),
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
