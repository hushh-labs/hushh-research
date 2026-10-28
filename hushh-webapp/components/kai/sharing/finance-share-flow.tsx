"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { usePathname, useSearchParams } from "next/navigation";
import { KaiControlSurface } from "@/components/app-ui/kai-control-surface";
import { ShellActionSurface } from "@/components/app-ui/shell-action-surface";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { useBackLayer } from "@/lib/navigation/back-layers";
import { financeSections, projectFinance, projectAdvisorFinance, type FinanceOwnerConfig, type FinancePolicy, type FinanceProjection, type FinanceSelection, type FinanceSource } from "@/lib/finance-sharing/contract";
import { useFinanceShareContext } from "@/lib/finance-sharing/use-finance-share-context";
import { readSavedFinance } from "@/lib/finance-sharing/saved-source";
import { FinanceSharingService, pendingFinanceShare, type PreparedFinanceShare } from "@/lib/services/finance-sharing-service";
import type { OneLocationRecipient } from "@/lib/one-location/types";
import type { DashboardViewModel } from "@/components/kai/views/dashboard-data-mapper";
import { FinanceSharingPreview } from "./finance-sharing-preview";
import { FinanceSharingManager } from "./finance-sharing-manager";
import finance from "@/components/kai/shared/finance-workspace.module.css";
import styles from "./finance-sharing.module.css";

const sectionCopy = {
  allocation: ["Allocation", "Asset and sector percentages"],
  performance: ["Performance", "Saved balance history and period change"],
  holdings: ["Selected stocks", "Only the stocks you choose below"],
  note: ["Your note", "A message shared exactly as you write it"],
};

