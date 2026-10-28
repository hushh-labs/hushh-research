"use client";

import { useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { AppPageShell } from "@/components/app-ui/app-page-shell";
import type { ReferralDashboardModel } from "./referral-dashboard-page";
import { useIndividualReferralRankings } from "./individual-referral-rankings";
import { useCircleWarsModel } from "@/components/profile/circle-wars-panel";
import { useCreateCircleFlow } from "@/components/one-location/redesign/circles/named-circle-flows";
import { VaultContext } from "@/lib/vault/vault-context";
import { nativeDrawers, nativeDrawerAcknowledged, type NativeDrawerRow, type NativeDrawerSection } from "@/lib/capacitor/native-drawers";
import { useNativeWorkspace, type NativeWorkspaceContent } from "@/lib/capacitor/use-native-workspace";
import type { NativeWorkspaceChoice } from "@/lib/capacitor/native-workspace";
import { unwindBackLayer } from "@/lib/navigation/back-layers";
import { ROUTES } from "@/lib/navigation/routes";
import { isValidatedAuthSessionOwnerCurrent, snapshotValidatedAuthSessionOwner } from "@/lib/auth/session-owner";
import { isAirPodsReward, rewardDisplayTitle, referralRewardBoard, referralClaimStatus } from "@/lib/referral/reward-presentation";

type RetirementOwner = { owner: string; revoke: () => Promise<boolean> };
class ReferralVisit {
  private live = false;
  readonly authority = snapshotValidatedAuthSessionOwner();
  private handles = new Map<string, string>();
  constructor(readonly owner: string) {}
  activate() { this.live = true; }
  current() { return this.live && !!this.authority && this.authority.userId === this.owner && isValidatedAuthSessionOwnerCurrent(this.authority); }
  handle(key: string) { let id = this.handles.get(key); if (!id) { id = crypto.randomUUID(); this.handles.set(key, id); } return id; }
  retire() { this.live = false; this.handles.clear(); }
}

/** Admission selects the whole route body before feature-model installation.
 * An unsupported wrapper never mounts a second Circle or ranking reader. */
export function NativeReferralWorkspace({ model, fallback }: { model: ReferralDashboardModel; fallback: ReactNode }) {
  const token = useContext(VaultContext)?.vaultOwnerToken;
  const [admitted, setAdmitted] = useState<boolean | null>(null);
  const [lifetime, setLifetime] = useState<RetirementOwner | null>(null);
  const [withdrawal, setWithdrawal] = useState<RetirementOwner | null>(null);
  const owner = model.userId;
  const unlocked = !!token;
  const invalidated = !!lifetime && (!unlocked || owner !== lifetime.owner);
  useLayoutEffect(() => { if (invalidated && lifetime && !withdrawal) setWithdrawal(lifetime); }, [invalidated, lifetime, withdrawal]);
  useLayoutEffect(() => {
    if (!withdrawal) return;
    let current = true;
    void withdrawal.revoke().then(absent => {
      if (current && absent) { setLifetime(previous => previous === withdrawal ? null : previous); setAdmitted(false); setWithdrawal(null); }
    });
    return () => { current = false; };
  }, [withdrawal]);
  const registerRetirement = useCallback((revoke: () => Promise<boolean>) => {
    if (owner) setLifetime({ owner, revoke });
  }, [owner]);
  useEffect(() => {
    let current = true;
    void nativeDrawerAcknowledged(nativeDrawers().getCapabilities()).then(value => {
      if (current) setAdmitted(value.contractVersion === 1 && value.supported && value.wholePresentation && value.routeWorkspaces?.includes("referrals") === true &&
        !!nativeDrawers().applyWorkspace && !!nativeDrawers().retireWorkspace && !!nativeDrawers().confirmWorkspaceChoice && !!nativeDrawers().settleWorkspaceChoice && !!nativeDrawers().getWorkspaceState);
    }).catch(() => { if (current) setAdmitted(false); });
    return () => { current = false; };
  }, []);
  if (invalidated || withdrawal) return <div aria-busy="true" />;
  if (admitted === false || !token || !model.user || !model.userId) return fallback;
  if (admitted === null) return <div aria-busy="true" />;
  return <NativeReferralBody key={`${model.userId}:unlocked`} model={model} token={token} onFallback={() => { setLifetime(null); setAdmitted(false); }}
    onRetirementOwner={registerRetirement} />;
}

function NativeReferralBody({ model, token, onFallback, onRetirementOwner }: { model: ReferralDashboardModel; token: string; onFallback: () => void; onRetirementOwner: (revoke: () => Promise<boolean>) => void }) {
  const owner = model.userId!;
  const contentFrame = useRef<HTMLDivElement>(null);
  const [visit] = useState(() => new ReferralVisit(owner));
  useLayoutEffect(() => { visit.activate(); return () => visit.retire(); }, [visit]);
  const current = useCallback(() => visit.current(), [visit]);
  const circles = useCircleWarsModel({ userId: owner, token, view: model.tab === "standings" && model.board === "circles" ? "leaderboard" : "card", refreshKey: model.circleRefresh });
  const ranking = useIndividualReferralRankings({ firstPage: model.leaderboardRes.status === "ready" ? model.leaderboardRes.data : null, user: model.user, onRefresh: model.reloadLeaderboard });
  const creation = useCreateCircleFlow({ active: circles.creating, busy: circles.busy, onSubmit: circles.create, onLoadPeople: circles.loadPeople,
    onAddPeople: circles.addPeople, onComplete: circles.finishCreate, pathname: ROUTES.ONE_REFERRALS, backLayerQuery: {} });
  const editing = circles.creating && creation.step === "details";
  const destination = useMemo(() => editing ? crypto.randomUUID() : null, [editing]);
  const [windowIndex, setWindowIndex] = useState(0);
  const actions = new Map<string, (choice: NativeWorkspaceChoice) => void | Promise<unknown>>();
  const id = (key: string) => visit.handle(key);
  const action = (key: string, label: string, callback: (choice: NativeWorkspaceChoice) => void | Promise<unknown>, extra: Partial<NativeDrawerRow> = {}): NativeDrawerRow => {
    const handle = id(key); actions.set(handle, choice => current() ? callback(choice) : undefined);
    return { id: handle, label, enabled: true, ...extra };
  };
  const read = (key: string, label: string, detail?: string): NativeDrawerRow => ({ id: id(key), label, ...(detail ? { detail } : {}), enabled: true, readOnly: true });
  const sections: NativeDrawerSection[] = [];
  const section = (key: string, rows: NativeDrawerRow[], title?: string) => { sections.push({ id: `referral-${key}`, ...(title ? { title } : {}), rows }); };
  const resource = <T,>(key: string, label: string, value: { status: "loading" } | { status: "error" } | { status: "ready"; data: T; refreshFailed?: boolean }, retry: () => void, ready: (data: T) => NativeDrawerRow[]) => {
    if (value.status === "loading") return [read(`${key}-loading`, `Loading ${label}…`)];
    if (value.status === "error") return [read(`${key}-unavailable`, `Unable to load ${label}.`), action(`${key}-retry`, "Try again", retry)];
    const rows = ready(value.data);
    if (value.refreshFailed) rows.push(action(`${key}-refresh`, "Unable to refresh. Showing the last update.", retry));
    return rows;
  };
  let page: NativeWorkspaceContent["page"] = "overview", title = "Referrals";
  let search: NativeWorkspaceContent["search"];
  const paged = (key: string, rows: NativeDrawerRow[]) => {
    const index = Math.min(windowIndex, Math.max(0, Math.ceil(rows.length / 40) - 1));
    const result = rows.slice(index * 40, (index + 1) * 40);
    if (index > 0) result.push(action(`${key}-previous`, "Previous", () => setWindowIndex(index - 1)));
    if ((index + 1) * 40 < rows.length) result.push(action(`${key}-more`, "More", () => setWindowIndex(index + 1)));
    return result;
  };
  if (circles.open) {
    if (circles.creating) {
      page = editing ? "circle-create" : "circle-people"; title = editing ? "Create a Circle" : "Add people";
      if (!editing) {
        const people = creation.people;
        section("people-actions", [
          action("people-add", `Add ${people.selected.length || "people"}`, () => people.finish(true), { enabled: !people.loading && !people.saving && people.selected.length > 0 && people.selected.length <= people.limit, pending: people.saving }),
          action("people-later", "Add people later", () => people.finish(false), { enabled: !people.saving }),
          read("people-count", `${people.selected.length} selected`, people.limit > 0 ? `Choose up to ${people.limit} people` : !people.loading && !people.failed ? "This Circle is full" : undefined),
        ]);
        const searchId = id("people-search");
        search = { id: searchId, query: people.query, label: "Search contacts" };
        actions.set(searchId, choice => { if (current() && typeof choice.text === "string" && choice.text.length <= 256) { setWindowIndex(0); people.changeQuery(choice.text); } });
        const rows = people.failed ? [read("people-error", "Could not load your contacts."), action("people-retry", "Try again", people.retry)] : people.loading && people.page === 1 ? [read("people-loading", "Loading contacts…")] : people.people.map(person =>
          action(`person:${person.userId}`, person.displayName, () => people.selected.includes(person.userId) ? people.remove(person.userId) : people.add(person.userId),
            { selected: people.selected.includes(person.userId), enabled: !people.saving && (people.selected.includes(person.userId) || people.selected.length < people.limit) }));
        if (!rows.length) rows.push(read("people-empty", people.query ? "No contacts match that name." : "No connections to add yet. You can add people later."));
        if (people.hasMore && !people.failed) rows.push(action("people-load-more", people.loading ? "Loading…" : "Load more contacts", people.more, { enabled: !people.loading && !people.saving }));
        section("people", paged("people", rows));
      }
    } else {
      page = "circle-picker"; title = "Choose your Circle";
      const rows = circles.circlesError ? [read("circles-error", "Could not load your Circles."), action("circles-retry", "Try loading Circles again", circles.loadCircles)] : circles.circles === null ? [read("circles-loading", "Loading your Circles…")] : circles.circles.map(circle =>
        action(`circle:${circle.id}`, circle.name, () => circles.select(circle.id), { detail: `${circle.memberCount} members`, selected: circles.selected === circle.id, enabled: !circles.busy }));
      if (circles.circles?.length === 0) rows.push(read("circles-empty", "You have no Circles yet."));
      section("circles", paged("circles", rows));
      section("circle-join", [action("circle-create", "Create New Circle", circles.openCreate, { enabled: !circles.busy, chevron: true }),
        read("circle-consent", "By joining, you choose one Circle for this week. Only your new qualified referrals after joining count. Your friends join separately."),
        action("circle-join", circles.busy ? "Joining…" : "Join with this Circle", circles.join, { enabled: !!circles.selected && !circles.busy, pending: circles.busy })]);
    }
  } else if (model.showHowItWorks) {
    page = "rules"; title = "How it works";
    section("rules", resource("rules", "referral rules", model.policyRes, model.reloadPolicy, policy => [
      read("rules-invite", "Invite a friend"), read("rules-setup", "They finish setup and use the private agent"), read("rules-earn", `Earn ${policy.points.qualified_referral_points} coins`),
      read("rules-circles", "Win with your circle", "Choose an existing Circle or create one, then explicitly join Circle Wars for the current week. Each member joins separately and chooses one Circle per week."),
      read("rules-qualification", "Qualified referrals", "Each new referral started after you join adds one team referral when it qualifies. Individual coins and lifetime rewards keep working independently. The weekly deadline follows the program timezone shown in Circle Wars."),
      read("rules-streak", "Keep your streak", `View your referral dashboard on ${policy.streak_rules.run_length_days} consecutive days · ${policy.streak_rules.bonus_points} coins`),
      ...(policy.flash_bonus_enabled !== false && policy.points.flash_window_total_points > 0 ? [read("rules-flash", "Flash boost", `Replaces ${policy.points.qualified_referral_points} coins when active · ${policy.points.flash_window_total_points} coins`)] : []),
      ...[["Referral activity", policy.points.referral_qualified_activity_total_points], ["Memory updates", policy.points.pkm_daily_points], ["Connection Builder", policy.points.connection_created_points], ["Agent usage", policy.points.agent_usage_points]].flatMap(([label, amount], index) => typeof amount === "number" && amount > 0 ? [read(`rules-activity-${index}`, String(label), `${amount} coins`)] : []),
    ]));
  } else {
    if (model.tab === "you") {
      section("invite", resource("summary", "your referrals", model.summaryRes, model.reloadSummary, summary => [
        read("invite-hero", "Good things grow together"), ...(model.link ? [action("invite-share", "Invite", model.onShare)] : []), read("invite-joined", "Referrals", String(summary.joined_count)),
      ]));
      section("progress", [
        ...resource("points", "coins", model.pointsRes, model.reloadPoints, value => [read("points-value", "Coins", value.coins.toLocaleString("en-IN"))]),
        ...resource("rank", "your rank", model.leaderboardRes, model.reloadLeaderboard, value => { const viewer = value.viewer ?? value.entries.find(entry => entry.is_viewer); return [read("rank-value", "Rank", viewer ? `#${viewer.rank}` : "—")]; }),
      ], "Your progress");
      const team = circles.data?.participation?.team;
      section("team", [
        ...(circles.error ? [action("team-retry", circles.data ? "Circle Wars could not refresh. Showing the last update." : "Circle Wars could not refresh.", circles.load)] : []),
        ...(!circles.data ? [read("team-loading", circles.error ? "Unable to load Circle Wars." : "Loading Circle Wars…")] : team ? [
          read("team-name", team.name, `Rank #${team.rank} · ${team.participating_members} participating members`), read("team-score", `${team.qualified_referrals} qualified referrals this week`, circles.movement || (team.next_rank !== null ? `You're ${team.referrals_to_next_rank} referrals away from Rank #${team.next_rank}!` : "Your Circle leads this week. Keep growing together.")),
          action("team-invite", "Invite Friends", model.onShare), action("team-ranking", "View Rankings", () => { model.setTab("standings"); model.setBoard("circles"); }),
        ] : circles.data.participation ? [read("team-unavailable", "Your Circle is unavailable", "Your weekly selection is saved. Check your Circle membership to see its details.")] : [read("team-intro", "Circle Wars. Rise together."), action("team-join", "Join Circle Wars", circles.chooseCircle, { chevron: true })]),
        ...(circles.data ? [read("team-deadline", circles.secondsRemaining <= 0 ? "New round starting" : `${Math.ceil(circles.secondsRemaining / 60)}m left`, circles.data.period.timezone)] : []),
      ], "Your circle");
    } else if (model.tab === "standings") {
      section("ranking-kind", [action("ranking-individual", "Individual", () => { model.setBoard("individual"); setWindowIndex(0); }, { selected: model.board === "individual" }), action("ranking-circles", "Circles", () => { model.setBoard("circles"); setWindowIndex(0); }, { selected: model.board === "circles" })]);
      if (model.board === "individual") {
        section("ranking", resource("ranking", "standings", model.leaderboardRes, model.reloadLeaderboard, () => {
          const data = ranking.data; if (!data) return [read("ranking-loading", "Loading standings…")];
          const rows = data.entries.map(entry => read(`rank:${data.snapshot_id}:${entry.rank}`, `#${entry.rank} ${entry.display_name ?? entry.handle}`, `${entry.points} coins${entry.is_viewer ? " · You" : ""}`));
          if (!rows.length) rows.push(read("ranking-empty", data.stale ? "Standings are unavailable." : "No entries yet."));
          if (ranking.viewer && !data.entries.some(entry => entry.is_viewer)) rows.push(action("ranking-me", `Your rank #${ranking.viewer.rank}`, () => ranking.loadPage(Math.floor((ranking.viewer!.rank - 1) / 10) * 10), { enabled: !ranking.busy }));
          if (ranking.failedCursor !== null) rows.push(action("ranking-retry", "Could not load that page. Try again", () => ranking.loadPage(ranking.failedCursor!), { enabled: !ranking.busy }));
          if (ranking.hasNewSnapshot) rows.push(action("ranking-latest", "Latest rankings", ranking.latest, { enabled: !ranking.busy }));
          if (ranking.cursor > 0) rows.push(action("ranking-previous", "Previous", () => ranking.loadPage(Math.max(0, ranking.cursor - 10)), { enabled: !ranking.busy }));
          if (data.next_after_rank != null) rows.push(action("ranking-next", "Next", () => ranking.loadPage(data.next_after_rank!), { enabled: !ranking.busy }));
          return rows;
        }));
      } else {
        const board = circles.board;
        const rows = board?.teams.map(team => read(`team:${board.period.round_id}:${team.team_key}`, `#${team.rank} ${team.name}`, `${team.qualified_referrals} referrals · ${team.participating_members} participating members${team.is_your_circle ? " · Your circle" : ""}`)) ?? [];
        if (!rows.length) rows.push(read("teams-empty", circles.error ? "Circle rankings could not refresh." : board ? "No Circle rankings yet." : "Loading Circle rankings…"));
        if (circles.error) rows.push(action("teams-retry", "Try again", circles.load));
        if ((board?.offset ?? 0) > 0) rows.push(action("teams-previous", "Previous", circles.previousPage, { enabled: !circles.refreshing }));
        if (board?.has_more) rows.push(action("teams-next", "Next", circles.nextPage, { enabled: !circles.refreshing }));
        section("ranked-circles", rows, "Circle rankings");
      }
    } else {
      section("rewards", resource("rewards", "your reward progress", model.milestonesRes, model.reloadMilestones, data => {
        const board = referralRewardBoard(data);
        if (!board)
          return [read("rewards-policy", "Rewards policy unavailable", "Rewards are not available yet. Your progress is saved.")];
        const earned = board.earnedByKey;
        const rows: NativeDrawerRow[] = [read("rewards-progress", `${data.joined_referral_count} joined referrals`)];
        if (board.next && !isAirPodsReward(board.next.reward)) rows.push(read("rewards-next", rewardDisplayTitle(board.nextLabel[0] ?? board.next.reward),
          board.awaitingAward ? "Your reward is being confirmed." : `${board.next.progress} / ${board.next.threshold} referrals`));
        if (!board.next && board.finalReward) rows.push(read("rewards-completed", "All milestones reached", "Rewards become claimable after qualification and review."));
        const entries = board.ladder;
        for (const entry of entries) {
          const saved = earned.get(entry.milestone_key), reward = saved?.reward ?? entry.reward;
          rows.push(read(`reward:${entry.milestone_key}`, rewardDisplayTitle(reward.split(/,?\s+worth\s+/i)[0] ?? reward), saved ? `Unlocked at ${entry.threshold}` : `${entry.threshold} referrals`));
        }
        for (const saved of data.earned) {
          if (isAirPodsReward(saved.reward)) continue;
          if (!entries.some(item => item.milestone_key === saved.milestone_key)) rows.push(read(`previous-reward:${saved.milestone_key}`, saved.reward));
          if (saved.claimed_at) {
            rows.push(read(`claimed:${saved.milestone_key}`, referralClaimStatus(saved)));
          } else rows.push(action(`claim:${saved.milestone_key}`, "Claim reward", () => model.claims.claim(saved.milestone_key), { enabled: model.claims.state[saved.milestone_key] !== "saving", pending: model.claims.state[saved.milestone_key] === "saving" }));
          if (model.claims.state[saved.milestone_key] === "error") rows.push(read(`claim-error:${saved.milestone_key}`, "Unable to claim. Refresh your rewards and try again."));
        }
        return paged("rewards", rows);
      }));
    }
    section("help", [action("rules", "How it works", () => model.setShowHowItWorks(true), { chevron: true })]);
  }
  const tabs = page === "overview" ? { label: "Referrals", options: ([['you','You'],['standings','Ranking'],['rewards','Rewards']] as const).map(([value,label]) => {
    const handle = id(`tab:${value}`); actions.set(handle, () => { if (current()) { model.setTab(value); setWindowIndex(0); } }); return { id: handle, label, selected: model.tab === value };
  }) } : undefined;
  const content: NativeWorkspaceContent = { workspace: "referrals", title, page, sections, enabled: true,
    backEnabled: page !== "overview" && !circles.busy && !creation.saving && !creation.addingPeople, ...(tabs ? { tabs } : {}), ...(search ? { search } : {}) };
  const editor = destination ? { destinationId: destination, current: creation.current, inputRevision: creation.inputRevision, mutationPending: creation.mutationPending,
    draft: { name: creation.name, kind: creation.kind }, changeDraft: creation.changeDraft, busy: circles.busy || creation.saving, canSave: creation.canSubmit,
    error: creation.error, save: creation.prepare, onSaved: creation.advance, onCancel: circles.backToCircles } : undefined;
  const phase = useNativeWorkspace({ owner, content, actions, current, editor, onRetirementOwner, contentFrame, back: () => { if (current()) unwindBackLayer(ROUTES.ONE_REFERRALS); } });
  useEffect(() => { if (phase === "web") onFallback(); }, [phase, onFallback]);
  return <AppPageShell as="div" ref={contentFrame} width="agent" aria-busy={phase === "checking"} data-native-referral-workspace={phase}
    nativeTest={{ routeId: ROUTES.ONE_REFERRALS, marker: phase === "native" ? "native-route-one-referrals" : "native-referral-admission", authState: "authenticated",
      dataState: phase === "blocked" ? "error" : phase !== "native" ? "booting" : model.summaryRes.status === "loading" ? "loading" : model.summaryRes.status === "error" ? "unavailable-valid" : "loaded",
      errorCode: phase === "blocked" ? "NATIVE_WORKSPACE_ADMISSION_UNCERTAIN" : null }} />;
}
