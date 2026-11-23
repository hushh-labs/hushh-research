"use client";

import type { PortfolioData } from "@/components/kai/views/portfolio-review-view";
import { findHoldingValidationIssue } from "@/lib/kai/holding-validation";
import { ApiService } from "@/lib/services/api-service";
import { KAI_PORTFOLIO_IMPORT_IDLE_TIMEOUT_MS } from "@/lib/services/kai-import-stream-config";
import { VaultService } from "@/lib/services/vault-service";
import { consumeCanonicalKaiStream } from "@/lib/streaming/kai-stream-client";
import { isVaultSessionEpochCurrent, snapshotVaultSessionEpoch, subscribeVaultSessionEpoch } from "@/lib/vault/session-epoch";
import { commitStatementPortfolio } from "./commit-statement-portfolio";
import { MAX_STATEMENT_FILE_SIZE_MESSAGE, readStatementImportResult, statementFileError, statementImportForm } from "./statement-upload";

type ImportPhase =
  | { phase: "processing" | "saved" }
  | { phase: "failed"; message: string }
  | { phase: "review"; portfolio: PortfolioData; fileName: string };

type ImportState = ImportPhase & { userId: string; offerId: string };
type ImportRequest = {
  userId: string;
  offerId: string;
  file: File;
  vaultKey: string;
  vaultOwnerToken: string;
};

const listeners = new Set<() => void>();
let state: ImportState | null = null;
let releaseEpoch: (() => void) | undefined;

function publish(value: ImportState | null) {
  state = value;
  for (const listener of listeners) listener();
}

export function subscribeChatStatementImport(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function readChatStatementImport(): ImportState | null {
  return state;
}

export function markChatStatementSaved(userId: string, offerId: string): void {
  if (state?.userId === userId && state.offerId === offerId && state.phase === "review") {
    publish({ userId, offerId, phase: "saved" });
  }
}

export function discardChatStatementReview(userId: string, offerId: string): void {
  if (state?.userId === userId && state.offerId === offerId && state.phase === "review") {
    publish(null);
  }
}

export async function startChatStatementImport(request: ImportRequest): Promise<void> {
  const { userId, offerId, file, vaultKey } = request;
  if (state?.phase === "processing" || state?.phase === "review") return;
  releaseEpoch?.();
  const epoch = snapshotVaultSessionEpoch();
  const controller = new AbortController();
  const mayPublish = () => isVaultSessionEpochCurrent(epoch) && !controller.signal.aborted;
  const requireCurrent = async () => {
    if (!mayPublish()) throw new DOMException("Import session ended", "AbortError");
  };
  const update = (phase: ImportPhase) => {
    if (mayPublish()) publish({ userId, offerId, ...phase });
  };
  releaseEpoch = subscribeVaultSessionEpoch(() => {
    controller.abort();
    releaseEpoch?.();
    releaseEpoch = undefined;
    publish(null);
  });

  const fileError = statementFileError(file);
  if (fileError) {
    update({ phase: "failed", message: fileError });
    return;
  }
  update({ phase: "processing" });
  const deadline = setTimeout(() => controller.abort(), 6 * 60_000);
  let vaultOwnerToken = request.vaultOwnerToken;
  const importedAt = new Date().toISOString();
  const formData = statementImportForm(file, userId);
  const extract = () => ApiService.importPortfolioStream({
    formData, vaultOwnerToken, signal: controller.signal,
  });
  let failureMessage = "Couldn’t process this statement. Try uploading it again.";
  try {
    let response = await extract();
    if (response.status === 401) {
      await requireCurrent();
      vaultOwnerToken = (await VaultService.getOrIssueVaultOwnerToken(userId, null, null)).token;
      await requireCurrent();
      response = await extract();
    }
    if (!response.ok) {
      if (response.status === 409) failureMessage = "Another statement is still processing. Try again when it finishes.";
      if (response.status === 413) failureMessage = MAX_STATEMENT_FILE_SIZE_MESSAGE;
      if (response.status === 422) failureMessage = "We couldn’t read this as a brokerage statement.";
      throw new Error("Statement upload rejected");
    }
    let portfolio: PortfolioData | undefined;
    await consumeCanonicalKaiStream(response, ({ event, payload }) => {
      if (!mayPublish()) return;
      if (event === "complete") {
        portfolio = readStatementImportResult(payload);
      } else if (event === "aborted" || event === "error") {
        throw new Error("Statement extraction did not complete");
      }
    }, { signal: controller.signal, idleTimeoutMs: KAI_PORTFOLIO_IMPORT_IDLE_TIMEOUT_MS, requireTerminal: true });
    clearTimeout(deadline);
    await requireCurrent();
    if (!portfolio?.holdings?.length) throw new Error("No holdings in statement");

    const gate = portfolio.quality_report_v2?.quality_gate;
    if (portfolio.parse_fallback || gate?.passed !== true || gate.severity !== "pass" ||
        findHoldingValidationIssue(portfolio.holdings)) {
      update({ phase: "review", portfolio, fileName: file.name });
      return;
    }
    failureMessage = "Couldn’t save this portfolio to your vault.";
    await commitStatementPortfolio({
      userId, vaultKey, vaultOwnerToken, portfolio: { ...portfolio }, fileName: file.name,
      importedAt, beforeEffect: requireCurrent, mayPublish,
    });
    update({ phase: "saved" });
  } catch {
    if (isVaultSessionEpochCurrent(epoch)) {
      publish({ phase: "failed", userId, offerId, message: failureMessage });
    }
  } finally {
    clearTimeout(deadline);
  }
}
