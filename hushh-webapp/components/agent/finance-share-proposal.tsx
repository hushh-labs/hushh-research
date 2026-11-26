"use client";

import { useEffect, useRef, useState } from "react";
import dynamic from "next/dynamic";
import { FinanceSharingHistoryAction } from "@/components/kai/sharing/finance-sharing-history-action";
import { mapPortfolioToDashboardViewModel } from "@/components/kai/views/dashboard-data-mapper";
import { useFinanceShareContext } from "@/lib/finance-sharing/use-finance-share-context";
import type { FinanceSource } from "@/lib/finance-sharing/contract";
import { KaiFinancialResourceService } from "@/lib/kai/kai-financial-resource";
import { Button } from "@/lib/morphy-ux/button";

const FinanceShareFlow = dynamic(() =>
  import("@/components/kai/sharing/finance-share-flow").then(module => module.FinanceShareFlow),
);

export function FinanceShareProposal({ audience }: { audience: "connection" | "verified_advisor" }) {
  const { capture, ready, session } = useFinanceShareContext();
  return <ShareEntry key={session} capture={capture} ready={ready} audience={audience} />;
}

function ShareEntry({
  capture, ready, audience,
}: Pick<ReturnType<typeof useFinanceShareContext>, "capture" | "ready"> & {
  audience: "connection" | "verified_advisor";
}) {
  const generation = useRef(0);
  const pending = useRef(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [opened, setOpened] = useState<{
    model: ReturnType<typeof mapPortfolioToDashboardViewModel>;
    source: FinanceSource;
  } | null>(null);
  useEffect(() => () => { generation.current += 1; }, []);

  async function openShare() {
    const context = capture();
    if (!ready || !context?.isCurrent() || pending.current) return;
    const request = ++generation.current;
    const current = () => generation.current === request && context.isCurrent();
    pending.current = true;
    setError(null);
    setLoading(true);
    try {
      const saved = await KaiFinancialResourceService.readForAnswer(context, current);
      if (!current()) return;
      const resource = saved?.resource;
      if (!saved?.isCurrent() || !resource?.activePortfolio) {
        setError("Add a portfolio before sharing.");
        return;
      }
      const kind = resource.activeSource;
      setOpened({
        model: mapPortfolioToDashboardViewModel(resource.activePortfolio),
        source: { kind, snapshotId: kind === "statement" ? resource.activeStatementSnapshotId : null },
      });
    } catch {
      if (current()) setError("Couldn’t open portfolio sharing. Try again.");
    } finally {
      if (generation.current === request) {
        pending.current = false;
        setLoading(false);
      }
    }
  }

  const verifiedAdvisorsOnly = audience === "verified_advisor";
  return (
    <div className="space-y-2">
      <p className="ui-text-row-label-emphasized">Share portfolio</p>
      {ready ? (
        <div className="flex flex-wrap items-center gap-2">
          <Button type="button" size="standard" variant="blue" disabled={loading} onClick={() => void openShare()}>
            {loading ? "Opening portfolio…" : verifiedAdvisorsOnly ? "Choose a verified advisor" : "Choose connections"}
          </Button>
          <FinanceSharingHistoryAction label="Manage sharing" hasPortfolio={false} />
        </div>
      ) : <p className="ui-text-row-description">Unlock your vault to share a portfolio.</p>}
      {error ? <p role="status" className="ui-text-row-description">{error}</p> : null}
      {opened && ready ? (
        <FinanceShareFlow {...opened} open requireActiveSource verifiedAdvisorsOnly={verifiedAdvisorsOnly}
          onOpenChange={open => { if (!open) setOpened(null); }} />
      ) : null}
    </div>
  );
}
