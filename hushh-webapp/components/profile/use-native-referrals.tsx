"use client";

import { useLayoutEffect, useState } from "react";
import { nativeDrawers, nativeDrawerAcknowledged, type NativeDrawerChoice, type NativeDrawerRow, type NativeDrawerSection, type NativeProfilePage } from "@/lib/capacitor/native-drawers";
import { NativeProfileTextEditor } from "./native-display-name-editor";
import { useReferralsPanelModel, type ReferralsPanelModel } from "./referrals-panel";

/** The existing in-pane feature, not the independent Referrals dashboard.
 * Server-owned counts and existing operations are shared with the web view. */
export function projectNativeReferrals(model: ReferralsPanelModel, editHandle: () => void) {
  const sections: NativeDrawerSection[] = [];
  const rows = new Map<string, (choice: NativeDrawerChoice) => void | Promise<void>>();
  const read = (id: string, label: string, detail?: string, trailing?: string, artworkId = "referral-success"): NativeDrawerRow =>
    ({ id, label, ...(detail ? { detail } : {}), ...(trailing ? { trailing } : {}), artworkId, enabled: true, readOnly: true });
  const action = (id: string, label: string, run: () => void | Promise<unknown>, extra: Partial<NativeDrawerRow> = {}): NativeDrawerRow => {
    rows.set(id, async () => { if (model.current()) await run(); });
    return { id, label, enabled: true, ...extra };
  };
  const { summary, gamification: g } = model;
  if (model.state === "error") {
    sections.push({ id: "referral-error", rows: [read("referral-unavailable", "Unable to load", "Check your connection.", undefined, "referral-warning"),
      action("referral-retry", "Try again", model.load)] });
  } else if (model.state === "loading" || !summary) {
    sections.push({ id: "referral-loading", rows: [read("referral-loading-row", "Loading…", undefined, undefined, "invite")] });
  } else {
    sections.push({ id: "referral-link", title: "Your link", rows: [read("referral-link-value", summary.slug, summary.link, undefined, "referral-link"),
      action("referral-copy", model.copyStatus === "copied" ? "Copied" : "Copy", () => undefined), action("referral-share", "Share", model.onShare),
      ...(model.copyStatus === "error" ? [read("referral-copy-error", "Could not copy", undefined, undefined, "referral-warning")] : [])] });
    rows.set("referral-copy", choice => model.current() ? model.onCopy(async link => {
      const plugin = nativeDrawers();
      if (!plugin.copyProfileReferralLink) return false;
      const receipt = await nativeDrawerAcknowledged(plugin.copyProfileReferralLink({ ...choice, link }));
      return receipt.copied === true;
    }) : undefined);
    sections.push({ id: "referral-how", title: "How it works", rows: [read("referral-join", "They join", undefined, undefined, "referral-join"), read("referral-agent", "Use an agent", undefined, undefined, "referral-agent"), read("referral-qualifies", "Referral qualifies", undefined, undefined, "referral-qualified")] });
    const viewer = g.leaderboard?.viewer ?? g.leaderboard?.entries.find(entry => entry.is_viewer);
    const overview = [read("referral-rank", "Overall rank", undefined, viewer ? `#${viewer.rank}` : "Not yet ranked"),
      read("referral-coins", "Coins", undefined, String(g.balance?.coins ?? "—"))];
    if (g.circleSelection?.circle_id) overview.push(read("referral-team", "Your team", "Raw qualified referrals, counted for your team",
      String(g.circleLeaderboard?.find(team => team.circle_id === g.circleSelection?.circle_id)?.contribution_count ?? 0), "referral-people"));
    sections.push({ id: "referral-overview", title: "Overview · All contributions carry forward", rows: overview });
    if (g.milestones) {
      const next = g.milestones.next_milestone;
      const milestone: NativeDrawerRow = next ? { ...read("referral-next", next.reward, undefined, `${next.progress}/${next.threshold}`, "referral-progress"),
        ...(next.threshold > 0 ? { progress: { value: Math.min(next.progress, next.threshold), total: next.threshold } } : {}) }
        : read("referral-next", "All milestones reached");
      sections.push({ id: "referral-rewards", title: "Your next reward", rows: [milestone,
        ...g.milestones.earned.map((item, index) => read(`referral-earned-${index}`, item.reward, "Earned"))] });
    }
    const engagement: NativeDrawerRow[] = [];
    if (g.engagement?.streak.current_run_days) engagement.push(read("referral-streak", "Dashboard streak", `${g.engagement.streak.current_run_days} consecutive days`, undefined, "referral-progress"));
    if (g.engagement?.flash.active) engagement.push(read("referral-flash", "Flash bonus is live", "Referrals qualifying now earn the configured coin boost"));
    if (engagement.length) sections.push({ id: "referral-engagement", title: "Keep it going", rows: engagement });
    if (g.handle === null) sections.push({ id: "referral-handle", title: "Appear on the leaderboard", rows: [
      read("referral-handle-description", "Choose a handle to show your rank to other referrers. Your real name is never shown."),
      action("referral-handle-edit", "Your leaderboard handle", editHandle, { chevron: true, artworkId: "referral-people" })] });
    if (g.leaderboard?.entries.length) sections.push({ id: "referral-leaderboard", title: "Leaderboard", rows: [
      ...(g.leaderboard.snapshot_generated_at ? [read("referral-as-of", `As of ${new Date(g.leaderboard.snapshot_generated_at).toLocaleString()}`)] : []),
      ...g.leaderboard.entries.map((entry, index) => read(`referral-rank-${index}`, `#${entry.rank} ${entry.handle}`, undefined, `${entry.points} coins`, entry.is_viewer ? "referral-success" : "referral-people")),
      ...(g.leaderboard.viewer ? [read("referral-viewer", `#${g.leaderboard.viewer.rank} ${g.leaderboard.viewer.handle} (you)`, undefined, `${g.leaderboard.viewer.points} coins`)] : [])] });
    if (g.circleLeaderboard?.length) sections.push({ id: "referral-team-leaderboard", title: "Team leaderboard",
      rows: g.circleLeaderboard.map((team, index) => read(`referral-team-${index}`, team.circle_name, undefined, String(team.contribution_count), "referral-people")) });
    sections.push({ id: "referral-counts", title: "Your referrals", rows: [
      read("referral-requirement", `${summary.required_active_minutes} active minutes · New users only`),
      read("referral-qualified", "Qualified", undefined, String(summary.qualified_count), "referral-qualified"),
      summary.in_progress_count > 0 ? action("referral-progress-open", "In progress", () => model.setShowProgress(value => !value),
        { trailing: String(summary.in_progress_count), chevron: true, artworkId: "referral-progress" }) : read("referral-in-progress", "In progress", undefined, "0", "referral-progress"),
      ...(summary.under_review_count > 0 ? [read("referral-review", "Under review", undefined, String(summary.under_review_count), "referral-review")] : [])] });
    if (model.showProgress) sections.push({ id: "referral-progress", title: "Progress", rows: [
      read("referral-progress-privacy", "Nobody is named. You see the step, not the person."),
      ...summary.referrals.filter(row => row.status === "In progress").map((row, index) => read(`referral-progress-${index}`, row.step,
        `${row.active_minutes} of ${row.required_minutes} active minutes · joined ${row.started_on}`, `${row.active_minutes}/${row.required_minutes}`, "referral-progress"))] });
    sections.push({ id: "referral-recent", title: summary.referrals.length ? "Recent" : undefined, rows: summary.referrals.length
      ? summary.referrals.slice(0, 10).map((row, index) => read(`referral-recent-${index}`, row.display_name ?? "Member", `${row.started_on} · ${row.step}`, row.status, "referral-join"))
      : [read("referral-empty", "No referrals yet", "Share your link to start.", undefined, "invite")] });
  }
  const page: NativeProfilePage = { id: "referrals", title: "Invite friends", sections };
  return { pages: [page], rows };
}

export function useNativeReferrals(active: boolean, uid: string | null) {
  const model = useReferralsPanelModel(active);
  const [editing, setEditing] = useState(false);
  useLayoutEffect(() => { if (!active) setEditing(false); }, [active]);
  const projection = projectNativeReferrals(model, () => setEditing(true));
  return { ...projection, model, formScene: editing && uid ? "referral-handle" as const : null,
    editor: (destinationId: string, onFallback: () => void) => editing && uid ?
    <NativeProfileTextEditor scene="referral-handle" destinationId={destinationId}
      model={{ uid, ready: model.current(), draft: model.handleInput, draftRevision: model.handleRevision(),
        changeDraft: model.changeHandle, canSave: !!model.handleInput.trim() && !model.handleSaving,
        saving: model.handleSaving, inlineError: model.handleErrorMessage }}
      save={async () => await model.onSaveHandle() ? { kind: "saved", value: undefined } : { kind: "retained" }}
      onCancel={() => setEditing(false)} onSaved={() => setEditing(false)} onWebFallback={onFallback} /> : null };
}
