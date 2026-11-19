"use client";

import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { SettingsDetailPanel } from "@/components/app-ui/settings-ui";
import { useFinanceShareContext } from "@/lib/finance-sharing/use-finance-share-context";
import { useBackLayer } from "@/lib/navigation/back-layers";
import { SharedAnalysisReportStore } from "@/lib/kai/shared-report-store";
import { invalidateSharedReports } from "@/lib/kai/shared-report-history";
import { KaiHistoryService } from "@/lib/services/kai-history-service";

export function ReportSyncSetup({ onReady }: { onReady: () => void }) {
  const { capture, ready, session } = useFinanceShareContext();
  const pending = useRef(false);
  const episode = useRef(0);
  useEffect(() => { episode.current++; pending.current = false; setBusy(false); setOpen(false); setStatus(""); }, [session]);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("");
  useBackLayer(typeof window !== "undefined" ? window.location.pathname : "/one/kai", open ? 2 : 0, () => { if (!busy) setOpen(false); return true; });
  async function enable() {
    const access = capture();
    if (!access?.isCurrent() || pending.current) return;
    pending.current = true;
    const request = episode.current;
    setBusy(true); setStatus("");
    try {
      await SharedAnalysisReportStore.open(access, true);
      await KaiHistoryService.publishPendingFeedResults(access, access.isCurrent);
      if (!access.isCurrent()) return;
      invalidateSharedReports();
      onReady(); setOpen(false);
    } catch (error) {
      if (access.isCurrent()) setStatus(error instanceof Error && error.message === "Report sync requires Shared storage."
        ? error.message : error instanceof Error && error.message === "FILES_KEY_RECOVERY_REQUIRED" ? "Your storage key needs recovery." : "Report sync couldn’t be enabled. Try again.");
    } finally { if (request === episode.current) { pending.current = false; setBusy(false); } }
  }
  return <><Button variant="ghost" size="sm" disabled={!ready} onClick={() => setOpen(true)}>Sync reports</Button>
    <SettingsDetailPanel open={open} onOpenChange={value => { if (!busy) setOpen(value); }}
      title="Sync reports" mobilePresentation="sheet" headerTextOverflow="wrap"
      footer={<Button disabled={busy || !ready} onClick={() => void enable()}>{busy ? "Enabling…" : "Enable sync"}</Button>}>
      <div className="space-y-3 px-4 pb-5 text-sm">
        <p>Keep encrypted reports across devices; moving hosting requires a storage transfer.</p>
        {status ? <p role="status" className="text-muted-foreground">{status}</p> : null}
      </div>
    </SettingsDetailPanel>
  </>;
}
