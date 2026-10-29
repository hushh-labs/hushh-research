"use client";

import { useMemo, useState } from "react";
import type { NativeDrawerRow, NativeDrawerSection, NativeProfilePage } from "@/lib/capacitor/native-drawers";
import { canInstallUpdate, releaseLabel, updateProgressStage } from "@/lib/feed/agent-update-status";
import { isOwnerCloudTarget, ownerCloudProvider } from "@/lib/one/owner-cloud";
import { AZURE_UPDATE_COPY, azureUpdatedLabel } from "@/lib/one/azure-update-outcome";
import { agentSettingsSummary, HOST_LABELS, type AgentSettingsController } from "./use-agent-settings-controller";
import { HOSTING_RECLAIMED_SENTENCE, HOSTING_UNCONFIRMED_SENTENCE, REBUILDING_SENTENCE, REBUILD_FAILED_FALLBACK } from "./azure-hosting-notice";

/** Presentation only. All network reads, approvals and retries belong to the
 * shared controller used by the established web panel. Offers/approval keys
 * stay in that controller; native receives authored labels and opaque handles. */
export function useNativeAgentSettings(model: AgentSettingsController, active: boolean, owner: string) {
  const visit = useMemo(() => ({ active, owner, kind: model.kind }), [active, owner, model.kind]);
  const [nested, setNested] = useState<{ visit: typeof visit; page: "notes" | "verification" | "browser-policy" } | null>(null);
  const local = nested?.visit === visit ? nested.page : null;
  const { status, update, mode, isPod, busy, working, browser } = model;
  const rows = new Map<string, () => void | Promise<void>>();
  const read = (id: string, label: string, detail?: string): NativeDrawerRow => ({ id, label, ...(detail ? { detail } : {}), enabled: true, readOnly: true });
  const action = (id: string, label: string, run: () => void | Promise<void>, disabled = false): NativeDrawerRow => {
    rows.set(id, () => { if (active && model.current() && !disabled) return run(); });
    return { id, label, enabled: !disabled, chevron: true };
  };
  const sections: NativeDrawerSection[] = [];
  const pages: NativeProfilePage[] = [];
  const website = "Continue on the Hussh website with your vault unlocked.";
  if (model.kind === "hosting") {
    const current: NativeDrawerRow[] = [read("hosting-current", "Current hosting", status ? HOST_LABELS[mode] : "Checking hosting…")];
    if (mode === "byoc" && status?.cloudProject) current.push(read("hosting-project", "Your cloud project", [status.cloudProject, status.cloudRegion].filter(Boolean).join(" · ")));
    if (model.inspection) {
      const health = model.inspection;
      current.push(read("hosting-health", "Cloud health", health.status === "connected" ? "Your agent’s cloud resources are available." :
        health.status === "starting" ? "Your agent is starting." : health.status === "absent" ? "Your cloud reports this agent is missing. Review Hosting recovery before creating another." :
        health.status === "cleanup_pending" ? "Cloud removal is paused or in progress. Resume its reviewed request." : "Your cloud could not be verified. Nothing was changed."));
      if (health.needsPreviousReview) current.push(read("hosting-previous", "Previous cloud homes", "An earlier cloud may still hold resources. Review those resources before removing hosting; this check never deletes them automatically."));
    }
    const azure = model.azureHosting;
    if (azure.running) current.push(read("hosting-rebuild", "Rebuilding", REBUILDING_SENTENCE));
    else if (azure.hosting?.rebuildable || azure.hosting?.rebuild?.status === "failed") {
      const hosting = azure.hosting;
      current.push(read("hosting-rebuild", "Azure hosting", hosting.rebuild?.status === "failed" ? hosting.rebuild.message ?? REBUILD_FAILED_FALLBACK :
        hosting.state === "hosting_reclaimed" ? HOSTING_RECLAIMED_SENTENCE : HOSTING_UNCONFIRMED_SENTENCE));
      if (hosting.rebuildable && hosting.rebuild?.retryable !== false) current.push(read("hosting-rebuild-website", "Rebuild hosting", website));
    }
    sections.push({ id: "hosting-status-section", rows: current });
    const canChoose = ["shared", "pending", "byoc", "unplaced"].includes(mode);
    sections.push({ id: "hosting-choices-section", title: "Hosting choices", rows: [
      { ...action("hosting-shared", "Hussh Shared", model.chooseHosting, mode !== "unplaced"), detail: mode === "byoc" ? "To switch, review and remove your current cloud below. Your Hussh account stays." : "Hussh runs and updates the shared service automatically.", ...(mode === "shared" ? { trailing: "Current" } : {}) },
      { ...action("hosting-own-cloud", "Bring your own cloud", model.chooseHosting, !canChoose), detail: "Agent One and device relay. You approve updates.", ...(mode === "byoc" ? { trailing: "Current" } : mode === "pending" ? { trailing: "Continue" } : {}) },
      { ...read("hosting-pods", "Hussh Pods", mode === "hussh_pods" ? "Your dedicated Hussh-hosted pod. You approve updates." : "Dedicated hosting is unavailable for new setups."), trailing: mode === "hussh_pods" ? "Current" : "Unavailable" },
    ] });
    const actions = [action("hosting-check", "Check hosting", model.checkStatus, busy)];
    if (mode === "byoc") actions.push(action("hosting-reconnect", model.needsLinkRecovery ? "Link existing pod" : "Reconnect your pod", model.needsLinkRecovery ? model.recoverExistingPod : model.reconnectDirectPod, busy));
    if (isOwnerCloudTarget(status?.deploymentTarget)) actions.push(read("hosting-removal", "Review cloud removal", website));
    sections.push({ id: "hosting-actions-section", rows: actions });
    if (model.notice) sections.push({ id: "hosting-outcome-section", rows: [read("hosting-outcome", model.notice)] });
    pages.push({ id: "hosting", title: "Hosting", sections });
  } else {
    const summary = agentSettingsSummary(model);
    const current = [read("updates-status", "Status", summary.stateLabel)];
    if (mode === "shared" || isPod) current.push(read("updates-version", isPod && !status?.installedReleaseVerified ? "Reported version" : "Current version", summary.versionLabel ?? "Not verified"));
    if (summary.release && update.available) current.push(read("updates-new-version", "New version", releaseLabel(summary.release.version, summary.release.releasedAt)));
    const stage = updateProgressStage(update);
    if (isPod && stage !== null) current.push({ ...read("updates-progress", "Update progress", summary.stateLabel), progress: { value: stage, total: 4 } });
    const progress = model.azureUpdate.progress;
    if (progress.kind !== "idle") current.push(read("updates-azure-progress", "Azure update", progress.kind === "updated" ? azureUpdatedLabel(progress.version, progress.releasedAt) :
      progress.kind === "failed" ? progress.message : progress.kind === "unconfirmed" ? AZURE_UPDATE_COPY.unconfirmed : progress.kind === "updating" ? progress.confirming ? AZURE_UPDATE_COPY.confirming : AZURE_UPDATE_COPY.running : website));
    if (model.awaitingMicrosoft || ownerCloudProvider(status?.deploymentTarget) === "azure" && update.failed) current.push(read("updates-microsoft", "Microsoft sign-in", website));
    sections.push({ id: "updates-status-section", rows: current });
    const actions: NativeDrawerRow[] = [];
    if (model.needsLinkRecovery) actions.push(action("updates-link", "Link existing pod", model.recoverExistingPod, busy));
    if (isPod && canInstallUpdate(status) && update.releaseId && !working) {
      actions.push(ownerCloudProvider(status?.deploymentTarget) === "azure" ? read("updates-approve", "Update now", website) : action("updates-approve", "Update now", () => model.act("approve"), busy), action("updates-later", "Later", () => model.act("defer"), busy));
    }
    actions.push(action("updates-check", "Check for updates", model.checkStatus, busy));
    if (isPod && update.failed && update.operationId) actions.push({ ...action("updates-report", "Send failure report", model.sendFailureReport, busy),
      detail: "Sends the update and release IDs and up to 12 lifecycle events. No pod logs, files or conversations." });
    if (summary.release && update.available) actions.push(action("updates-notes", "What’s in this update", () => setNested({ visit, page: "notes" })));
    if (isPod && (status?.releaseCheckedAt || status?.installedReleaseVerifiedAt)) actions.push(action("updates-verification", "Verification details", () => setNested({ visit, page: "verification" })));
    sections.push({ id: "updates-actions-section", rows: actions });
    if (model.notice) sections.push({ id: "updates-outcome-section", rows: [read("updates-outcome", model.notice)] });
    if (mode === "byoc" && isOwnerCloudTarget(status?.deploymentTarget) && status?.browserActivationAvailable) sections.push({ id: "updates-browser-section", title: "Browser", rows: [
      { ...action("updates-browser-review", "Review Browser setup", browser.inspect, browser.busy || busy || working), detail: "Research public pages with Agent One. Review access before enabling." },
      ...(!browser.review && browser.notice ? [read("updates-browser-outcome", browser.notice)] : []),
    ] });
    pages.push({ id: "software-updates", title: "Software updates", sections });
    if (browser.review) {
      const offer = browser.review.offer;
      pages.push({ id: "browser-review", title: "Browser setup", sections: [
        { id: "browser-review-summary", rows: [read("browser-summary", offer.summary), ...offer.changes.map((change, index) => read(`browser-change-${index}`, change)), read("browser-model", "Screen processing", offer.model)] },
        ...(offer.publicPolicy.interactive_origins?.length ? [{ id: "browser-websites-section", title: "Sign-in and website actions", rows: [
          ...offer.publicPolicy.interactive_origins.map((origin, index) => read(`browser-origin-${index}`, origin)),
          read("browser-approval-policy", "You handle sign-in. One asks before sharing information or submitting changes."),
        ] }] : []),
        { id: "browser-review-actions", rows: [action("browser-policy", "Allowed pages and assets", () => setNested({ visit, page: "browser-policy" })),
          action("browser-approve", "Approve Browser setup", browser.enable, browser.busy || busy || working), action("browser-cancel", "Not now", () => { browser.closeReview(); }, browser.busy)] },
        ...(browser.notice ? [{ id: "browser-outcome-section", rows: [read("browser-outcome", browser.notice)] }] : []),
      ] });
      if (local === "browser-policy") pages.push({ id: "browser-policy", title: "Allowed pages and assets", sections: [{ id: "browser-policy-section", rows: [
        ...offer.publicPolicy.page_urls.map((url, index) => read(`browser-page-${index}`, url)), ...offer.publicPolicy.static_prefixes.map((url, index) => read(`browser-assets-${index}`, url, "Assets")),
      ] }] });
    } else if (local === "notes" && summary.release) pages.push({ id: "update-notes", title: "What’s in this update", sections: [
      { id: "updates-summary-section", rows: [read("updates-summary", summary.release.summary)] },
      ...Object.entries(summary.release.notes).filter(([, entries]) => entries.length).map(([heading, entries], section) => ({ id: `updates-notes-${section}`, title: heading,
        rows: entries.map((text, index) => read(`updates-note-${section}-${index}`, text)) })),
    ] });
    else if (local === "verification") pages.push({ id: "update-verification", title: "Verification details", sections: [{ id: "updates-verification-section", rows: [
      ...(status?.releaseCheckedAt ? [read("updates-last-checked", "Last checked", new Date(status.releaseCheckedAt).toLocaleString())] : []),
      ...(status?.installedReleaseVerifiedAt ? [read("updates-install-verified", "Installation verified", new Date(status.installedReleaseVerifiedAt).toLocaleString())] : []),
    ] }] });
  }
  return { pages, rows, nested: pages.length > 1,
    navigationBlocked: () => model.busy || browser.busy,
    back: () => { if (model.busy || browser.busy) return true; if (local) { setNested(null); return true; } if (browser.review) { browser.closeReview(); return true; } return false; },
    root: () => { if (model.busy || browser.busy) return false; setNested(null); browser.closeReview(); return true; },
  };
}
