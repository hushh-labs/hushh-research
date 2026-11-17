"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { SettingsGroup, SettingsRow } from "@/components/app-ui/settings-ui";
import { PersonalWikiPanel } from "@/components/files/personal-wiki-panel";
import { useCommunicationPreferencesEditor } from "@/components/profile/communication-preferences-section";
import { LiveMirrorPreview } from "@/components/profile/live-mirror-preview";
import { NativeWritingStyleEditor } from "@/components/profile/native-writing-style-editor";
import { SoulMemoryPanelBody } from "@/components/profile/soul-memory-panel";
import type { SoulMemoryModel } from "@/components/profile/use-soul-memory-model";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { useAuth } from "@/hooks/use-auth";
import {
  OWNER_STYLE_LENGTH_LABEL,
  OWNER_STYLE_TONE_LABEL,
} from "@/lib/agent/owner-style-settings";
import { FilesLocalError } from "@/lib/files/local-error";
import { FilesService, type WikiOverview } from "@/lib/files/service";
import { useFilesConnection } from "@/lib/files/use-files-connection";
import { Button, morphyToast } from "@/lib/morphy-ux/morphy";
import { useBackLayer } from "@/lib/navigation/back-layers";
import { ROUTES } from "@/lib/navigation/routes";
import { replaceMarkdownMemoryDocument } from "@/lib/pkm/markdown-memory";
import {
  readLabelledSoulFacts,
  setLabelledSoulFact,
} from "@/lib/pkm/soul-labelled-facts";
import type { LiveMirrorViewState } from "@/lib/pkm/use-live-mirror-view";
import { isValidDateOfBirth } from "@/lib/services/kyc-identity-profile-pkm-service";
import { useVault } from "@/lib/vault/vault-context";

type ActiveDocSheet = "wiki" | "memory" | "identity" | "soul" | null;

