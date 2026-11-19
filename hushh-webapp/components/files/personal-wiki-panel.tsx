"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { SettingsGroup, SettingsRow } from "@/components/app-ui/settings-ui";
import {
  FilesMarkdownDocumentSheet,
  type FilesMarkdownDocumentTarget,
} from "@/components/files/files-markdown-document-sheet";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { FileText } from "@/components/icons";
import { peekFilesWikiOverviewCache } from "@/lib/files/files-cache";
import {
  FilesService,
  type FileEntry,
  type WikiOverview,
} from "@/lib/files/service";
import {
  CORE_AGENT_MARKDOWN_IDS,
  CORE_AGENT_MARKDOWN_META,
  isCoreAgentMarkdownId,
  loadCoreAgentMarkdownFile,
  peekCoreAgentMarkdownFile,
  saveCoreAgentMarkdownFile,
  type CoreAgentMarkdownId,
} from "@/lib/pkm/agent-core-markdown-files";
import { isVaultSessionEpochCurrent, snapshotVaultSessionEpoch } from "@/lib/vault/session-epoch";
import { useVault } from "@/lib/vault/vault-context";
import type { FilesAction } from "./files-settings-panel";

export function PersonalWikiPanel({
  ownerId,
  signal,
  busy,
  unavailable,
  act,
  initialDocId,
  initialPageId,
  onInitialSelectionConsumed,
}: {
  ownerId: string | undefined;
  signal: AbortSignal;
  busy: boolean;
  unavailable: boolean;
  act: FilesAction;
  initialDocId?: string | null;
  initialPageId?: string | null;
  onInitialSelectionConsumed?: () => void;
}) {
  const { vaultKey, vaultOwnerToken } = useVault();
  const [overview, setOverview] = useState<WikiOverview | null>(() =>
    ownerId ? peekFilesWikiOverviewCache(ownerId) : null,
  );
  const [savedArchives, setSavedArchives] = useState<FileEntry[]>([]);
  const [docTarget, setDocTarget] = useState<FilesMarkdownDocumentTarget | null>(null);
  const [loading, setLoading] = useState(() => !(ownerId && peekFilesWikiOverviewCache(ownerId)));
  const [loadError, setLoadError] = useState("");
  const [confirmRollback, setConfirmRollback] = useState(false);
  const localAbort = useRef<AbortController | null>(null);
  const importInputRef = useRef<HTMLInputElement | null>(null);
  const initialHandledRef = useRef<string | null>(null);
  const lastOwnerRef = useRef<string | undefined>(ownerId);

  useEffect(() => {
    if (!ownerId || !vaultKey || !vaultOwnerToken) {
      setDocTarget(null);
    }
  }, [ownerId, vaultKey, vaultOwnerToken]);

  const loadOverview = useCallback(
    async (activeSignal: AbortSignal) => {
      const [next, rootList] = await Promise.all([
        FilesService.wikiOverview(activeSignal),
        FilesService.list("root", "", false, activeSignal).catch(() => ({
          entries: [] as FileEntry[],
          cursor: "",
          chunkBytes: 4 * 1024 * 1024,
        })),
      ]);
      activeSignal.throwIfAborted();
      setOverview(next);
      setSavedArchives(
        rootList.entries
          .filter(
            (entry) =>
              entry.kind === "file" &&
              entry.state === "ready" &&
              /\.(zip|json)$/i.test(entry.name),
          )
          .slice(0, 5),
      );
      setLoadError("");
      return next;
    },
    [],
  );

  useEffect(() => {
    localAbort.current?.abort();
    const controller = new AbortController();
    localAbort.current = controller;
    const onParentAbort = () => controller.abort();
    signal.addEventListener("abort", onParentAbort, { once: true });

    if (lastOwnerRef.current !== ownerId) {
      lastOwnerRef.current = ownerId;
      setDocTarget(null);
      initialHandledRef.current = null;
    } else if (unavailable) {
      setDocTarget((prev) => (prev?.kind === "core" ? prev : null));
    }
    setConfirmRollback(false);
    if (!ownerId || unavailable) {
      setOverview(null);
      setLoading(false);
      return () => {
        signal.removeEventListener("abort", onParentAbort);
        controller.abort();
      };
    }

    const warmOverview = peekFilesWikiOverviewCache(ownerId);
    if (warmOverview) {
      setOverview(warmOverview);
      setLoading(false);
    } else {
      setLoading(true);
    }
    setLoadError("");
    void loadOverview(controller.signal)
      .catch(() => {
        if (!controller.signal.aborted && !warmOverview) {
          setLoadError("Could not open your personal wiki right now.");
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });

    return () => {
      signal.removeEventListener("abort", onParentAbort);
      controller.abort();
    };
  }, [ownerId, unavailable, signal, loadOverview]);

  const disabled = busy || unavailable || loading;

  const openCoreDoc = useCallback(
    async (docId: CoreAgentMarkdownId) => {
      if (!ownerId || !vaultKey || !vaultOwnerToken) return;
      const meta = CORE_AGENT_MARKDOWN_META[docId];
      const warm = peekCoreAgentMarkdownFile(ownerId, docId);
      if (warm) {
        setDocTarget({
          kind: "core",
          docId,
          title: meta.title,
          subtitle: meta.subtitle,
          markdown: warm.markdown,
          storedMarkdown: warm.storedMarkdown,
          persisted: warm.persisted,
          isDefaultTemplate: warm.isDefaultTemplate,
          updatedAt: warm.updatedAt,
        });
      }
      const loaded = await loadCoreAgentMarkdownFile({
        userId: ownerId,
        vaultKey,
        vaultOwnerToken,
        docId,
      });
      setDocTarget({
        kind: "core",
        docId,
        title: meta.title,
        subtitle: meta.subtitle,
        markdown: loaded.markdown,
        storedMarkdown: loaded.storedMarkdown,
        persisted: loaded.persisted,
        isDefaultTemplate: loaded.isDefaultTemplate,
        updatedAt: loaded.updatedAt,
      });
    },
    [ownerId, vaultKey, vaultOwnerToken],
  );

  const openPage = useCallback(
    (pageId: string) => {
      const activeSignal = localAbort.current?.signal ?? signal;
      void act(
        async () => {
          const detail = await FilesService.wikiPage(pageId, activeSignal);
          activeSignal.throwIfAborted();
          setDocTarget({ kind: "wiki", page: detail });
        },
        "Note opened",
        false,
      );
    },
    [act, signal],
  );

  useEffect(() => {
    if (!ownerId) return;
    if (isCoreAgentMarkdownId(initialDocId)) {
      if (!vaultKey || !vaultOwnerToken) return;
      const coreKey = `core:${ownerId}:${initialDocId}`;
      if (initialHandledRef.current === coreKey) return;
      initialHandledRef.current = coreKey;
      void openCoreDoc(initialDocId).finally(() => {
        onInitialSelectionConsumed?.();
      });
      return;
    }
    if (unavailable || !initialPageId) return;
    const pageKey = `page:${ownerId}:${initialPageId}`;
    if (initialHandledRef.current === pageKey) return;
    initialHandledRef.current = pageKey;
    openPage(initialPageId);
    onInitialSelectionConsumed?.();
  }, [
    ownerId,
    unavailable,
    vaultKey,
    vaultOwnerToken,
    initialDocId,
    initialPageId,
    openCoreDoc,
    openPage,
    onInitialSelectionConsumed,
  ]);

  return (
    <div className="space-y-4">
      <SettingsGroup title="Core agent files" embedded headingClassName="mt-0">
        {CORE_AGENT_MARKDOWN_IDS.map((docId) => {
          const meta = CORE_AGENT_MARKDOWN_META[docId];
          const warm = ownerId ? peekCoreAgentMarkdownFile(ownerId, docId) : null;
          return (
            <SettingsRow
              key={docId}
              title={meta.title}
              description={warm?.updatedAt ? `${meta.subtitle} · Saved` : meta.subtitle}
              leading={<FileText className="size-4 text-muted-foreground" aria-hidden="true" />}
              chevron
              disabled={busy || !vaultKey || !vaultOwnerToken}
              testId={`wiki-core-doc-${docId}`}
              onClick={() => void openCoreDoc(docId)}
            />
          );
        })}
      </SettingsGroup>

      {unavailable ? (
        <p role="status" className="text-sm text-muted-foreground">
          Checking your Personal wiki connection…
        </p>
      ) : loading ? (
        <p role="status" className="text-sm text-muted-foreground">
          Opening personal wiki…
        </p>
      ) : loadError ? (
        <div className="space-y-3">
          <p role="alert" className="text-sm text-muted-foreground">
            {loadError}
          </p>
          <Button
            variant="outline"
            disabled={busy || unavailable}
            onClick={() => {
              const activeSignal = localAbort.current?.signal ?? signal;
              void act(
                () => loadOverview(activeSignal),
                "Personal wiki refreshed",
                false,
              );
            }}
          >
            Try again
          </Button>
        </div>
      ) : (
        <>
          <SettingsGroup title="Preferences" embedded>
        <SettingsRow
          title="Remember from conversations"
          description="Saves durable notes to your private wiki. Never shares with anyone or connects external accounts."
          trailing={
            <Switch
              size="ios"
              aria-label="Remember from conversations"
              checked={Boolean(overview?.captureOptIn)}
              disabled={disabled || !overview}
              onCheckedChange={(enabled) => {
                const activeSignal = localAbort.current?.signal ?? signal;
                void act(
                  async () => {
                    await FilesService.wikiSetOptIn(enabled, activeSignal);
                    await loadOverview(activeSignal);
                  },
                  enabled ? "Conversation memory on" : "Conversation memory off",
                  false,
                );
              }}
            />
          }
        />
      </SettingsGroup>

      <SettingsGroup title="Import history" embedded>
        <input
          ref={importInputRef}
          type="file"
          accept=".zip,.json,application/zip,application/json"
          aria-label="Choose ChatGPT or Claude export file"
          className="hidden"
          disabled={disabled}
          onChange={(event) => {
            const chosen = event.target.files?.[0];
            event.target.value = "";
            if (!chosen || disabled) return;
            const activeSignal = localAbort.current?.signal ?? signal;
            void act(
              async () => {
                const uploaded = await FilesService.upload(
                  chosen,
                  "root",
                  () => undefined,
                  activeSignal,
                );
                await FilesService.wikiImportArchive(
                  { fileId: uploaded.id, sourceProvider: "auto" },
                  activeSignal,
                );
                await loadOverview(activeSignal);
              },
              "History imported into wiki",
              false,
            );
          }}
        />
        <SettingsRow
          title="Import ChatGPT or Claude history"
          description="Saves your .zip or .json export into encrypted Files and compiles notes into your private wiki. Updates wait for your confirmation."
          trailing={
            <Button
              type="button"
              variant="outline"
              size="compact"
              disabled={disabled}
              onClick={() => importInputRef.current?.click()}
            >
              Import archive
            </Button>
          }
        />
        {savedArchives.map((archive) => (
          <SettingsRow
            key={archive.id}
            title={archive.name}
            description="Saved in Files — compile into your private wiki"
            trailing={
              <Button
                type="button"
                variant="ghost"
                size="compact"
                aria-label={`Add ${archive.name} to wiki`}
                disabled={disabled}
                onClick={() => {
                  const activeSignal = localAbort.current?.signal ?? signal;
                  void act(
                    async () => {
                      await FilesService.wikiImportArchive(
                        { fileId: archive.id, sourceProvider: "auto" },
                        activeSignal,
                      );
                      await loadOverview(activeSignal);
                    },
                    "Archive added to wiki",
                    false,
                  );
                }}
              >
                Add to wiki
              </Button>
            }
          />
        ))}
      </SettingsGroup>

      {overview && overview.candidateReceipts.length > 0 ? (
        <SettingsGroup title="Review updates" embedded>
          {overview.candidateReceipts.map((item) => (
            <SettingsRow
              key={item.receiptId}
              title={item.statement || `Pending update in ${item.domain}`}
              description={
                item.state === "private_candidate"
                  ? (item.activeRecipientCount ?? 0) > 0
                    ? `Confirm before adding to ${item.domain} (shared with ${item.activeRecipientCount} active ${item.activeRecipientCount === 1 ? "recipient" : "recipients"})`
                    : `Confirm before adding to ${item.domain}`
                  : `Differs from verified ${item.domain} details`
              }
              trailing={
                item.state === "private_candidate" ? (
                  <Button
                    type="button"
                    variant="outline"
                    size="compact"
                    disabled={disabled}
                    onClick={() => {
                      const activeSignal = localAbort.current?.signal ?? signal;
                      void act(
                        async () => {
                          await FilesService.wikiConfirmCandidate(
                            item.receiptId,
                            activeSignal,
                          );
                          await loadOverview(activeSignal);
                        },
                        "Update confirmed",
                        false,
                      );
                    }}
                  >
                    Confirm
                  </Button>
                ) : (
                  <span className="text-xs text-muted-foreground">
                    Needs review
                  </span>
                )
              }
            />
          ))}
        </SettingsGroup>
      ) : null}

      <SettingsGroup title="Notes" embedded>
        {!overview || overview.pages.length === 0 ? (
          <p className="py-2 text-sm text-muted-foreground">
            No saved notes yet.
          </p>
        ) : (
          overview.pages.map((page) => (
            <SettingsRow
              key={page.pageId}
              title={page.title}
              description={page.tldr || "Open to view or edit"}
              trailing={
                <Button
                  type="button"
                  variant="ghost"
                  size="compact"
                  aria-label={`Open ${page.title}`}
                  disabled={disabled}
                  onClick={() => openPage(page.pageId)}
                >
                  Open
                </Button>
              }
            />
          ))
        )}
      </SettingsGroup>

      {overview ? (
        <details className="text-sm">
          <summary className="min-h-11 cursor-pointer py-2 font-medium">
            Migration and recovery
          </summary>
          <div className="space-y-2 pb-1 text-muted-foreground">
            {overview.migrationState === "v1_markdown_only" ? (
              <>
                <p>
                  Compile your existing classic notes into cited wiki pages and
                  verify parity before switching over.
                </p>
                <Button
                  type="button"
                  variant="outline"
                  size="compact"
                  disabled={disabled}
                  onClick={() => {
                    const activeSignal = localAbort.current?.signal ?? signal;
                    void act(
                      async () => {
                        await FilesService.wikiMigrateCohort(
                          {
                            action: "compile_and_verify",
                            expectedMigrationRevision: overview.migrationRevision,
                          },
                          activeSignal,
                        );
                        await loadOverview(activeSignal);
                      },
                      "Classic notes verified in wiki",
                      false,
                    );
                  }}
                >
                  Verify classic notes
                </Button>
              </>
            ) : null}

            {overview.migrationState === "dual_read_shadow_compile" ? (
              <>
                <p>
                  {overview.dualReadQualified
                    ? "Parity verified. Switch chat recall to your personal wiki while keeping classic rollback available."
                    : "Re-run verification to qualify parity before switching chat recall to your personal wiki."}
                </p>
                <div className="flex flex-wrap gap-2">
                  {overview.dualReadQualified ? (
                    <Button
                      type="button"
                      variant="outline"
                      size="compact"
                      disabled={disabled}
                      onClick={() => {
                        const activeSignal =
                          localAbort.current?.signal ?? signal;
                        void act(
                          async () => {
                            await FilesService.wikiMigrateCohort(
                              {
                                action: "cutover_rollback_safe",
                                expectedMigrationRevision:
                                  overview.migrationRevision,
                              },
                              activeSignal,
                            );
                            await loadOverview(activeSignal);
                          },
                          "Switched recall to personal wiki",
                          false,
                        );
                      }}
                    >
                      Use wiki as primary
                    </Button>
                  ) : (
                    <Button
                      type="button"
                      variant="outline"
                      size="compact"
                      disabled={disabled}
                      onClick={() => {
                        const activeSignal =
                          localAbort.current?.signal ?? signal;
                        void act(
                          async () => {
                            await FilesService.wikiMigrateCohort(
                              {
                                action: "compile_and_verify",
                                expectedMigrationRevision:
                                  overview.migrationRevision,
                              },
                              activeSignal,
                            );
                            await loadOverview(activeSignal);
                          },
                          "Classic notes verified in wiki",
                          false,
                        );
                      }}
                    >
                      Re-verify classic notes
                    </Button>
                  )}
                  <Button
                    type="button"
                    variant="ghost"
                    size="compact"
                    disabled={disabled}
                    onClick={() => setConfirmRollback(true)}
                  >
                    Switch back to classic notes
                  </Button>
                </div>
              </>
            ) : null}

            {overview.migrationState === "wiki_primary_with_v1_rollback" ? (
              <>
                <p>
                  Personal wiki is active with classic single-note rollback
                  available. Forgotten facts stay removed.
                </p>
                <div className="flex flex-wrap gap-2">
                  {overview.coldRecoveryQualified ? (
                    <Button
                      type="button"
                      variant="outline"
                      size="compact"
                      disabled={disabled}
                      onClick={() => {
                        const activeSignal =
                          localAbort.current?.signal ?? signal;
                        void act(
                          async () => {
                            await FilesService.wikiMigrateCohort(
                              {
                                action: "graduate_wiki_primary",
                                expectedMigrationRevision:
                                  overview.migrationRevision,
                              },
                              activeSignal,
                            );
                            await loadOverview(activeSignal);
                          },
                          "Classic note writer retired",
                          false,
                        );
                      }}
                    >
                      Retire classic writer
                    </Button>
                  ) : null}
                  <Button
                    type="button"
                    variant="outline"
                    size="compact"
                    disabled={disabled}
                    onClick={() => setConfirmRollback(true)}
                  >
                    Switch back to classic notes
                  </Button>
                </div>
              </>
            ) : null}

            {overview.migrationState === "wiki_primary" ? (
              <p>
                Personal wiki is your active memory store and classic
                single-note writes are retired.
              </p>
            ) : null}
          </div>
        </details>
      ) : null}
        </>
      )}

      <FilesMarkdownDocumentSheet
        open={docTarget !== null}
        target={docTarget}
        busy={docTarget?.kind === "core" ? busy : disabled}
        initialMode="preview"
        onClose={() => setDocTarget(null)}
        onSaveCore={async ({
          docId,
          markdown,
          expectedStoredMarkdown,
          expectedPersisted,
        }) => {
          if (!ownerId || !vaultKey || !vaultOwnerToken) return false;
          const epoch = snapshotVaultSessionEpoch();
          let savedOk = false;
          await act(
            async () => {
              const saved = await saveCoreAgentMarkdownFile({
                userId: ownerId,
                vaultKey,
                vaultOwnerToken,
                docId,
                markdown,
                expectedStoredMarkdown,
                expectedPersisted,
                beforeEffect: async () => {
                  if (!isVaultSessionEpochCurrent(epoch)) {
                    throw new DOMException("Vault locked before save", "AbortError");
                  }
                },
              });
              if (!saved.success || !saved.document) {
                throw new Error(saved.message ?? `Could not save ${docId}.`);
              }
              const meta = CORE_AGENT_MARKDOWN_META[docId];
              setDocTarget({
                kind: "core",
                docId,
                title: meta.title,
                subtitle: meta.subtitle,
                markdown: saved.document.markdown,
                storedMarkdown: saved.document.storedMarkdown,
                persisted: saved.document.persisted,
                isDefaultTemplate: saved.document.isDefaultTemplate,
                updatedAt: saved.document.updatedAt,
              });
              savedOk = true;
            },
            `${docId} saved`,
            false,
          );
          return savedOk;
        }}
        onSaveWiki={async ({ pageId, expectedRevision, title, tldr, body }) => {
          const activeSignal = localAbort.current?.signal ?? signal;
          let savedOk = false;
          await act(
            async () => {
              await FilesService.wikiSavePage(
                { pageId, expectedRevision, title, tldr, body },
                activeSignal,
              );
              const refreshed = await FilesService.wikiPage(pageId, activeSignal);
              await loadOverview(activeSignal);
              activeSignal.throwIfAborted();
              setDocTarget({ kind: "wiki", page: refreshed });
              savedOk = true;
            },
            "Note saved",
            false,
          );
          return savedOk;
        }}
        onForgetWikiClaim={async ({ pageId, claimId }) => {
          const activeSignal = localAbort.current?.signal ?? signal;
          await act(
            async () => {
              await FilesService.wikiForgetClaim({ pageId, claimId }, activeSignal);
              const refreshed = await FilesService.wikiPage(pageId, activeSignal);
              await loadOverview(activeSignal);
              activeSignal.throwIfAborted();
              setDocTarget({ kind: "wiki", page: refreshed });
            },
            "Fact forgotten",
            false,
          );
        }}
      />

      <AlertDialog
        open={confirmRollback}
        onOpenChange={(open) => {
          if (!open && !busy) setConfirmRollback(false);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Switch back to classic notes?</AlertDialogTitle>
            <AlertDialogDescription>
              Restores classic single-note memory while keeping forgotten facts
              removed.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy}>Stay on wiki</AlertDialogCancel>
            <AlertDialogAction
              disabled={busy}
              onClick={() => {
                const activeSignal = localAbort.current?.signal ?? signal;
                setConfirmRollback(false);
                void act(
                  async () => {
                    await FilesService.wikiRollbackClassic(activeSignal);
                    await loadOverview(activeSignal);
                  },
                  "Switched back to classic notes",
                  false,
                );
              }}
            >
              Switch back
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
