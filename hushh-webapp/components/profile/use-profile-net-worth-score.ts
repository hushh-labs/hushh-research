"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { isValidatedAuthSessionOwnerCurrent, snapshotValidatedAuthSessionPrincipal } from "@/lib/auth/session-owner";
import { readFinancialNws } from "@/lib/kai/plaid-vault/nws-financial-report";
import type { FinancialDomain } from "@/lib/kai/plaid-vault/types";
import { connectVaultPlaid, relinkVaultPlaid, vaultConnections } from "@/lib/kai/plaid-vault/vault-sync";
import { startJourneyTrace } from "@/lib/observability/journey-trace";
import { usePkmDomainResource } from "@/lib/pkm/pkm-domain-resource";
import { snapshotVaultSessionEpoch } from "@/lib/vault/session-epoch";
import type { NwsCardAction } from "./net-worth-score-card";

export function useProfileNetWorthScore({
  visible: nwsVisible, onProfileRoot, applicationOwnerId, isVaultUnlocked, vaultKey, vaultOwnerToken, open, returnPath,
}: {
  visible: boolean; onProfileRoot: boolean; applicationOwnerId: string | null | undefined;
  isVaultUnlocked: boolean; vaultKey: string | null | undefined; vaultOwnerToken: string | null | undefined;
  open: () => void; returnPath: () => string;
}) {
  const nwsUnlocked = nwsVisible && !!applicationOwnerId && isVaultUnlocked &&
    !!vaultKey && !!vaultOwnerToken;
  const nwsFinancial = usePkmDomainResource({
    userId: applicationOwnerId ?? "",
    domain: "financial",
    vaultKey,
    vaultOwnerToken,
    enabled: nwsUnlocked,
  });
  const nwsData = nwsUnlocked && nwsFinancial.data?.key.userId === applicationOwnerId
    ? nwsFinancial.data?.data as FinancialDomain | undefined : undefined;
  const nwsReport = useMemo(() => readFinancialNws(nwsData), [nwsData]);
  const nwsReady = nwsReport?.netWorth != null;
  const nwsDataReady = nwsData !== undefined;
  useEffect(() => {
    if (!nwsVisible || !nwsDataReady) return;
    startJourneyTrace("profile_nws")("ui_ready", { outcome: nwsReady ? "score_ready" : "no_score" });
  }, [nwsVisible, nwsDataReady, nwsReady]);
  const [nwsBusy, setNwsBusy] = useState(false);
  const [nwsFailed, setNwsFailed] = useState(false);
  const nwsFlight = useRef(false);
  const nwsConnections = Object.entries(vaultConnections(nwsData));
  const nwsReconnect = nwsConnections.find(([, connection]) => connection.status === "needs_relink");
  const nwsDebt = nwsConnections.find(([itemId, connection]) => connection.nws_debt_details_available &&
    !connection.products.includes("liabilities") && !connection.nws_consent?.includes("liabilities") &&
    Object.values(nwsData?.accounts_v1 ?? {}).some(account => account.item_id === itemId &&
      !account.duplicate_of && account.type === "credit" && (account.balances.current ?? 0) > 0));
  const nwsInvestment = nwsConnections.find(([, connection]) => connection.nws_investments_available);
  const nwsStatus = nwsBusy ? "Connecting…" : nwsFailed ? "Couldn’t update the connection."
    : nwsReconnect ? "Reconnect needed"
    : !nwsReady && nwsConnections.length > 0 ? "Net worth unavailable" : null;
  const nwsCoverageStatus = nwsReport?.coverageReasons.some(reason =>
    reason === "balance_unavailable" || reason === "holdings_unavailable" || reason === "currency_unavailable",
  ) ? "Some balances aren’t included." : null;

  const startNwsLink = async (itemId?: string, product?: "liabilities" | "investments", selectAccounts?: boolean) => {
    if (!applicationOwnerId || !vaultKey || !vaultOwnerToken || nwsFlight.current) return;
    const owner = snapshotValidatedAuthSessionPrincipal();
    if (!owner || owner.userId !== applicationOwnerId) return;
    const epoch = snapshotVaultSessionEpoch();
    const isCurrent = () => isValidatedAuthSessionOwnerCurrent(owner) && epoch === snapshotVaultSessionEpoch();
    const authority = { userId: applicationOwnerId, vaultKey, vaultOwnerToken, originSurface: "profile_nws" } as const;
    nwsFlight.current = true;
    setNwsBusy(true);
    setNwsFailed(false);
    try {
      const result = itemId
        ? await relinkVaultPlaid({ ...authority, itemId, additionalProduct: product, selectAccounts })
        : await connectVaultPlaid({
            ...authority,
            successReturnPath: returnPath(),
          });
      if (!isCurrent()) return;
      if (result.status === "blocked") setNwsFailed(true);
      if (result.status === "connected" || result.status === "repaired") {
        await nwsFinancial.refresh({ force: true });
        if (isCurrent() && result.status === "connected" && onProfileRoot) {
          open();
        }
      }
    } catch {
      if (isCurrent()) setNwsFailed(true);
    } finally {
      nwsFlight.current = false;
      setNwsBusy(false);
    }
  };
  const nwsPrimary: NwsCardAction | undefined = nwsBusy ? undefined
    : !nwsUnlocked ? { label: "Unlock vault", run: () => open() }
    : nwsFinancial.loading && !nwsData ? undefined
    : nwsFinancial.error && !nwsData
      ? { label: "Try again", run: () => { void nwsFinancial.refresh({ force: true }); } }
    : nwsReconnect ? { label: "Reconnect bank", run: () => { void startNwsLink(nwsReconnect[0]); } }
    : !nwsConnections.length ? { label: "Connect bank", run: () => { void startNwsLink(); } }
    : undefined;
  const nwsSecondary: NwsCardAction | undefined = !nwsBusy && !nwsReconnect && nwsDebt
    ? { label: "Add debt details", run: () => { void startNwsLink(nwsDebt[0], "liabilities"); } }
    : !nwsBusy && !nwsReconnect && nwsReport?.coverageReasons.includes("cash_only_coverage")
      ? { label: "Link investments", run: () => {
          if (!nwsInvestment) {
            void startNwsLink();
            return;
          }
          const [itemId, connection] = nwsInvestment;
          const hasConsent = connection.products.includes("investments") || connection.nws_consent?.includes("investments");
          void startNwsLink(itemId, hasConsent ? undefined : "investments", true);
        } }
      : undefined;

  return { report: nwsReport, status: nwsStatus, coverageStatus: nwsCoverageStatus, primary: nwsPrimary, secondary: nwsSecondary, unlocked: nwsUnlocked };
}
