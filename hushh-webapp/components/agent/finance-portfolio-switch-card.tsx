"use client";

import { useEffect, useId, useRef, useState, useSyncExternalStore } from "react";

import { SurfaceCard, SurfaceCardContent } from "@/components/app-ui/surfaces";
import { useAuth } from "@/hooks/use-auth";
import { usePortfolioSources } from "@/lib/kai/brokerage/use-portfolio-sources";
import { Button } from "@/lib/morphy-ux/button";
import { subscribeToPkmDomainChanges } from "@/lib/pkm/pkm-domain-change-events";
import { isVaultSessionEpochCurrent, snapshotVaultSessionEpoch, subscribeVaultSessionEpoch } from "@/lib/vault/session-epoch";
import { useVault } from "@/lib/vault/vault-context";

const PLAID = "plaid";
const LINKED_PORTFOLIO = "Linked brokerage portfolio";

export function FinancePortfolioSwitchCard({ allowSwitch }: { allowSwitch?: boolean }) {
  const { userId } = useAuth();
  const { isVaultUnlocked, vaultKey, vaultOwnerToken } = useVault();
  const epoch = useSyncExternalStore(subscribeVaultSessionEpoch, snapshotVaultSessionEpoch, () => 0);

  return (
    <SurfaceCard>
      <SurfaceCardContent className="space-y-2">
        <p className="ui-text-row-label-emphasized">Switch portfolio</p>
        {!allowSwitch ? (
          <p className="ui-text-row-description">Ask One to switch portfolios again to open a new picker.</p>
        ) : !userId || !isVaultUnlocked || !vaultKey || !vaultOwnerToken ? (
          <p className="ui-text-row-description">Sign in and unlock your vault to switch portfolios.</p>
        ) : (
          <PortfolioPicker key={`${userId}:${epoch}`} {...{ userId, vaultKey, vaultOwnerToken, epoch }} />
        )}
      </SurfaceCardContent>
    </SurfaceCard>
  );
}

function PortfolioPicker({ userId, vaultKey, vaultOwnerToken, epoch }: {
  userId: string;
  vaultKey: string;
  vaultOwnerToken: string;
  epoch: number;
}) {
  const sources = usePortfolioSources({ userId, vaultKey, vaultOwnerToken, trackPortfolioReady: false });
  const { reload } = sources;
  const selectId = useId();
  const mounted = useRef(false);
  const pending = useRef(false);
  const [selection, setSelection] = useState("");
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<{ kind: "success" | "error"; text: string } | null>(null);

  useEffect(() => {
    mounted.current = true;
    const unsubscribe = subscribeToPkmDomainChanges(change => {
      if (change.userId === userId && (change.domain === "financial" || change.domain === "*") &&
          !pending.current) {
        setNotice(null);
        void reload({ background: true, force: true });
      }
    });
    return () => {
      mounted.current = false;
      unsubscribe();
    };
  }, [userId, reload]);

  const activeStatement = sources.activeSource === "statement"
    ? sources.statementSnapshots.find(snapshot => snapshot.id === sources.activeStatementSnapshotId)
    : undefined;
  const activeLabel = sources.activeSource === PLAID ? LINKED_PORTFOLIO :
    activeStatement?.fileName || activeStatement?.label || (sources.statementPortfolio ? "Saved statement" : null);
  const choices: { value: string; snapshotId: string | null; label: string }[] = sources.statementSnapshots
    .filter(snapshot => snapshot.id !== activeStatement?.id)
    .map(snapshot => ({
      value: `statement:${snapshot.id}`,
      snapshotId: snapshot.id,
      label: snapshot.fileName && snapshot.fileName !== snapshot.label
        ? `${snapshot.fileName} (${snapshot.label})`
        : snapshot.label,
    }));
  if (sources.availableSources.includes(PLAID) && sources.activeSource !== PLAID) {
    choices.unshift({ value: PLAID, snapshotId: null, label: LINKED_PORTFOLIO });
  }
  const choice = choices.find(option => option.value === selection);

  async function confirmSwitch() {
    if (!choice || pending.current || !sources.canChangePortfolioSource || !isVaultSessionEpochCurrent(epoch)) return;
    const isCurrent = () => mounted.current && isVaultSessionEpochCurrent(epoch);
    pending.current = true;
    setSaving(true);
    setNotice(null);
    try {
      if (choice.snapshotId) await sources.changeActiveStatementSnapshot(choice.snapshotId);
      else await sources.changeActiveSource(PLAID);
      if (isCurrent()) {
        setSelection("");
        setNotice({ kind: "success", text: "Active portfolio updated." });
      }
    } catch {
      if (isCurrent()) {
        setNotice({ kind: "error", text: "Couldn’t switch portfolios. Please try again." });
        void reload({ background: true, force: true });
      }
    } finally {
      pending.current = false;
      if (isCurrent()) setSaving(false);
    }
  }

  if (sources.isLoading && !saving) return <p role="status" className="ui-text-row-description">Loading portfolios…</p>;
  if (sources.error) return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
      <p role="status" className="ui-text-row-description">{sources.error}</p>
      <Button type="button" size="standard" variant="plain" onClick={() => void reload({ force: true })}>Retry</Button>
    </div>
  );

  return (
    <>
      {activeLabel ? <p className="break-words ui-text-row-description">Active portfolio · {activeLabel}</p> : null}
      {choices.length > 0 ? (
        <div className="flex flex-wrap items-center gap-2">
          <label className="sr-only" htmlFor={selectId}>Portfolio</label>
          <select id={selectId} value={choice?.value ?? ""} disabled={saving}
            onChange={event => { setSelection(event.target.value); setNotice(null); }}
            className="min-h-10 min-w-0 flex-1 rounded-xl border border-input bg-background px-3 text-sm">
            <option value="" disabled>Choose a portfolio</option>
            {choices.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
          </select>
          <Button type="button" size="standard" variant="blue" onClick={() => void confirmSwitch()}
            disabled={saving || !choice || !sources.canChangePortfolioSource}>
            {saving ? "Switching…" : "Use portfolio"}
          </Button>
        </div>
      ) : <p className="ui-text-row-description">No other saved portfolios are available.</p>}
      {notice ? <p role={notice.kind === "error" ? "alert" : "status"} className="ui-text-row-description">{notice.text}</p> : null}
    </>
  );
}