function countMarkdownHeadings(markdown: string): number {
  return markdown
    .split(/\r?\n/)
    .filter((line) => /^#{1,3}\s+\S/.test(line.trim())).length;
}

export function MemoryKnowledgeHub({
  soul,
  liveMirror,
}: {
  soul: SoulMemoryModel;
  liveMirror?: LiveMirrorViewState;
}) {
  const { userId } = useAuth();
  const { vaultKey, vaultOwnerToken, isVaultUnlocked } = useVault();
  const { hosting, connectionError } = useFilesConnection(
    userId ?? undefined,
    vaultKey,
    vaultOwnerToken,
  );
  const filesAvailable = Boolean(
    userId && vaultKey && vaultOwnerToken && hosting,
  );
  const styleModel = useCommunicationPreferencesEditor({
    userId: userId ?? null,
    vaultKey,
    vaultOwnerToken,
  });

  const [openSheet, setOpenSheet] = useState<ActiveDocSheet>(null);
  const [wikiOverview, setWikiOverview] = useState<WikiOverview | null>(null);
  const [wikiBusy, setWikiBusy] = useState(false);
  const wikiAbortRef = useRef<AbortController>(new AbortController());
  const wikiActionPending = useRef(false);

  const [identityLegalName, setIdentityLegalName] = useState("");
  const [identityDob, setIdentityDob] = useState("");
  const [identitySex, setIdentitySex] = useState("");
  const [identitySaving, setIdentitySaving] = useState(false);

  const refreshWikiOverview = useCallback(async () => {
    if (!filesAvailable) {
      setWikiOverview(null);
      return;
    }
    wikiAbortRef.current.abort();
    const controller = new AbortController();
    wikiAbortRef.current = controller;
    try {
      const next = await FilesService.wikiOverview(controller.signal);
      if (!controller.signal.aborted) {
        setWikiOverview(next);
      }
    } catch {
      if (!controller.signal.aborted) {
        setWikiOverview(null);
      }
    }
  }, [filesAvailable]);

  useEffect(() => {
    void refreshWikiOverview();
    return () => wikiAbortRef.current.abort();
  }, [refreshWikiOverview, userId]);

  const markdownSource = soul.current?.document.markdown ?? "";
  const labelledFacts = readLabelledSoulFacts(markdownSource);
  const statedLegalName = labelledFacts.get("legal name")?.value?.trim() ?? "";
  const statedDob = labelledFacts.get("date of birth")?.value?.trim() ?? "";
  const statedSex = labelledFacts.get("sex")?.value?.trim() ?? "";

  const openIdentitySheet = () => {
    setIdentityLegalName(statedLegalName);
    setIdentityDob(statedDob);
    setIdentitySex(statedSex);
    setOpenSheet("identity");
  };

  useBackLayer(ROUTES.PKM, openSheet !== null ? 1 : 0, () => {
    if (wikiBusy || identitySaving || styleModel.saving || soul.saving) {
      return true;
    }
    setOpenSheet(null);
    return true;
  });

  const runWikiAction = async (
    operation: () => Promise<unknown>,
    successLabel: string | (() => string),
    refreshAfter = true,
  ) => {
    if (wikiActionPending.current) return;
    wikiActionPending.current = true;
    setWikiBusy(true);
    const signal = wikiAbortRef.current.signal;
    const promise = (async () => {
      await operation();
      signal.throwIfAborted();
      if (refreshAfter) {
        await refreshWikiOverview();
      }
      return typeof successLabel === "function" ? successLabel() : successLabel;
    })();
    const toastId = morphyToast.promise(promise, {
      loading: "Updating Personal Wiki…",
      success: (msg) => (signal.aborted ? undefined : msg),
      error: (err) =>
        signal.aborted
          ? undefined
          : err instanceof FilesLocalError
            ? err.message
            : "Couldn’t update Personal Wiki. Try again.",
    });
    const dismiss = () => {
      if (typeof toastId === "string" || typeof toastId === "number") {
        morphyToast.dismiss(toastId);
      }
    };
    signal.addEventListener("abort", dismiss, { once: true });
    try {
      await toastId.unwrap();
    } catch {
      // Handled by morphyToast.promise
    } finally {
      signal.removeEventListener("abort", dismiss);
      if (!signal.aborted) {
        wikiActionPending.current = false;
        setWikiBusy(false);
      }
    }
  };

  const dobValid = !identityDob || isValidDateOfBirth(identityDob);
  const identityDirty =
    identityLegalName.trim() !== statedLegalName ||
    identityDob.trim() !== statedDob ||
    identitySex.trim() !== statedSex;

  const saveIdentityAnchors = async () => {
    if (!userId || !vaultKey || !vaultOwnerToken || !soul.current || !dobValid) {
      return;
    }
    setIdentitySaving(true);
    const expectedMarkdown = soul.current.document.markdown;
    let nextMarkdown = setLabelledSoulFact(
      expectedMarkdown,
      "Legal name",
      identityLegalName.trim(),
    );
    nextMarkdown = setLabelledSoulFact(
      nextMarkdown,
      "Date of birth",
      identityDob.trim(),
    );
    nextMarkdown = setLabelledSoulFact(
      nextMarkdown,
      "Sex",
      identitySex.trim(),
    );

    const expectedPersisted = soul.current.document.persisted;
    const savePromise = (async () => {
      const result = await replaceMarkdownMemoryDocument({
        userId,
        vaultKey,
        vaultOwnerToken,
        markdown: nextMarkdown,
        expectedMarkdown,
        expectedPersisted,
        beforeEffect: async () => undefined,
      });
      if (!result.success) {
        throw new Error(
          result.conflict
            ? "Another update arrived first. Reload and try again."
            : "Couldn’t save identity details.",
        );
      }
      return "Identity updated";
    })();

    const toastId = morphyToast.promise(savePromise, {
      loading: "Saving identity…",
      success: (msg) => msg,
      error: (err) =>
        err instanceof Error ? err.message : "Couldn’t save identity details.",
    });
    try {
      await toastId.unwrap();
      setOpenSheet(null);
    } catch {
      // Handled by morphyToast.promise
    } finally {
      setIdentitySaving(false);
    }
  };

  const wikiDescription = (() => {
    if (wikiOverview) {
      const pageCount = wikiOverview.pages.length;
      const pendingCount = wikiOverview.candidateReceipts.length;
      if (pendingCount > 0) {
        return `${pageCount} ${pageCount === 1 ? "page" : "pages"} · ${pendingCount} pending review`;
      }
      if (pageCount > 0) {
        return `${pageCount} ${pageCount === 1 ? "page" : "pages"} · ${
          wikiOverview.captureOptIn ? "Conversation memory on" : "Cited recall"
        }`;
      }
      return "Topic pages, archive imports, and cited recall";
    }
    if (connectionError) {
      return "Connect your private library in Hosting settings";
    }
    return "Topic pages, archive imports, and cited recall";
  })();

  const memoryIndexDescription = (() => {
    if (!soul.verified) return "Reconnect your account to open";
    if (soul.failed) return "Couldn’t open · Tap to retry";
    if (!soul.current) return "Loading…";
    if (wikiOverview?.migrationState === "wiki_primary") {
      return "Compact wiki index · Classic writer retired";
    }
    if (wikiOverview?.migrationState === "wiki_primary_with_v1_rollback") {
      return "Compact wiki index · Primary recall active";
    }
    const sections = countMarkdownHeadings(markdownSource);
    if (sections > 0) {
      return `${sections} ${sections === 1 ? "section" : "sections"} · Orientation index & notes`;
    }
    return markdownSource.trim()
      ? "Orientation index & notes"
      : "Empty orientation index";
  })();

  const soulStyleSummary = (() => {
    const parts: string[] = [];
    if (styleModel.draft.preferred_name) {
      parts.push(styleModel.draft.preferred_name);
    }
    if (styleModel.draft.tone) {
      parts.push(OWNER_STYLE_TONE_LABEL[styleModel.draft.tone]);
    }
    if (styleModel.draft.length) {
      parts.push(OWNER_STYLE_LENGTH_LABEL[styleModel.draft.length]);
    }
    if (styleModel.draft.avoid_em_dashes) {
      parts.push("No em dashes");
    }
    if (parts.length > 0) return parts.join(" · ");
    if (styleModel.draft.owner_style_note) {
      return styleModel.draft.owner_style_note.slice(0, 72);
    }
    return "Standing voice, tone, and writing rules";
  })();

  const canCompileClassicIntoWiki = Boolean(
    filesAvailable &&
      wikiOverview &&
      wikiOverview.migrationState === "v1_markdown_only" &&
      markdownSource.trim().length > 0,
  );

  return (
    <div className="min-w-0 space-y-5">
      {soul.active ? (
        <LiveMirrorPreview showOpenMemory={false} mirror={liveMirror} />
      ) : null}

      <SettingsGroup
        title="Personal wiki"
        separatorInset
        testId="memory-wiki-group"
      >
        <SettingsRow
          title="Personal wiki"
          description={wikiDescription}
          chevron
          ariaLabel="Open Personal wiki"
          onClick={() => setOpenSheet("wiki")}
          testId="memory-open-personal-wiki"
        />
        <SettingsRow
          title="memory.md"
          description={memoryIndexDescription}
          chevron
          ariaLabel="Open memory.md"
          onClick={() => {
            if (soul.failed) {
              soul.retryLoad();
              return;
            }
            setOpenSheet("memory");
          }}
          testId="memory-open-index-doc"
        />
      </SettingsGroup>

      <SettingsGroup
        title="Core documents"
        separatorInset
        testId="memory-core-docs-group"
      >
        <SettingsRow
          title="identity.md"
          description={
            statedLegalName
              ? `${statedLegalName} · Stated identity`
              : "Stated legal name and core identity (optional)"
          }
          chevron
          ariaLabel="Open identity.md"
          disabled={!isVaultUnlocked || !soul.current}
          onClick={openIdentitySheet}
          testId="memory-open-identity-doc"
        />
        <SettingsRow
          title="soul.md"
          description={soulStyleSummary}
          chevron
          ariaLabel="Open soul.md"
          disabled={!isVaultUnlocked}
          onClick={() => setOpenSheet("soul")}
          testId="memory-open-soul-doc"
        />
      </SettingsGroup>

      {/* 1. Personal Wiki Sheet */}
      <Dialog
        open={openSheet === "wiki"}
        onOpenChange={(open) => {
          if (!open && !wikiBusy) {
            setOpenSheet(null);
            void refreshWikiOverview();
          }
        }}
      >
        <DialogContent className="max-h-[85dvh] overflow-y-auto sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Personal wiki</DialogTitle>
            <DialogDescription>
              Topic pages, ChatGPT or Claude archive imports, and cited recall.
            </DialogDescription>
          </DialogHeader>
          {filesAvailable ? (
            <PersonalWikiPanel
              key={`memory-wiki:${userId ?? ""}`}
              ownerId={userId ?? undefined}
              signal={wikiAbortRef.current.signal}
              busy={wikiBusy}
              unavailable={!filesAvailable}
              act={runWikiAction}
            />
          ) : (
            <p className="py-3 text-sm text-muted-foreground">
              {connectionError ||
                "Connect your private library in Hosting settings to open your Personal Wiki."}
            </p>
          )}
        </DialogContent>
      </Dialog>

      {/* 2. memory.md Index & Classic Notes Sheet */}
      <Dialog
        open={openSheet === "memory"}
        onOpenChange={(open) => {
          if (!open && !soul.saving && !wikiBusy) {
            if (soul.editing) soul.cancelEdit();
            setOpenSheet(null);
          }
        }}
      >
        <DialogContent className="max-h-[85dvh] overflow-y-auto sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>memory.md</DialogTitle>
            <DialogDescription>
              Orientation index and Markdown notes.
            </DialogDescription>
          </DialogHeader>
          {canCompileClassicIntoWiki ? (
            <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border/60 bg-secondary/20 px-3.5 py-3 text-sm">
              <p className="min-w-0 flex-1 text-muted-foreground">
                Compile these classic notes into structured Personal Wiki pages.
              </p>
              <Button
                type="button"
                variant="none"
                effect="fade"
                size="compact"
                data-pkm-action="compact"
                disabled={wikiBusy}
                onClick={() => {
                  void runWikiAction(async () => {
                    const verified = await FilesService.wikiMigrateCohort(
                      {
                        action: "compile_and_verify",
                        expectedMigrationRevision:
                          wikiOverview?.migrationRevision,
                      },
                      wikiAbortRef.current.signal,
                    );
                    if (verified.dualReadQualified) {
                      await FilesService.wikiMigrateCohort(
                        {
                          action: "cutover_rollback_safe",
                          expectedMigrationRevision: verified.migrationRevision,
                        },
                        wikiAbortRef.current.signal,
                      );
                    }
                  }, "Compiled into Personal Wiki");
                }}
              >
                Compile into wiki
              </Button>
            </div>
          ) : null}
          <SoulMemoryPanelBody model={soul} hideLiveMirror />
        </DialogContent>
      </Dialog>

      {/* 3. identity.md Stated Identity Sheet */}
      <Dialog
        open={openSheet === "identity"}
        onOpenChange={(open) => {
          if (!open && !identitySaving) setOpenSheet(null);
        }}
      >
        <DialogContent className="max-h-[85dvh] overflow-y-auto sm:max-w-md">
          <DialogHeader>
            <DialogTitle>identity.md</DialogTitle>
            <DialogDescription>
              Explicit stated details. Never guessed from conversations or
              imported archives.
            </DialogDescription>
          </DialogHeader>
          <form
            className="space-y-4"
            onSubmit={(event) => {
              event.preventDefault();
              void saveIdentityAnchors();
            }}
          >
            <label className="block space-y-1.5 text-sm">
              <span className="font-medium">Legal name</span>
              <Input
                aria-label="Legal name"
                value={identityLegalName}
                disabled={identitySaving}
                autoComplete="name"
                onChange={(event) => setIdentityLegalName(event.target.value)}
              />
            </label>
            <label className="block space-y-1.5 text-sm">
              <span className="font-medium">Date of birth</span>
              <Input
                aria-label="Date of birth"
                type="date"
                value={identityDob}
                disabled={identitySaving}
                aria-invalid={!dobValid}
                onChange={(event) => setIdentityDob(event.target.value)}
              />
              <span className="block text-xs text-muted-foreground">
                {dobValid
                  ? "Age is worked out from this. The birth date itself is never shared."
                  : "Enter a real past date."}
              </span>
            </label>
            <label className="block space-y-1.5 text-sm">
              <span className="font-medium">Sex</span>
              <Input
                aria-label="Sex"
                value={identitySex}
                disabled={identitySaving}
                onChange={(event) => setIdentitySex(event.target.value)}
              />
              <span className="block text-xs text-muted-foreground">
                Recorded only as you write it.
              </span>
            </label>
            <div className="flex justify-end gap-2 pt-2">
              <Button
                type="button"
                variant="none"
                effect="fade"
                size="compact"
                disabled={identitySaving}
                onClick={() => setOpenSheet(null)}
              >
                Cancel
              </Button>
              <Button
                type="submit"
                variant="none"
                effect="fade"
                size="compact"
                data-pkm-action="compact"
                disabled={identitySaving || !identityDirty || !dobValid}
              >
                {identitySaving ? "Saving…" : "Save"}
              </Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>

      {/* 4. soul.md Standing Voice & Style Sheet */}
      <Dialog
        open={openSheet === "soul"}
        onOpenChange={(open) => {
          if (!open && !styleModel.saving) setOpenSheet(null);
        }}
      >
        <DialogContent className="max-h-[85dvh] overflow-y-auto sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>soul.md</DialogTitle>
            <DialogDescription>
              How One writes to you. Style only — never grants access, sharing,
              or actions.
            </DialogDescription>
          </DialogHeader>
          <NativeWritingStyleEditor model={styleModel} eligible={false} />
        </DialogContent>
      </Dialog>
    </div>
  );
}
