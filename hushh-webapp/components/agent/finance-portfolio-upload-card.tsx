"use client";

import dynamic from "next/dynamic";
import { useRef, useState, useSyncExternalStore } from "react";
import { SurfaceCard, SurfaceCardContent } from "@/components/app-ui/surfaces";
import { CheckCircle2, Loader2 } from "@/components/icons";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { useAuth } from "@/hooks/use-auth";
import {
  discardChatStatementReview,
  markChatStatementSaved,
  readChatStatementImport,
  startChatStatementImport,
  subscribeChatStatementImport,
} from "@/lib/kai/import/chat-statement-import";
import { STATEMENT_FILE_ACCEPT } from "@/lib/kai/import/statement-upload";
import { Button } from "@/lib/morphy-ux/button";
import { useVault } from "@/lib/vault/vault-context";

const PortfolioReviewView = dynamic(
  () => import("@/components/kai/views/portfolio-review-view").then(module => module.PortfolioReviewView),
);

export function FinancePortfolioUploadCard({ offerId, allowUpload }: {
  offerId: string;
  allowUpload?: boolean;
}) {
  const { userId } = useAuth();
  const { isVaultUnlocked, vaultKey, vaultOwnerToken } = useVault();
  const fileInput = useRef<HTMLInputElement>(null);
  const [reviewOpen, setReviewOpen] = useState(false);
  const current = useSyncExternalStore(subscribeChatStatementImport, readChatStatementImport, () => null);
  const unlocked = Boolean(userId && isVaultUnlocked && vaultKey && vaultOwnerToken);
  const state = unlocked && current?.userId === userId && current.offerId === offerId ? current : null;
  const busy = current?.phase === "processing" || current?.phase === "review";

  return (
    <SurfaceCard>
      <SurfaceCardContent className="space-y-2 py-3">
        {state?.phase === "processing" ? (
          <p role="status" className="flex items-start gap-2 ui-text-row-description">
            <Loader2 aria-hidden="true" className="mt-0.5 size-4 shrink-0 motion-safe:animate-spin" />
            Processing your portfolio. You can keep using the app.
          </p>
        ) : state?.phase === "saved" ? (
          <p role="status" className="flex items-center gap-2 ui-text-row-description text-foreground">
            <CheckCircle2 aria-hidden="true" className="size-4 shrink-0 text-green-600 dark:text-green-400" />
            Portfolio saved to your vault.
          </p>
        ) : state?.phase === "review" && userId && vaultKey && vaultOwnerToken ? (
          <>
            <p role="status" className="ui-text-row-description">Check the extracted holdings before saving.</p>
            <Button type="button" variant="blue" size="standard" onClick={() => setReviewOpen(true)}>
              Review portfolio
            </Button>
            <Dialog modal open={reviewOpen} onOpenChange={setReviewOpen}>
              <DialogContent className="max-h-[85dvh] overflow-y-auto sm:max-w-3xl">
                <DialogTitle>Review portfolio</DialogTitle>
                <DialogDescription>Check the statement details before saving to your vault.</DialogDescription>
                <PortfolioReviewView
                  portfolioData={state.portfolio}
                  importFileName={state.fileName}
                  userId={userId}
                  vaultKey={vaultKey}
                  vaultOwnerToken={vaultOwnerToken}
                  publishOptimistically={false}
                  onSaveComplete={() => {
                    markChatStatementSaved(userId, offerId);
                    setReviewOpen(false);
                  }}
                  onReimport={() => {
                    discardChatStatementReview(userId, offerId);
                    setReviewOpen(false);
                  }}
                />
              </DialogContent>
            </Dialog>
          </>
        ) : allowUpload ? (
          <>
            {state?.phase === "failed" ? <p role="alert" className="ui-text-row-description">{state.message}</p> : null}
            <p className="ui-text-row-description text-muted-foreground">
              {unlocked ? "Choose a PDF or CSV statement to import and save to your vault." : "Unlock your vault to upload a portfolio."}
            </p>
            <input ref={fileInput} hidden type="file" accept={STATEMENT_FILE_ACCEPT} onChange={event => {
              const file = event.currentTarget.files?.[0];
              event.currentTarget.value = "";
              if (file && unlocked && userId && vaultKey && vaultOwnerToken) {
                void startChatStatementImport({ offerId, userId, file, vaultKey, vaultOwnerToken });
              }
            }} />
            <Button type="button" variant="blue" size="standard" disabled={!unlocked || busy}
              onClick={() => fileInput.current?.click()}>
              Upload your portfolio
            </Button>
          </>
        ) : (
          <p className="ui-text-row-description text-muted-foreground">Portfolio upload offered.</p>
        )}
      </SurfaceCardContent>
    </SurfaceCard>
  );
}