export function FinanceShareFlow({ open, onOpenChange, model, source, advisorOnly = false }: {
  open: boolean; onOpenChange: (value: boolean) => void; model: DashboardViewModel; source: FinanceSource; advisorOnly?: boolean;
}) {
  const { capture, session, ready } = useFinanceShareContext();
  const [step, setStep] = useState<"edit" | "review" | "sent">("edit");
  const [selection, setSelection] = useState<FinanceSelection>({ sections: ["allocation", "performance"], holdingSymbols: [], showAmounts: false, note: "" });
  const [mode, setMode] = useState<FinancePolicy["mode"]>("snapshot");
  const [duration, setDuration] = useState<FinancePolicy["durationSeconds"]>(86400);
  const [allowModel, setAllowModel] = useState(false);
  const [people, setPeople] = useState<OneLocationRecipient[]>([]);
  const [selected, setSelected] = useState<OneLocationRecipient[]>([]);
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(1);
  const [more, setMore] = useState(false);
  const [peopleBusy, setPeopleBusy] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<FinanceProjection | null>(null);
  const [config, setConfig] = useState<FinanceOwnerConfig | null>(null);
  const [manage, setManage] = useState(false);
  const [accessEnded, setAccessEnded] = useState(false);
  const prepared = useRef<PreparedFinanceShare | null>(null);
  const inFlight = useRef(false);
  const requestGeneration = useRef(0);
  const pathname = usePathname();
  const params = useSearchParams();
  useEffect(() => () => { requestGeneration.current++; inFlight.current = false; }, []);
  useBackLayer(pathname, open ? (step === "review" ? 2 : 1) : 0, () => {
    if (inFlight.current) return true;
    if (step === "review" && !prepared.current) setStep("edit"); else onOpenChange(false);
    return true;
  }, pathname === "/one/kai" ? { tab: params.get("tab") || "portfolio" } : undefined);
  useEffect(() => {
    requestGeneration.current++;
    inFlight.current = false;
    prepared.current = null; setPreview(null); setConfig(null); setSelected([]); setPeople([]); setQuery(""); setPage(1);
    setError(null); setBusy(false); setPeopleBusy(false); setStep("edit"); setManage(false); setAccessEnded(false);
    setSelection({ sections: advisorOnly ? ["allocation", "performance", "holdings"] : ["allocation", "performance"], holdingSymbols: [], showAmounts: advisorOnly, note: "" });
    setAllowModel(false); setMode("snapshot"); setDuration(86400);
  }, [session, open, advisorOnly]);
  useEffect(() => {
    if (!open) return;
    const hide = () => { if (document.hidden) { requestGeneration.current++; setPreview(null); setConfig(null); onOpenChange(false); } };
    document.addEventListener("visibilitychange", hide);
    return () => document.removeEventListener("visibilitychange", hide);
  }, [open, onOpenChange]);
  useEffect(() => {
    if (!open || !ready || step !== "edit") return;
    const context = capture();
    if (!context) return;
    let disposed = false;
    const timer = window.setTimeout(async () => {
      setPeopleBusy(true);
      try {
        const result = await FinanceSharingService.recipients(context, query, page);
        if (disposed || !context.isCurrent()) return;
        const items = result.items;
        setPeople(previous => page === 1 ? items : [...previous, ...items.filter(p => !previous.some(old => old.userId === p.userId))]);
        setMore(result.hasMore);
      } catch (e) { if (!disposed && context.isCurrent()) setError(e instanceof Error ? e.message : "Connections are unavailable."); }
      finally { if (!disposed && context.isCurrent()) setPeopleBusy(false); }
    }, query ? 250 : 0);
    return () => { disposed = true; window.clearTimeout(timer); };
  }, [advisorOnly, capture, open, page, query, ready, session, step]);
  const choices = useMemo(() => [...new Map(model.canonicalModel.positions.filter(p => p.identifierType === "ticker" && p.tickerSymbol).map(p => [p.tickerSymbol, p])).values()], [model]);
  const pendingConfirmation = pendingFinanceShare(ready ? capture() : null);
  const operationContext = () => {
    const base = capture(); if (!base) return null;
    const generation = requestGeneration.current;
    return { ...base, isCurrent: () => generation === requestGeneration.current && base.isCurrent() };
  };
  const chooseSection = (section: typeof financeSections[number], checked: boolean) => setSelection(s => ({ ...s, sections: checked ? [...s.sections, section] : s.sections.filter(v => v !== section) }));
  const review = async () => {
    if (inFlight.current || pendingConfirmation) return;
    const context = operationContext(); if (!context) return;
    inFlight.current = true;
    const generation = requestGeneration.current;
    setBusy(true); setError(null);
    try {
      if (!selected.length) throw new Error("Choose at least one connection.");
      const saved = await readSavedFinance(context, source, advisorOnly);
      const next = advisorOnly ? projectAdvisorFinance(saved.model, saved.portfolio, source) : projectFinance(saved.model, selection, source);
      if (!context.isCurrent() || requestGeneration.current !== generation) return;
      setConfig({ source: saved.source, sourceFence: saved.sourceFence, selection }); setPreview(next); setStep("review");
    } catch (e) { if (context.isCurrent() && requestGeneration.current === generation) setError(e instanceof Error ? e.message : "Review is unavailable."); }
    finally { if (requestGeneration.current === generation) { inFlight.current = false; if (context.isCurrent()) setBusy(false); } }
  };
  const share = async () => {
    if (inFlight.current) return;
    const context = operationContext(); if (!context || !config || !preview) return;
    inFlight.current = true;
    const generation = requestGeneration.current;
    setBusy(true); setError(null);
    try {
      if (!prepared.current) {
        const saved = await readSavedFinance(context, config.source, advisorOnly);
        const current = advisorOnly ? projectAdvisorFinance(saved.model, saved.portfolio, config.source) : projectFinance(saved.model, config.selection, config.source);
        if (saved.sourceFence !== config.sourceFence || JSON.stringify(current) !== JSON.stringify(preview)) throw new Error("Your saved portfolio changed. Go back and review the updated preview.");
        prepared.current = await FinanceSharingService.prepare(context, config, preview, {
          ...(advisorOnly ? { version: 2 as const, purpose: "verified_ria_review" as const, mode: "snapshot" as const,
            sections: selection.sections, showAmounts: true as const, model_processing: { version: 1 as const, allowed: false as const }, durationSeconds: duration ?? 86400 }
            : { version: 1 as const, mode, sections: selection.sections, showAmounts: selection.showAmounts,
              model_processing: { version: 1 as const, allowed: allowModel }, durationSeconds: duration }),
        }, selected);
      }
      if (requestGeneration.current !== generation) return;
      const receipt = await FinanceSharingService.publish(context, prepared.current);
      if (!context.isCurrent() || requestGeneration.current !== generation) return;
      if (receipt.items.length !== selected.length || receipt.items.some(g => g.requestId !== prepared.current?.requestId)) throw new Error("Delivery could not be verified. Check Manage sharing.");
      setAccessEnded(receipt.items.some(item => item.status !== "active"));
      setStep("sent");
      window.dispatchEvent(new Event("finance-sharing-changed"));
    } catch (e) { if (context.isCurrent() && requestGeneration.current === generation) { if (!pendingFinanceShare(context)) prepared.current = null; setError(e instanceof Error ? e.message : "Sharing could not be confirmed."); } }
    finally { if (requestGeneration.current === generation) { inFlight.current = false; if (context.isCurrent()) setBusy(false); } }
  };
  const retryPrevious = async () => {
    if (inFlight.current) return;
    const context = operationContext(); if (!context || !pendingConfirmation) return;
    inFlight.current = true; setBusy(true); setError(null);
    try { const receipt = await FinanceSharingService.publish(context, pendingConfirmation); if (context.isCurrent()) { setAccessEnded(receipt.items.some(item => item.status !== "active")); setStep("sent"); window.dispatchEvent(new Event("finance-sharing-changed")); } }
    catch (e) { if (context.isCurrent()) setError(e instanceof Error ? e.message : "Sharing could not be confirmed."); }
    finally { inFlight.current = false; if (context.isCurrent()) setBusy(false); }
  };
  return <>
    <KaiControlSurface open={open} onOpenChange={value => { if (!inFlight.current) onOpenChange(value); }} title={step === "sent" ? (accessEnded ? "Sharing ended" : "Finance shared") : step === "review" ? "Review before sharing" : advisorOnly ? "Ask an advisor" : "Share Finance"}
      description={step === "sent" ? (accessEnded ? "The confirmation is recorded, but some access has ended. Check Manage sharing." : "The confirmation is recorded. Manage sharing shows current access.") : "Choose who sees what. You stay in control."}
      desktopMaxWidthClassName="sm:!max-w-[min(1040px,calc(100vw-4.5rem))]"
      surfaceClassName={`${finance.detail} ${styles.surface}`} footer={<div className={styles.toolbar}>
        {step === "edit" ? <><ShellActionSurface variant="pill" onClick={() => setManage(true)}>Manage sharing</ShellActionSurface><ShellActionSurface variant="pill" disabled={busy || !ready || Boolean(pendingConfirmation)} onClick={() => void review()}>{busy ? "Preparing…" : "Preview"}</ShellActionSurface></>
          : step === "review" ? <><ShellActionSurface variant="pill" disabled={busy || Boolean(prepared.current)} onClick={() => setStep("edit")}>Back</ShellActionSurface><ShellActionSurface variant="pill" disabled={busy || !ready} onClick={() => void share()}>{busy ? "Sharing…" : prepared.current ? "Retry confirmation" : `Share with ${selected.length} ${selected.length === 1 ? "person" : "people"}`}</ShellActionSurface><ShellActionSurface variant="pill" disabled={busy} onClick={() => setManage(true)}>Manage sharing</ShellActionSurface></>
          : <><ShellActionSurface variant="pill" onClick={() => setManage(true)}>Manage sharing</ShellActionSurface><ShellActionSurface variant="pill" onClick={() => onOpenChange(false)}>Done</ShellActionSurface></>}
      </div>}>
      {error ? <p role="alert" className="mb-5 text-sm text-destructive">{error}</p> : null}
      {pendingConfirmation && step === "edit" ? <div className={`${styles.privacy} mb-5`}><p>A previous sharing confirmation is unresolved. Retrying uses the same confirmation and cannot create duplicate cards. You can also check Manage sharing.</p><ShellActionSurface variant="pill" disabled={busy} onClick={() => void retryPrevious()}>Retry previous confirmation</ShellActionSurface></div> : null}
      {!ready ? <p className={styles.privacy}>Unlock your vault to share Finance information.</p> : null}
      {step === "edit" ? <div className={styles.layout}><div className={styles.section}>
        <section className={styles.group}><h2 className={styles.heading}>Who can see it?</h2>
          {selected.length ? <div className="mt-3 flex flex-wrap gap-2">{selected.map(person => <button className={styles.chip} key={person.userId} onClick={() => setSelected(p => p.filter(r => r.userId !== person.userId))} aria-label={`Remove ${person.displayName}`}>{person.displayName} ×</button>)}</div> : null}
          <label className="mt-4 block"><span className="sr-only">Search connections</span><Input value={query} placeholder="Search your connections" onChange={e => { setQuery(e.target.value); setPage(1); }} /></label>
          <div aria-busy={peopleBusy}>{people.filter(person => !advisorOnly || person.isFinanceAdvisor).map(person => <label key={person.userId} className={styles.choice}><input type="checkbox" disabled={!person.keyId || !person.publicKeyJwk || (!selected.some(r => r.userId === person.userId) && selected.length >= 20)} checked={selected.some(r => r.userId === person.userId)} onChange={e => setSelected(p => e.target.checked ? [...p, person] : p.filter(r => r.userId !== person.userId))} /><span>{person.displayName}<small>{person.keyId && person.publicKeyJwk ? "Connected" : "Needs to unlock One before receiving"}</small></span></label>)}</div>
          {!peopleBusy && !people.some(person => !advisorOnly || person.isFinanceAdvisor) ? <p className="py-4 text-sm text-muted-foreground">{advisorOnly ? "No advisor connections found on this page." : "No matching connections. Connect with someone first."}</p> : null}
          {peopleBusy ? <p role="status" className={styles.caption}>Checking connections…</p> : null}
          {more ? <ShellActionSurface variant="pill" disabled={peopleBusy} onClick={() => setPage(p => p + 1)}>More connections</ShellActionSurface> : null}
        </section>
        {advisorOnly ? <section className={styles.group}><h2 className={styles.heading}>Portfolio for review</h2><p className={styles.caption}>The advisor can view the positions, cash, allocation and available history in the currently selected portfolio source. Other sources are not included. Linked values may be calculated from supplied quantities and prices; accounts without reported positions are not included. Connection and verification are checked when you share and when they open it. A blocked or disconnected person cannot receive it.</p></section> : <section className={styles.group}><h2 className={styles.heading}>What do you want to share?</h2>
          {financeSections.map(section => <label className={styles.choice} key={section}><input type="checkbox" checked={selection.sections.includes(section)} onChange={e => chooseSection(section, e.target.checked)} /><span>{sectionCopy[section][0]}<small>{sectionCopy[section][1]}</small></span></label>)}
          {selection.sections.includes("holdings") ? <fieldset className="mt-3 border-t border-border pt-3"><legend className={styles.caption}>Choose stocks</legend>{choices.map(p => <label key={p.id} className={styles.choice}><input type="checkbox" checked={selection.holdingSymbols.includes(p.tickerSymbol!)} onChange={e => setSelection(s => ({ ...s, holdingSymbols: e.target.checked ? [...s.holdingSymbols, p.tickerSymbol!] : s.holdingSymbols.filter(v => v !== p.tickerSymbol) }))} /><span>{p.tickerSymbol}<small>{p.name}</small></span></label>)}</fieldset> : null}
          {selection.sections.includes("note") ? <label className="mt-3 block text-sm">Your note<Textarea className="mt-2" value={selection.note} maxLength={1000} placeholder="Add context for your connection" onChange={e => setSelection(s => ({ ...s, note: e.target.value }))} /><span className={styles.caption}>Shared as written. Leave out anything you want to keep private.</span></label> : null}
        </section>}
      </div><div className={styles.section}>
        <section className={styles.group}><h2 className={`${styles.heading} mb-4`}>How should access work?</h2>{!advisorOnly ? <div className={styles.mode}>
          <button aria-pressed={mode === "snapshot"} onClick={() => { setMode("snapshot"); if (duration === null) setDuration(86400); }}>Snapshot<small>A fixed view of what you share today</small></button>
          <button aria-pressed={mode === "ongoing"} onClick={() => setMode("ongoing")}>Ongoing access<small>Updates from your saved portfolio</small></button>
        </div> : <p className={styles.caption}>A fixed snapshot, available for a limited time.</p>}<label className="mt-5 block text-sm">Access ends<select className="mt-2 min-h-11 w-full rounded-full border border-input bg-background px-4" value={duration === null ? "until_stopped" : duration} onChange={e => setDuration(e.target.value === "until_stopped" ? null : Number(e.target.value) as FinancePolicy["durationSeconds"])}><option value={3600}>In 1 hour</option><option value={86400}>In 1 day</option><option value={604800}>In 7 days</option>{mode === "ongoing" ? <option value="until_stopped">When I stop sharing</option> : null}</select></label>
          <p className={`${styles.caption} mt-2`}>The duration starts when sharing is confirmed.</p>
          {!advisorOnly ? <><label className={styles.choice}><input type="checkbox" checked={selection.showAmounts} onChange={e => setSelection(s => ({ ...s, showAmounts: e.target.checked }))} /><span>Show dollar amounts<small>Include balances and selected stock values</small></span></label>
          <label className={styles.choice}><input type="checkbox" checked={allowModel} onChange={e => setAllowModel(e.target.checked)} /><span>Allow their private agent to review<small>Only these shared sections, while access remains active</small></span></label></> : null}
        </section>
        <p className={styles.privacy}>Account identifiers and transaction records are excluded. {selection.showAmounts ? "Selected values are shown in USD." : "Structured balances, dollar gains and quantities are excluded."} {selection.sections.includes("note") ? "Your note is shared as written. " : ""}You can stop any person’s access in Manage sharing.</p>
        {mode === "ongoing" ? <p className={styles.privacy}>Updates publish from your saved information while One is open and your vault is unlocked. New accounts require a new review. Recipients see the last shared update.</p> : null}
      </div></div> : preview ? <div className={styles.layout}>
        <div><h2 className={`${styles.heading} mb-4`}>What they will see</h2><FinanceSharingPreview projection={preview} /></div>
        <div className={styles.section}><section className={styles.group}><h2 className={styles.heading}>{step === "sent" ? "Shared with" : "Ready to share with"}</h2>{selected.map(person => <p className={styles.row} key={person.userId}>{person.displayName}</p>)}
          <dl><div className={styles.row}><dt>Access</dt><dd>{mode === "snapshot" ? "Snapshot · stays fixed" : "Ongoing · saved updates"}</dd></div><div className={styles.row}><dt>Ends</dt><dd>{duration === null ? "When you stop sharing" : `After ${duration / (duration === 3600 ? 3600 : 86400)} ${duration === 3600 ? "hour" : duration === 86400 ? "day" : "days"}`}</dd></div><div className={styles.row}><dt>Dollar amounts</dt><dd>{selection.showAmounts ? "Included" : "Hidden"}</dd></div><div className={styles.row}><dt>Private-agent review</dt><dd>{allowModel ? "Allowed" : "Not allowed"}</dd></div></dl>
        </section>{advisorOnly ? <p className={styles.privacy}>This snapshot covers the selected portfolio source only. Other imported or linked sources are not included.</p> : null}<p className={styles.privacy}>Only the previewed information is shared. You can end each person’s access separately. Information they have already copied or saved cannot be recalled.</p></div>
      </div> : step === "sent" ? <p className="text-sm">{accessEnded ? "Some access has ended. Open Manage sharing to see each person’s current status." : "The original sharing confirmation is recorded. Open Manage sharing to see each person’s access and expiry."}</p> : null}
    </KaiControlSurface>
    <FinanceSharingManager open={manage} onOpenChange={setManage} />
  </>;
}
