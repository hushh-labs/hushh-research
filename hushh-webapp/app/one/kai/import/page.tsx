"use client";

export const dynamic = "force-dynamic";

import { useSearchParams } from "next/navigation";
import { Suspense, useEffect, useState } from "react";

import { FullscreenFlowShell } from "@/components/app-ui/fullscreen-flow-shell";
import { HushhLoader } from "@/components/app-ui/hushh-loader";
import { NativeTestBeacon } from "@/components/app-ui/native-test-beacon";
import { KaiFlow } from "@/components/kai/kai-flow";
import { useAuth } from "@/lib/firebase/auth-context";
import { useVault } from "@/lib/vault/vault-context";
import { getPendingImportReview } from "@/lib/kai/import/import-background-snapshot";
import { getStatementSnapshotOptions } from "@/lib/kai/brokerage/financial-sources";
import { useFinanceShareContext } from "@/lib/finance-sharing/use-finance-share-context";
import { PersonalKnowledgeModelService } from "@/lib/services/personal-knowledge-model-service";

function KaiImportPageContent() {
  const params = useSearchParams();
  const statementId = params.get("statement_id");
  const importRunId = params.get("import_run_id");
  const { user, userId, loading: authLoading } = useAuth();
  const { vaultOwnerToken } = useVault();
  if (authLoading || !user || !userId) {
    return null;
  }

  return (
    <FullscreenFlowShell
      as="div"
      width="agent"
      className="app-type-compact relative shrink-0"
    >
      <NativeTestBeacon
        routeId="/one/kai/import"
        marker="native-route-kai-import"
        authState="authenticated"
        dataState="loaded"
      />
      {statementId ? <SavedStatement key={statementId} statementId={statementId} /> :
        importRunId && (!vaultOwnerToken || getPendingImportReview(userId)?.runId !== importRunId)
          ? <p className="p-6">This statement review is no longer available on this device.</p>
          : <KaiFlow
              key={importRunId ?? "import"}
              userId={userId}
              mode="import"
              vaultOwnerToken={vaultOwnerToken ?? ""}
            />}
    </FullscreenFlowShell>
  );
}

function SavedStatement({ statementId }: { statementId: string }) {
  const { capture, ready, session } = useFinanceShareContext();
  const [result, setResult] = useState<{
    session: string;
    statement?: ReturnType<typeof getStatementSnapshotOptions>[number];
    failed?: boolean;
  } | null>(null);

  useEffect(() => {
    if (!ready) return;
    const context = capture();
    if (!context?.isCurrent()) return;
    let active = true;
    const { userId, vaultKey, vaultOwnerToken } = context;
    void PersonalKnowledgeModelService.loadDomainData({
      userId, vaultKey, vaultOwnerToken, domain: "financial",
    }).then(financial => {
      if (!active || !context.isCurrent()) return;
      setResult({ session, statement: getStatementSnapshotOptions(financial).find(item => item.id === statementId) });
    }).catch(() => {
      if (active && context.isCurrent()) setResult({ session, failed: true });
    });
    return () => { active = false; };
  }, [capture, ready, session, statementId]);

  if (!ready) return <p className="p-6">Unlock your vault to view this statement.</p>;
  if (result?.session !== session) return <HushhLoader label="Loading your statement…" variant="inline" />;
  const { statement, failed } = result;
  if (!statement) return <p className="p-6">{failed ? "Your statement couldn’t be loaded." : "This saved statement is no longer available."}</p>;

  return <article className="space-y-3 p-6">
    <h1 className="text-xl font-semibold">{statement.label}</h1>
    <dl className="space-y-2 text-sm">
      {statement.filename ? <div><dt>File</dt><dd className="break-words">{statement.filename}</dd></div> : null}
      {statement.importResult && typeof statement.importResult.holdings_saved === "number" ? <div><dt>Holdings saved</dt><dd>{statement.importResult.holdings_saved}</dd></div> : null}
      {statement.importResult?.counts_available === true ? ["added", "updated", "unchanged"].map(key => typeof statement.importResult?.[key] === "number" && Number(statement.importResult[key]) > 0 ? <div key={key}><dt className="capitalize">{key}</dt><dd>{String(statement.importResult[key])}</dd></div> : null) : null}
      {typeof statement.importResult?.skipped_entries === "number" && statement.importResult.skipped_entries > 0 ? <div><dt>Skipped entries</dt><dd>{statement.importResult.skipped_entries}</dd></div> : null}
      {statement.brokerage ? <div><dt>Brokerage</dt><dd>{statement.brokerage}</dd></div> : null}
      {statement.statementPeriodEnd ? <div><dt>Statement period end</dt><dd>{statement.statementPeriodEnd}</dd></div> : null}
      {statement.importedAt ? <div><dt>Saved</dt><dd><time dateTime={statement.importedAt}>{new Date(statement.importedAt).toLocaleDateString()}</time></dd></div> : null}
    </dl>
  </article>;
}

export default function KaiImportPage() {
  return (
    <Suspense fallback={<HushhLoader label="Loading import..." variant="fullscreen" />}>
      <KaiImportPageContent />
    </Suspense>
  );
}
