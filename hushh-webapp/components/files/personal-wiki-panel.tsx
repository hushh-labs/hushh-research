"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { SettingsGroup, SettingsRow } from "@/components/app-ui/settings-ui";
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
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import {
  FilesService,
  type FileEntry,
  type WikiOverview,
  type WikiPageDetail,
} from "@/lib/files/service";
import { useBackLayer } from "@/lib/navigation/back-layers";
import { ROUTES } from "@/lib/navigation/routes";
import type { FilesAction } from "./files-settings-panel";

export function PersonalWikiPanel({
  ownerId,
  signal,
  busy,
  unavailable,
  act,
}: {
  ownerId: string | undefined;
  signal: AbortSignal;
  busy: boolean;
  unavailable: boolean;
  act: FilesAction;
}) {
  const [overview, setOverview] = useState<WikiOverview | null>(null);
  const [savedArchives, setSavedArchives] = useState<FileEntry[]>([]);
  const [selectedPage, setSelectedPage] = useState<WikiPageDetail | null>(null);
  const [draftTitle, setDraftTitle] = useState("");
  const [draftSummary, setDraftSummary] = useState("");
  const [draftBody, setDraftBody] = useState("");
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [forgetTarget, setForgetTarget] = useState<{
    pageId: string;
    claimId: string;
    statement: string;
  } | null>(null);
  const [confirmRollback, setConfirmRollback] = useState(false);
  const localAbort = useRef<AbortController | null>(null);
  const importInputRef = useRef<HTMLInputElement | null>(null);

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

    setSelectedPage(null);
    setForgetTarget(null);
    setConfirmRollback(false);
    if (!ownerId || unavailable) {
      setOverview(null);
      setLoading(false);
      return () => {
        signal.removeEventListener("abort", onParentAbort);
        controller.abort();
      };
    }

    setLoading(true);
    setLoadError("");
    void loadOverview(controller.signal)
      .catch(() => {
        if (!controller.signal.aborted) {
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

  useBackLayer(
    ROUTES.ONE_FILES,
    selectedPage ? 3 : 0,
    () => {
      if (busy) return true;
      if (!selectedPage) return false;
      setSelectedPage(null);
      return true;
    },
  );

  const disabled = busy || unavailable || loading;

  const openPage = (pageId: string) => {
    const activeSignal = localAbort.current?.signal ?? signal;
    void act(
      async () => {
        const detail = await FilesService.wikiPage(pageId, activeSignal);
        activeSignal.throwIfAborted();
        setSelectedPage(detail);
        setDraftTitle(detail.title);
        setDraftSummary(detail.tldr);
        setDraftBody(detail.body);
      },
      "Note opened",
      false,
    );
  };

  if (loading) {
    return (
      <p role="status" className="text-sm text-muted-foreground">
        Opening personal wiki…
      </p>
    );
  }

  if (loadError) {
    return (
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
    );
  }

  if (selectedPage) {
    const activeClaims = selectedPage.claims.filter(
      (claim) => claim.status === "active",
    );
    return (
      <div className="space-y-4">
        <div className="flex items-center justify-between gap-2">
          <Button
            type="button"
            variant="ghost"
            size="compact"
            disabled={disabled}
            onClick={() => setSelectedPage(null)}
          >
            All notes
          </Button>
          <span className="text-xs text-muted-foreground">
            Updated {selectedPage.statusAsOf}
          </span>
        </div>

        <form
          className="space-y-3"
          onSubmit={(event) => {
            event.preventDefault();
            if (disabled || !draftTitle.trim()) return;
            const activeSignal = localAbort.current?.signal ?? signal;
            void act(
              async () => {
                await FilesService.wikiSavePage(
                  {
                    pageId: selectedPage.pageId,
                    expectedRevision: selectedPage.revision,
                    title: draftTitle.trim(),
                    tldr: draftSummary.trim(),
                    body: draftBody,
                  },
                  activeSignal,
                );
                const refreshed = await FilesService.wikiPage(
                  selectedPage.pageId,
                  activeSignal,
                );
                await loadOverview(activeSignal);
                activeSignal.throwIfAborted();
                setSelectedPage(refreshed);
                setDraftTitle(refreshed.title);
                setDraftSummary(refreshed.tldr);
                setDraftBody(refreshed.body);
              },
              "Note saved",
              false,
            );
          }}
        >
          <div className="space-y-1">
            <label htmlFor="wiki-note-title" className="text-xs font-medium">
              Title
            </label>
            <Input
              id="wiki-note-title"
              aria-label="Note title"
              value={draftTitle}
              disabled={disabled}
              onChange={(event) => setDraftTitle(event.target.value)}
            />
          </div>
          <div className="space-y-1">
            <label htmlFor="wiki-note-summary" className="text-xs font-medium">
              Summary
            </label>
            <Input
              id="wiki-note-summary"
              aria-label="Summary"
              value={draftSummary}
              disabled={disabled}
              onChange={(event) => setDraftSummary(event.target.value)}
            />
          </div>
          <div className="space-y-1">
            <label htmlFor="wiki-note-body" className="text-xs font-medium">
              Details
            </label>
            <Textarea
              id="wiki-note-body"
              aria-label="Details"
              rows={5}
              value={draftBody}
              disabled={disabled}
              onChange={(event) => setDraftBody(event.target.value)}
            />
          </div>
          <div className="flex justify-end">
            <Button type="submit" disabled={disabled || !draftTitle.trim()}>
              Save changes
            </Button>
          </div>
        </form>

        <SettingsGroup title="Saved facts" embedded>
          {activeClaims.length === 0 ? (
            <p className="py-2 text-sm text-muted-foreground">
              No active facts on this note.
            </p>
          ) : (
            activeClaims.map((claim) => (
              <SettingsRow
                key={claim.claimId}
                title={claim.statement}
                description={
                  claim.origins.length > 0
                    ? `From ${claim.origins.join(", ")}`
                    : `Recorded ${claim.observedAt}`
                }
                trailing={
                  <Button
                    type="button"
                    variant="ghost"
                    size="compact"
                    aria-label={`Forget ${claim.statement}`}
                    disabled={disabled}
                    onClick={() =>
                      setForgetTarget({
                        pageId: selectedPage.pageId,
                        claimId: claim.claimId,
                        statement: claim.statement,
                      })
                    }
                  >
                    Forget
                  </Button>
                }
              />
            ))
          )}
        </SettingsGroup>

        <AlertDialog
          open={forgetTarget !== null}
          onOpenChange={(open) => {
            if (!open && !busy) setForgetTarget(null);
          }}
        >
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Forget this fact?</AlertDialogTitle>
              <AlertDialogDescription>
                Removes &ldquo;{forgetTarget?.statement}&rdquo; from active recall
                and stops future sharing of this detail.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel disabled={busy}>Keep fact</AlertDialogCancel>
              <AlertDialogAction
                disabled={busy}
                onClick={() => {
                  if (!forgetTarget) return;
                  const target = forgetTarget;
                  const activeSignal = localAbort.current?.signal ?? signal;
                  setForgetTarget(null);
                  void act(
                    async () => {
                      await FilesService.wikiForgetClaim(
                        { pageId: target.pageId, claimId: target.claimId },
                        activeSignal,
                      );
                      const refreshed = await FilesService.wikiPage(
                        target.pageId,
                        activeSignal,
                      );
                      await loadOverview(activeSignal);
                      activeSignal.throwIfAborted();
                      setSelectedPage(refreshed);
                      setDraftTitle(refreshed.title);
                      setDraftSummary(refreshed.tldr);
                      setDraftBody(refreshed.body);
                    },
                    "Fact forgotten",
                    false,
                  );
                }}
              >
                Forget fact
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <SettingsGroup title="Preferences" embedded headingClassName="mt-0">
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
