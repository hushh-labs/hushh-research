"use client";

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useSyncExternalStore, type SetStateAction } from "react";
import { snapshotVaultSessionEpoch, subscribeVaultSessionEpoch } from "@/lib/vault/session-epoch";
import { useWorldModelOwnerState as useWorldModelSessionState } from "./world-model-owner-state";
import { usePathname, useSearchParams } from "next/navigation";
import {
  AppPageShell,
  AppPageHeaderRegion,
  AppPageContentRegion,
} from "@/components/app-ui/app-page-shell";
import { PageHeader } from "@/components/app-ui/page-sections";
import { SurfaceStack } from "@/components/app-ui/surfaces";
import { HelperText } from "@/components/app-ui/typography";
import {
  ProfileInnerReviewIcon,
  ProfileInnerSuccessIcon,
  ProfileInnerWarningIcon,
} from "@/components/profile/profile-inner-icons";
import {
  ProfilePaneGlobeIcon,
  ProfilePaneSearchIcon,
  ProfilePaneWorldModelIcon,
} from "@/components/profile/profile-pane-icons";
import { useWorldModelResearch } from "@/components/profile/world-model-provider";
import { pwmProviderDisclosure, usesAzurePwm } from "@/components/onboarding/setup/pwm-research-disclosure";
import { WorldModelClaimInvitation } from "@/components/profile/world-model-claim-invitation";
import { WorldModelFactRow } from "@/components/profile/world-model-fact-row";
import {
  WorldModelFactSheet,
  type WorldModelDraftFact,
  type WorldModelFactActions,
  type WorldModelFactDetail,
} from "@/components/profile/world-model-fact-sheet";
import { WorldModelOptions } from "@/components/profile/world-model-options";
import { AzureGroundedAnswer } from "@/components/profile/world-model-azure-grounded-answer";
import {
  LONG_STALL_MS,
  WorldModelIdentityGroup,
  WorldModelProgressRows,
  activityLine,
  identityGroupTitle,
  identityNotice,
  preparingStepLine,
  updatedLabel,
  useReadingSources,
} from "@/components/profile/world-model-progress";
import { SearchSuggestions } from "@/components/profile/world-model-search-suggestions";
import {
  SettingsGroup,
  SettingsPresentationProvider,
  SettingsRow,
} from "@/components/profile/settings-ui";
import { Button } from "@/lib/morphy-ux/button";
import { publicProfileUrls } from "@/lib/world-model/public-profile-urls";
import { useAuth } from "@/lib/firebase/auth-context";
import { useVault } from "@/lib/vault/vault-context";
import { useCoarseClock } from "@/lib/perf/use-periodic-task";
import { ROUTES } from "@/lib/navigation/routes";
import { resolveProfilePaneUrlState } from "@/lib/navigation/profile-pane";
import { resolveProfileRouteState } from "@/lib/navigation/profile-routes";
import { createAgentPkmCaptureGuard } from "@/lib/agent/agent-pkm-capture-runtime";
import { usePkmDomainChangeRevision } from "@/lib/pkm/use-pkm-domain-change-revision";
import { MARKDOWN_MEMORY_DOMAIN } from "@/lib/pkm/markdown-memory";
import {
  PWM_SECTIONS,
  WorldModelDecisionService,
  pwmClaimKey,
  pwmSectionForTopic,
  type PwmMemory,
  type PwmMemoryAuthority,
} from "@/lib/services/world-model-decision-service";
import {
  WorldModelResearchService,
  type PwmPreferences,
  type PwmProgress,
  type PwmResult,
  type PwmValidatedFact,
} from "@/lib/services/world-model-research-service";
import {
  PersonalWorldModelService,
  type WorldModelFact,
} from "@/lib/services/personal-world-model-service";

type Offered = Extract<PwmResult, { status: "offered" }>;
type StatusKind =
  | "loading"
  | "checking"
  | "preparing"
  | "ready"
  | "done"
  | "nothing"
  | "off"
  | "failed"
  /** Research's own service is unreachable; it is asked again after a wait. */
  | "outage"
  /** This check reached its limit; only an explicit new check can start. */
  | "exhausted"
  | "insufficient"
  | "not_ready"
  | "disabled";
/**
 * The status row: always a title and a line under it, whatever the state.
 * `detail` is a ticking count shown beside the line and never announced.
 */
type StatusCopy = { kind: StatusKind; title: string; body: string; detail?: string | null };

const STATUS_ICON = {
  loading: ProfilePaneWorldModelIcon,
  checking: ProfilePaneWorldModelIcon,
  preparing: ProfilePaneWorldModelIcon,
  ready: ProfileInnerReviewIcon,
  done: ProfileInnerSuccessIcon,
  nothing: ProfileInnerSuccessIcon,
  off: ProfilePaneSearchIcon,
  failed: ProfileInnerWarningIcon,
  outage: ProfileInnerWarningIcon,
  exhausted: ProfilePaneSearchIcon,
  insufficient: ProfileInnerWarningIcon,
  not_ready: ProfileInnerWarningIcon,
  disabled: ProfileInnerWarningIcon,
} as const;

const MINUTE_MS = 60_000;
/** Under this, the wait reads as minutes; past it, as a time of day. */
const RELATIVE_WAIT_MS = 10 * MINUTE_MS;

/**
 * When research is asked again after a wait, as the owner reads it. The
 * deadline is the store's, anchored to when the answer arrived, so a reopened
 * pane shows the true remaining time; no deadline means the wait is over.
 */
function retryLine(retryAt: number | null, now: number): string {
  if (retryAt === null) return "You can try again now.";
  const remaining = retryAt - now;
  if (remaining <= 0) return "You can try again now.";
  if (remaining < RELATIVE_WAIT_MS) {
    const minutes = Math.max(1, Math.ceil(remaining / MINUTE_MS));
    return `It will try again in about ${minutes} ${minutes === 1 ? "minute" : "minutes"}.`;
  }
  const at = new Date(retryAt).toLocaleTimeString([], {
    hour: "numeric",
    minute: "2-digit",
  });
  return `It will try again at ${at}.`;
}

function statusCopy(input: {
  ready: boolean;
  loading: boolean;
  sessionVerificationRequired: boolean;
  mounted: boolean;
  result: PwmResult | null;
  failed: boolean;
  retrying: boolean;
  preferences: PwmPreferences | null;
  memoryReady: boolean;
  /** Statements in the offered report, decided or not. */
  found: number;
  undecided: number;
  saved: number;
  /** A last progress update is available after research stopped. */
  checkpoint: boolean;
  /** The step line while research runs; never empty. */
  stepLine: string;
  stalled: boolean;
  /** The count beside the step line, when there is one. */
  stepDetail: string | null;
  /** True when research named a wait before it can be asked again. */
  waiting: boolean;
  /** When that wait ends, as Date.now(), from the store; null once unknown. */
  retryAt: number | null;
  now: number;
}): StatusCopy {
  const { result, found, undecided, saved } = input;
  if (!input.ready) {
    if (input.loading)
      return { kind: "loading", title: "Opening your profile…", body: "This only takes a moment." };
    if (input.sessionVerificationRequired)
      return { kind: "loading", title: "Reconnect your account", body: "Then your model opens here." };
    return {
      kind: "loading",
      title: "Unlock your vault",
      body: "Your model opens once your vault is unlocked.",
    };
  }
  if (input.retrying)
    return {
      kind: "checking",
      title: "Retrying research…",
      body: input.checkpoint
        ? "Checking the last research checkpoint."
        : "Connecting to the research service.",
    };
  if (result?.status === "unavailable" && input.waiting) {
    const line = retryLine(input.retryAt, input.now);
    // Only an unreachable research service is named; any other wait is a
    // short break, and asking again before it ends would only repeat it.
    return result.reason === "provider_unavailable"
      ? {
          kind: "outage",
          title: "Public search is paused right now",
          body: `Your private agent can’t reach its research service. ${line}`,
        }
      : { kind: "outage", title: "Research is taking a short break", body: line };
  }
  if (result?.status === "unavailable" && result.research_exhausted)
    return {
      kind: "exhausted",
      title: "This check has ended",
      body: "Open Research and email to start a new check.",
    };
  if (input.failed || result?.status === "unavailable")
    return {
      kind: "failed",
      title: "Couldn’t finish preparing your model",
      body: input.saved > 0
        ? "Your saved details remain below. Try again to finish this research."
        : input.checkpoint
          ? "The last research checkpoint is below. Try again to finish."
          : "Try again in a few minutes.",
    };
  if (
    result?.status === "consent_required" ||
    (!result && input.preferences?.enabled === false)
  )
    return {
      kind: "off",
      title: "Public research is off",
      body: "Turn it on and your private agent will look for public pages about you.",
    };
  // Before the app-level reader attaches, or before its first read lands.
  if (!input.mounted || !result)
    return { kind: "checking", title: "Checking your model…", body: "This only takes a moment." };
  switch (result.status) {
    case "pending":
    case "paused":
      if (input.stalled)
        return {
          kind: "preparing",
          title: "Research hasn't updated",
          body: "Try again to check for new results.",
        };
      return {
        kind: "preparing",
        title: "Preparing your model",
        body: input.stepLine,
        detail: input.stepDetail,
      };
    case "insufficient_identity":
      return {
        kind: "insufficient",
        title: "Add your name and a verified email or phone",
        body: "They help tell you apart from people with the same name.",
      };
    case "not_ready":
      return {
        kind: "not_ready",
        title: "Finish setup to prepare your model",
        body: "Your model is ready once setup is complete.",
      };
    case "disabled":
      return {
        kind: "disabled",
        title: "Not available right now",
        body: "Check back later.",
      };
  }
  if (!input.memoryReady)
    return { kind: "checking", title: "Checking your model…", body: "This only takes a moment." };
  if (undecided > 0)
    return {
      kind: "ready",
      title: "Ready to review",
      body: `${undecided} ${undecided === 1 ? "detail" : "details"} to confirm.`,
    };
  // Everything found is decided, even when every answer was No.
  if (saved > 0 || (result.status === "offered" && found > 0))
    return {
      kind: "done",
      title: "Up to date",
      body: "You’ve reviewed everything found so far. We’ll check public pages again in a few days.",
    };
  // "saved" means no draft is active: the last one aged out or was cleared.
  if (result.status === "saved")
    return {
      kind: "nothing",
      title: "Nothing to review right now",
      body: "We’ll check public pages again in a few days.",
    };
  // Reviewed statements can all be duplicates or unsuitable without changing
  // the separately assessed identity result.
  if (result.status === "offered" && result.report.match_status !== "no_match")
    return {
      kind: "nothing",
      title: "No new details to review",
      body: "We checked the public findings and found no new personal details to offer.",
    };
  // Only an offered report with no statements at all. People with the owner's
  // name may have turned up without any of them confirmed as the owner.
  const namesakes = result.status === "offered" ? result.research.candidates.length : 0;
  if (namesakes > 0)
    return {
      kind: "nothing",
      title: "Nothing to review yet",
      body: `${namesakes} possible ${namesakes === 1 ? "match" : "matches"} found, none confirmed as you.`,
    };
  return {
    kind: "nothing",
    title: "Nothing to review yet",
    body: "We couldn’t find public pages we can confidently connect to you. You can check again later.",
  };
}

/** Where a statement was found, or why a doubtful one has no page; never blank. */
function draftMeta(fact: WorldModelDraftFact): string {
  const [first, ...rest] = fact.sources;
  const rating = fact.evidenceScore ? " · Check source" : "";
  if (!first?.title)
    return fact.matchStatus === "matched"
      ? `Found on a public page${rating}`
      : `May be about someone with your name${rating}`;
  return `${rest.length > 0 ? `${first.title} and ${rest.length} more` : first.title}${rating}`;
}

/** Yes buttons of statements still waiting for the owner, in page order. */
function yesButtons(inPage: HTMLElement | null) {
  return [
    ...(inPage
      ?.closest("[data-pwm-page]")
      ?.querySelectorAll<HTMLButtonElement>("button[data-pwm-fact-yes]") ?? []),
  ];
}

export type PersonalWorldModelPageOptions = {
  embedded?: boolean;
  onManageDetails?: () => void;
  onOpenAccount?: () => void;
};

type WorldModelSession = { live: boolean; generation: number; decisions: Set<string>; preferencePending: boolean;
  enabled: boolean; owner: string | null; key: string | null; token: string | null; epoch: number };
const EMPTY_WORLD_MODEL_KEYS: ReadonlySet<string> = new Set();
const EMPTY_VALIDATED_FACTS: readonly PwmValidatedFact[] = [];

/** One feature controller below the existing app-level research reader. Its
 * private owner/session values never belong in a native presentation payload. */
export function usePersonalWorldModelModel({ embedded = false, enabled = true }: { embedded?: boolean; enabled?: boolean } = {}) {
  const pathname = usePathname() || ROUTES.PROFILE_WORLD_MODEL;
  const searchParams = useSearchParams();
  const paneState = resolveProfilePaneUrlState(searchParams);
  const present =
    !embedded ||
    (paneState.open
      ? paneState.location.panel === "world-model"
      : resolveProfileRouteState(pathname, searchParams).panel === "world-model");
  const { user, loading, sessionVerificationRequired, phoneNumber } = useAuth();
  const { vaultKey, vaultOwnerToken, isVaultUnlocked, tokenExpiresAt } =
    useVault();
  // mounted is false only while no app-level reader is attached. retryAt is
  // when a named wait ends, anchored by the store when the answer arrived;
  // the store owns the retry itself.
  const {
    mounted,
    result,
    preferences,
    failed,
    retrying,
    progress,
    validatedFacts,
    live,
    lastActivityAt,
    retryAt,
    reload: reloadResearch,
    refresh: refreshResearch,
    researchPublicProfiles: researchProfiles,
  } = useWorldModelResearch(enabled);
  const ready = Boolean(
    enabled && !loading &&
    user &&
    !sessionVerificationRequired &&
    isVaultUnlocked &&
    vaultKey &&
    vaultOwnerToken &&
    (tokenExpiresAt === null || Date.now() < tokenExpiresAt),
  );
  const epoch = useSyncExternalStore(subscribeVaultSessionEpoch, snapshotVaultSessionEpoch, () => 0);
  const session = useMemo<WorldModelSession>(() => ({ live: false, generation: 0, decisions: new Set(), preferencePending: false,
    enabled: ready, owner: user?.uid ?? null, key: vaultKey, token: vaultOwnerToken, epoch }),
    [ready, user?.uid, vaultKey, vaultOwnerToken, epoch]);
  const scope = useMemo(() => ({ live: false, controller: null as AbortController | null, session, present }), [session, present]);
  useLayoutEffect(() => { session.live = ready; return () => { session.live = false; session.decisions.clear(); }; }, [session, ready]);
  useLayoutEffect(() => {
    scope.live = ready && present; scope.controller = new AbortController();
    return () => { scope.live = false; scope.controller?.abort(); scope.controller = null; };
  }, [scope, ready, present]);
  const [loaded, setLoaded] = useWorldModelSessionState<{
    owner: string;
    key: string;
    memory: PwmMemory;
  } | null>(session, null);
  const [readFailed, setReadFailed] = useWorldModelSessionState(session, false);
  // Details saved through "Add a public source" keep their own encrypted records.
  const [sourced, setSourced] = useWorldModelSessionState<{
    owner: string;
    key: string;
    facts: WorldModelFact[];
  } | null>(session, null);
  const [readRevision, setReadRevision] = useWorldModelSessionState(session, 0);
  // Each claim moves the inviter's preview into this owner's sources.
  const [claims, setClaims] = useWorldModelSessionState(session, 0);
  const [findMoreRequest, setFindMoreRequest] = useWorldModelSessionState(session, 0);
  const refreshAllowed = useRef(false);
  const [keyed, setKeyed] = useWorldModelSessionState<{
    source: Offered | readonly PwmValidatedFact[];
    facts: WorldModelDraftFact[];
  } | null>(session, null);
  const [pending, setPending] = useWorldModelSessionState(session, EMPTY_WORLD_MODEL_KEYS);
  const [errors, setErrors] = useWorldModelSessionState(session, EMPTY_WORLD_MODEL_KEYS);
  const [detail, setDetailState] = useWorldModelSessionState<WorldModelFactDetail | null>(session, null);
  const [preferenceBusy, setPreferenceBusy] = useWorldModelSessionState(session, false);
  const [preferenceFailed, setPreferenceFailed] = useWorldModelSessionState(session, false);
  const statusRegion = useRef<HTMLElement>(null);
  // Set when a decision commits: statements after it, in page order.
  const [focusAfter, setFocusAfter] = useWorldModelSessionState<{
    later: readonly string[];
  } | null>(session, null);
  const revision = usePkmDomainChangeRevision(ready ? user?.uid : null, MARKDOWN_MEMORY_DOMAIN);
  const authority = useRef({
    ready: ready && present, scope,
    owner: user?.uid,
    key: vaultKey,
    token: vaultOwnerToken,
  });
  authority.current = {
    ready: ready && present, scope,
    owner: user?.uid,
    key: vaultKey,
    token: vaultOwnerToken,
  };
  const scopeCurrent = useCallback(() => scope.live && session.live && authority.current.scope === scope, [scope, session]);
  const setDetail = useCallback((value: SetStateAction<WorldModelFactDetail | null>) => {
    if (scopeCurrent()) setDetailState(value);
  }, [scopeCurrent, setDetailState]);
  const reload = useCallback((confirmed?: PwmPreferences) => { if (scopeCurrent()) reloadResearch(confirmed); }, [scopeCurrent, reloadResearch]);
  const refresh = useCallback(() => {
    if (!scopeCurrent() || !refreshAllowed.current || session.decisions.size) return;
    refreshAllowed.current = false;
    refreshResearch();
  }, [scopeCurrent, refreshResearch, session]);
  const researchPublicProfiles = useCallback((urls: readonly string[]) => {
    if (!scopeCurrent() || !refreshAllowed.current || session.decisions.size) return;
    refreshAllowed.current = false;
    researchProfiles(urls);
  }, [scopeCurrent, researchProfiles, session]);
  const memory =
    ready && loaded && loaded.owner === user?.uid && loaded.key === vaultKey
      ? loaded.memory
      : null;
  const sourcedFacts =
    ready && sourced && sourced.owner === user?.uid && sourced.key === vaultKey
      ? sourced.facts
      : [];

  const ownerAuthority = useCallback(() => {
    const { enabled: isReady, owner, key, token } = session;
    if (!isReady || !owner || !key || !token || !scopeCurrent() || !scope.controller) return null;
    const guard = createAgentPkmCaptureGuard({
      userId: owner,
      signal: scope.controller.signal,
      isEnabled: () =>
        scopeCurrent() && authority.current.ready &&
        authority.current.owner === owner &&
        authority.current.key === key &&
        authority.current.token === token,
    });
    return {
      authority: {
        userId: owner,
        vaultKey: key,
        vaultOwnerToken: token,
        assertCurrent: guard.assertCurrent,
      } satisfies PwmMemoryAuthority,
      isCurrent: guard.isCurrent,
    };
  }, [scopeCurrent, scope, session]);

  const ownerId = user?.uid;
  useEffect(() => {
    if (!ready || !ownerId || !vaultKey || !vaultOwnerToken || !mounted) {
      setSourced(null);
      return;
    }
    if (!present) return;
    const owner = ownerId;
    const controller = new AbortController();
    const guard = createAgentPkmCaptureGuard({
      userId: owner,
      signal: controller.signal,
      isEnabled: () =>
        scopeCurrent() && authority.current.ready &&
        authority.current.owner === owner &&
        authority.current.key === vaultKey &&
        authority.current.token === vaultOwnerToken,
    });
    // Best effort: these details are secondary and never block the model.
    void PersonalWorldModelService.load({
      userId: owner,
      vaultKey,
      vaultOwnerToken,
      assertCurrent: guard.assertCurrent,
    })
      .then((facts) => {
        if (guard.isCurrent()) setSourced({ owner, key: vaultKey, facts });
      })
      .catch(() => undefined);
    return () => controller.abort();
  }, [ready, present, ownerId, vaultKey, vaultOwnerToken, mounted, readRevision, scopeCurrent, setSourced]);

  useEffect(() => {
    if (!ready || !ownerId || !vaultKey || !vaultOwnerToken || !mounted) {
      setLoaded(null);
      return;
    }
    if (!present) return;
    const owner = ownerId;
    const controller = new AbortController();
    const guard = createAgentPkmCaptureGuard({
      userId: owner,
      signal: controller.signal,
      isEnabled: () =>
        scopeCurrent() && authority.current.ready &&
        authority.current.owner === owner &&
        authority.current.key === vaultKey &&
        authority.current.token === vaultOwnerToken,
    });
    const generation = session.generation;
    setReadFailed(false);
    void WorldModelDecisionService.load({
      userId: owner,
      vaultKey,
      vaultOwnerToken,
      assertCurrent: guard.assertCurrent,
    })
      .then((next) => {
        if (guard.isCurrent() && generation === session.generation)
          setLoaded({ owner, key: vaultKey, memory: next });
      })
      .catch(() => {
        if (guard.isCurrent() && generation === session.generation)
          setReadFailed(true);
      });
    return () => controller.abort();
  }, [ready, present, ownerId, vaultKey, vaultOwnerToken, mounted, revision, readRevision, scopeCurrent, session, setLoaded, setReadFailed]);

  const offered: Offered | null = result?.status === "offered" ? result : null;
  const reviewSource = offered ?? validatedFacts ?? EMPTY_VALIDATED_FACTS;
  useEffect(() => {
    if (!ready) {
      setKeyed(null);
      return;
    }
    if (!present) return;
    let active = true;
    const flat: Omit<WorldModelDraftFact, "kind" | "key">[] = offered
      ? offered.report.sections.flatMap((section) => section.facts.map((fact) => ({
          statement: fact.statement, topic: section.kind, confidence: fact.confidence,
          evidenceScore: fact.evidence_score, evidenceReason: fact.evidence_reason,
          matchStatus: offered.report.match_status, sources: fact.sources,
          reason: offered.research.identity.reason,
        })))
      : (reviewSource as readonly PwmValidatedFact[]).map((fact) => ({
          statement: fact.statement, topic: fact.topic, confidence: fact.confidence,
          matchStatus: fact.identity_state === "owner_linked" ? "matched" : "uncertain",
          sources: fact.sources, reason: "",
        }));
    void Promise.all(flat.map((fact) => pwmClaimKey(fact.statement))).then(
      (keys) => {
        if (!active || !scopeCurrent()) return;
        const seen = new Set<string>();
        const facts: WorldModelDraftFact[] = [];
        flat.forEach((fact, index) => {
          const key = keys[index]!;
          if (seen.has(key)) return;
          seen.add(key);
          facts.push({ ...fact, kind: "draft", key });
        });
        setKeyed({ source: reviewSource, facts });
      },
    );
    return () => {
      active = false;
    };
  }, [offered, reviewSource, ready, present, scopeCurrent, setKeyed]);

  /** Shows a decision only after the service resolves with committed memory. */
  const commit = useCallback(
    async (write: (input: PwmMemoryAuthority) => Promise<PwmMemory>) => {
      const owner = ownerAuthority();
      if (!owner) throw new Error("Vault is locked");
      const next = await write(owner.authority);
      if (owner.isCurrent()) {
        session.generation += 1;
        setLoaded({
          owner: owner.authority.userId,
          key: owner.authority.vaultKey,
          memory: next,
        });
      }
    },
    [ownerAuthority, session, setLoaded],
  );

  // Runs after the commit that removed the decided row, then waits a frame so
  // a closing detail sheet has let go of focus.
  useEffect(() => {
    if (!focusAfter) return;
    const frame = requestAnimationFrame(() => {
      const status = statusRegion.current;
      const active = document.activeElement;
      // Only when the decided control took focus with it; never steal focus.
      if (!status || (active && active !== document.body && active.isConnected))
        return;
      const waiting = yesButtons(status).filter((button) => !button.disabled);
      (
        waiting.find((button) =>
          focusAfter.later.includes(button.dataset.pwmFactYes ?? ""),
        ) ??
        waiting[0] ??
        status
      ).focus();
    });
    return () => cancelAnimationFrame(frame);
  }, [focusAfter]);

  const currentReviewFacts = useRef<readonly WorldModelDraftFact[]>([]);

  /**
   * One decision per statement at a time, shared by its row and its detail
   * sheet. Resolves only after the encrypted memory write commits.
   */
  async function decide(fact: WorldModelDraftFact, save: () => Promise<void>) {
    const owner = ownerAuthority();
    if (!owner) throw new Error("World model is no longer active.");
    const current = currentReviewFacts.current.find((row) => row.key === fact.key);
    if (!current || JSON.stringify(current) !== JSON.stringify(fact))
      throw new Error("Research changed. Review the current finding before saving.");
    if (session.decisions.has(fact.key))
      throw new Error("This detail is already saving.");
    session.decisions.add(fact.key);
    const order = yesButtons(statusRegion.current).map(
      (button) => button.dataset.pwmFactYes ?? "",
    );
    const without = (set: ReadonlySet<string>) =>
      new Set([...set].filter((key) => key !== fact.key));
    setPending((set) => new Set(set).add(fact.key));
    setErrors(without);
    try {
      await save();
    } catch (error) {
      if (owner.isCurrent()) setErrors((set) => new Set(set).add(fact.key));
      throw error;
    } finally {
      session.decisions.delete(fact.key);
      if (owner.isCurrent()) setPending(without);
    }
    // Decided: an open detail for it is stale, and focus moves to what's next.
    if (!owner.isCurrent()) return;
    setDetail((open) =>
      open?.kind === "draft" && open.key === fact.key ? null : open,
    );
    setFocusAfter({ later: order.slice(order.indexOf(fact.key) + 1) });
  }

  const writes = {
    confirm: (fact: WorldModelDraftFact) =>
      commit((owner) =>
        WorldModelDecisionService.confirm({
          ...owner,
          statement: fact.statement,
          topic: fact.topic,
        }),
      ),
    reject: (fact: WorldModelDraftFact) =>
      commit((owner) =>
        WorldModelDecisionService.reject({
          ...owner,
          statement: fact.statement,
          topic: fact.topic,
        }),
      ),
    edit: (fact: WorldModelFactDetail, text: string) =>
      commit((owner) =>
        WorldModelDecisionService.edit({
          ...owner,
          claimKey: fact.kind === "draft" ? fact.key : fact.claim.key,
          text,
          topic: fact.kind === "draft" ? fact.topic : fact.claim.topic,
        }),
      ),
  };
  // A draft's Yes, No and corrected wording are all its one decision.
  const actions: WorldModelFactActions = {
    confirm: (fact) => decide(fact, () => writes.confirm(fact)),
    reject: (fact) => decide(fact, () => writes.reject(fact)),
    edit: (fact, text) =>
      fact.kind === "draft"
        ? decide(fact, () => writes.edit(fact, text))
        : writes.edit(fact, text),
    remove: (claim) =>
      commit((owner) =>
        WorldModelDecisionService.remove({ ...owner, claimKey: claim.key }),
      ),
  };

  async function updatePreferences(
    value: Pick<PwmPreferences, "enabled" | "email_enabled">,
  ) {
    const owner = ownerAuthority();
    if (!owner) throw new Error("Vault is locked");
    if (!preferences) throw new Error("Research preferences are unavailable");
    if (session.preferencePending) throw new Error("Research preferences are already saving.");
    session.preferencePending = true;
    setPreferenceBusy(true); setPreferenceFailed(false);
    try {
      const confirmed = await WorldModelResearchService.updatePreferences(owner.authority, {
        ...value, research_provider: preferences.research_provider,
      });
      if (owner.isCurrent()) reload(confirmed);
    } catch (error) {
      if (owner.isCurrent()) setPreferenceFailed(true);
      throw error;
    } finally {
      session.preferencePending = false;
      if (owner.isCurrent()) setPreferenceBusy(false);
    }
  }

  async function turnOn() {
    if (session.preferencePending || !scopeCurrent()) return;
    try {
      await updatePreferences({
        enabled: true,
        email_enabled: preferences?.email_enabled ?? true,
      });
    } catch { /* The shared preference owner presents its sanitized outcome. */ }
  }

  const draftsReady = keyed?.source === reviewSource;
  // Exact-key suppression only: a decided statement never comes back as a draft.
  const drafts = useMemo(() =>
    memory && draftsReady && keyed
      ? keyed.facts.filter((fact) => !memory.decidedKeys.has(fact.key))
      : [], [memory, draftsReady, keyed]);
  const saved = memory?.saved ?? [];
  // A tick confirms a statement; permission to reuse its public citations is
  // requested separately. Private statement text never becomes a search lead.
  const publicSourceCandidates = publicProfileUrls([
    ...sourcedFacts.flatMap((fact) => fact.sources.map((source) => source.url)),
    ...(offered?.research.provider === "azure_openai_tavily" ? keyed?.facts ?? [] : [])
      .filter((fact) => saved.some((claim) => claim.key === fact.key))
      .flatMap((fact) => fact.sources.map((source) => source.url)),
  ]);
  const matchStatus = offered?.report.match_status;
  const usable =
    saved.length > 0 || sourcedFacts.length > 0 || matchStatus === "matched";
  const preparing =
    ready && mounted && !failed &&
    (result?.status === "pending" || result?.status === "paused");
  // A paused run, or one whose turn ended, picks its saved work back up.
  const resuming =
    preparing && (result.status === "paused" || result.restart_required);
  const shownProgress: PwmProgress | null = preparing ? (progress ?? result.progress ?? null) : null;
  const reading = useReadingSources(shownProgress);
  // Research reports every few seconds; afterwards the age only needs minutes.
  const now = useCoarseClock(preparing ? 5_000 : 30_000);
  // A long quiet spell is a stall whatever the feed or the run claims: a
  // promised resume that never comes must still offer a way out.
  const stalled =
    preparing && lastActivityAt !== null && now - lastActivityAt >= LONG_STALL_MS;
  // Research named a wait before it can be asked again: asking earlier would
  // only repeat the answer, so Try again waits for the store's deadline.
  const waiting =
    ready && mounted && result?.status === "unavailable" &&
    result.retry_after_s !== undefined;
  const retryDue = waiting && (retryAt === null || now >= retryAt);
  const step = preparingStepLine(shownProgress, resuming, live, reading);
  const status = statusCopy({
    ready,
    loading,
    sessionVerificationRequired,
    mounted,
    result,
    failed,
    retrying: Boolean(retrying),
    preferences,
    memoryReady: memory !== null && draftsReady,
    found: draftsReady && keyed ? keyed.facts.length : 0,
    undecided: drafts.length,
    saved: saved.length + sourcedFacts.length,
    checkpoint: progress !== null,
    stepLine: step.step,
    stalled,
    stepDetail: step.detail,
    waiting,
    retryAt,
    now,
  });
  // The group's one line: what research is doing now, or when it last did.
  const freshness = preparing
    ? activityLine({
        resuming,
        live,
        lastActivityAt,
        startedAt: shownProgress?.started_at,
        waiting: resuming && shownProgress === null,
        now,
      })
    : ready && mounted && lastActivityAt !== null
      ? { text: updatedLabel(lastActivityAt, now), notice: false }
      : null;
  const namesakeNotice = preparing ? identityNotice(shownProgress) : null;
  const namesakesFound =
    status.kind === "nothing" && offered !== null && offered.research.candidates.length > 0;
  const phone = phoneNumber ?? user?.phoneNumber ?? null;
  const identity = {
    name: user?.displayName,
    email: user?.email,
    emailVerified: Boolean(user?.emailVerified),
    phone,
  };
  // The landmark carries the group's own title, so both read the same.
  const identityLabel = identityGroupTitle(identity);
  const sections = PWM_SECTIONS.map((section) => ({
    ...section,
    drafts: drafts.filter((fact) => pwmSectionForTopic(fact.topic) === section.id),
    saved: saved.filter((claim) => pwmSectionForTopic(claim.topic) === section.id),
  })).filter((section) => section.drafts.length + section.saved.length > 0);
  useLayoutEffect(() => {
    currentReviewFacts.current = drafts;
    if (!draftsReady || detail?.kind !== "draft") return;
    const current = drafts.find((fact) => fact.key === detail.key);
    if (!current || JSON.stringify(current) !== JSON.stringify(detail)) setDetail(null);
  }, [drafts, draftsReady, detail, setDetail]);
  const detailTopic = detail?.kind === "draft" ? detail.topic : detail?.claim.topic;
  const detailTitle = detailTopic
    ? (PWM_SECTIONS.find((section) => section.id === pwmSectionForTopic(detailTopic))
        ?.label ?? "Detail")
    : "Detail";
  const closeDetail = useCallback(() => setDetail(null), [setDetail]);
  // An action under the card unmounts with its state; focus moves to the
  // status region first, whose row then announces what happened.
  const focusStatus = () => statusRegion.current?.focus({ preventScroll: true });
  const retry = status.kind === "failed";
  // Nothing is running, and asking again would only return the same answer.
  const spent = status.kind === "outage" || status.kind === "exhausted";
  // A bare restart response may be an obsolete draft or a concurrent read.
  // Let the owner submit public starting links; the server's lease/CAS guard
  // still decides whether that explicit refresh can replace existing work.
  const canResearchPublicProfiles = (!spent || status.kind === "exhausted") && (
    (result?.status !== "pending" && result?.status !== "paused") ||
    (result.status === "pending" && result.restart_required &&
      result.progress === undefined && result.validated_facts === undefined)
  ) && memory !== null && draftsReady && drafts.length === 0 && pending.size === 0;
  const canCheckForUpdates = canResearchPublicProfiles && result?.status !== "pending" && result?.status !== "paused";
  useLayoutEffect(() => {
    refreshAllowed.current = canResearchPublicProfiles && preferences?.enabled === true && !preferenceBusy;
    return () => { refreshAllowed.current = false; };
  }, [canResearchPublicProfiles, preferences?.enabled, preferenceBusy, session]);
  const canFindMore = status.kind === "done" && canCheckForUpdates &&
    preferences?.enabled === true && usesAzurePwm(preferences.research_provider) && !preferenceBusy;
  const findMore = () => {
    if (scopeCurrent() && canFindMore) setFindMoreRequest((value) => value + 1);
  };
  const checkpoint = !preparing && (retry || spent || retrying) ? progress : null;
  const StatusIcon = STATUS_ICON[status.kind];

  return { ready, mounted, user, vaultKey, vaultOwnerToken, statusRegion, status, freshness, StatusIcon, preparing, stalled, shownProgress, checkpoint, preferenceFailed, matchStatus, namesakesFound, namesakeNotice, retry, readFailed, focusStatus, setReadRevision, reload, retryDue, preferences, preferenceBusy, turnOn, identityLabel, identity, sections, drafts, saved, pending, errors, actions, setDetail, sourcedFacts, offered, usable, spent, canResearchPublicProfiles, result, pathname, claims, setClaims, present, paneState, updatePreferences, refresh, researchPublicProfiles, detail, detailTitle, closeDetail, memory, canFindMore, findMore, findMoreRequest, publicSourceCandidates, canCheckForUpdates };
}
export type PersonalWorldModelModel = ReturnType<typeof usePersonalWorldModelModel>;

function OwnedWorldModelPage(props: PersonalWorldModelPageOptions) {
  const model = usePersonalWorldModelModel({ embedded: props.embedded });
  return <WorldModelPageView {...props} model={model} />;
}

export function PersonalWorldModelPage({ model, ...props }: PersonalWorldModelPageOptions & { model?: PersonalWorldModelModel }) {
  return model ? <WorldModelPageView {...props} model={model} /> : <OwnedWorldModelPage {...props} />;
}

function WorldModelPageView({ model, embedded = false, onManageDetails, onOpenAccount }: PersonalWorldModelPageOptions & { model: PersonalWorldModelModel }) {
  const { ready, mounted, user, vaultKey, vaultOwnerToken, statusRegion, status, freshness, StatusIcon, preparing, stalled, shownProgress, checkpoint, preferenceFailed, matchStatus, namesakesFound, namesakeNotice, retry, readFailed, focusStatus, setReadRevision, reload, retryDue, preferences, preferenceBusy, turnOn, identityLabel, identity, drafts, saved, pending, errors, actions, setDetail, sourcedFacts, offered, usable, spent, pathname, claims, setClaims, present, paneState, updatePreferences, refresh, researchPublicProfiles, detail, detailTitle, closeDetail, memory } = model;
  const content = (
    <SurfaceStack compact data-pwm-page>
      <SettingsPresentationProvider density="compact">
        {ready && mounted ? (
          <WorldModelClaimInvitation
            key={`claim:${user!.uid}:${vaultOwnerToken}`}
            ownerId={user!.uid}
            vaultKey={vaultKey!}
            vaultOwnerToken={vaultOwnerToken!}
            onClaimed={() => setClaims((value) => value + 1)}
          />
        ) : null}
        <section
          aria-label="Your model"
          ref={statusRegion}
          tabIndex={-1}
          className="space-y-2"
          data-testid="pwm-status"
        >
          <SettingsGroup
            title="Your model"
            density="compact"
            description={
              freshness ? (
                <span data-testid="pwm-freshness">
                  <span role="status" aria-live="polite">
                    {freshness.notice ? freshness.text : ""}
                  </span>
                  {freshness.notice ? null : freshness.text}
                </span>
              ) : undefined
            }
          >
            <SettingsRow
              testId="pwm-status-row"
              icon={StatusIcon}
              iconTone="capability"
              title={status.title}
              stackTrailingOnMobile
              trailing={model.canFindMore ? (
                <Button type="button" size="compact" variant="none" effect="fade"
                  data-voice-control-id="pwm_public_sources_open" onClick={model.findMore}>
                  Find more about me
                </Button>
              ) : undefined}
              // The one live line: a state or step change is announced, the
              // counts and the freshness line tick quietly.
              description={
                <span>
                  <span role="status">{status.body}</span>
                  {status.detail ? <span>{` · ${status.detail}`}</span> : null}
                </span>
              }
            />
            {preparing && !stalled ? (
              <WorldModelProgressRows progress={shownProgress} />
            ) : preparing && shownProgress ? (
              <WorldModelProgressRows progress={shownProgress} active={false} />
            ) : checkpoint ? (
              <WorldModelProgressRows progress={checkpoint} active={false} />
            ) : null}
          </SettingsGroup>
          {preferenceFailed ? (
            <HelperText role="alert" className="profile-account-note">
              Couldn’t save. Try again.
            </HelperText>
          ) : null}
          {matchStatus === "uncertain" ? (
            <HelperText className="profile-account-note">
              Possible match. Some of these may be about someone else with your
              name. Only say yes to what’s yours.
            </HelperText>
          ) : null}
          {namesakesFound ? (
            <HelperText className="profile-account-note">
              Some people share your name. We couldn’t link a public page to your account.
            </HelperText>
          ) : null}
          {namesakeNotice ? (
            <HelperText role="status" className="profile-account-note">
              {namesakeNotice}
            </HelperText>
          ) : null}
          {retry || readFailed ? (
            <div>
              <HelperText role="alert" className="profile-account-note">
                {retry ? "Couldn’t refresh." : "Couldn’t open your saved details."}
              </HelperText>
              <Button
                type="button"
                size="compact"
                variant="none"
                effect="fade"
                data-voice-control-id="pwm_retry"
                onClick={() => {
                  focusStatus();
                  if (readFailed) setReadRevision((value) => value + 1);
                  if (retry) reload();
                }}
              >
                Try again
              </Button>
            </div>
          ) : status.kind === "outage" ? (
            <div>
              <Button
                type="button"
                size="compact"
                variant="none"
                effect="fade"
                disabled={!retryDue}
                data-voice-control-id="pwm_retry"
                onClick={() => {
                  focusStatus();
                  reload();
                }}
              >
                Try again
              </Button>
            </div>
          ) : status.kind === "off" ? (
            <div>
              <HelperText role="status" className="profile-account-note">
                Nothing is looked up while it’s off.
              </HelperText>
              {usesAzurePwm(preferences?.research_provider) ? (
                <HelperText className="profile-account-note">
                  {pwmProviderDisclosure(preferences?.research_provider)}
                </HelperText>
              ) : null}
              <Button
                type="button"
                size="compact"
                disabled={preferenceBusy}
                data-voice-control-id="pwm_turn_on"
                onClick={() => {
                  focusStatus();
                  void turnOn();
                }}
              >
                Turn on
              </Button>
            </div>
          ) : stalled ? (
            <div>
              <HelperText role="status" className="profile-account-note">
                {shownProgress
                  ? "Taking longer than usual. Your progress is kept."
                  : "No research progress has been received yet."}
              </HelperText>
              <Button
                type="button"
                size="compact"
                variant="none"
                effect="fade"
                data-voice-control-id="pwm_retry"
                onClick={() => {
                  focusStatus();
                  reload();
                }}
              >
                Try again
              </Button>
            </div>
          ) : preparing ? (
            <HelperText className="profile-account-note">
              You can leave this page. Research status will update here.
            </HelperText>
          ) : null}
        </section>
        {ready ? (
          <section aria-label={identityLabel} className="space-y-2">
            <WorldModelIdentityGroup {...identity} />
            {status.kind === "insufficient" ? (
              <div>
                <HelperText role="status" className="profile-account-note">
                  Add them in your account, then come back here.
                </HelperText>
                {onOpenAccount ? (
                  <Button
                    type="button"
                    size="compact"
                    variant="none"
                    effect="fade"
                    onClick={onOpenAccount}
                  >
                    Open your account
                  </Button>
                ) : null}
              </div>
            ) : null}
          </section>
        ) : null}
        {ready && mounted ? (
          <>
            {drafts.length > 0 ? (
              <SettingsGroup title="To review" density="compact">
                {drafts.map((fact) => (
                  <WorldModelFactRow key={`draft:${fact.key}`} factKey={fact.key}
                    statement={fact.statement} meta={draftMeta(fact)}
                    unsure={fact.confidence !== "supported" || fact.matchStatus !== "matched" ||
                      (fact.evidenceScore !== undefined && fact.evidenceScore <= 5)}
                    undecided saving={pending.has(fact.key)} failed={errors.has(fact.key)}
                    onYes={() => void actions.confirm(fact).catch(() => undefined)}
                    onNo={() => void actions.reject(fact).catch(() => undefined)}
                    onOpen={() => setDetail(fact)} />
                ))}
              </SettingsGroup>
            ) : null}
            {saved.length > 0 ? (
              <SettingsGroup title="Confirmed by you" density="compact">
                {saved.map((claim) => (
                  <WorldModelFactRow key={`saved:${claim.key}`} statement={claim.text}
                    meta="Confirmed by you" unsure={false} undecided={false}
                    saving={false} failed={false} onYes={() => {}} onNo={() => {}}
                    onOpen={() => setDetail({ kind: "saved", claim })} />
                ))}
              </SettingsGroup>
            ) : null}
            {sourcedFacts.length > 0 ? (
              <SettingsGroup title="From pages you added" density="compact">
                {sourcedFacts.map((fact) => (
                  <SettingsRow
                    key={fact.id}
                    testId="pwm-sourced-row"
                    title={
                      <span className="line-clamp-2 [overflow-wrap:anywhere]">
                        {fact.statement}
                      </span>
                    }
                    description={
                      fact.sources.length > 0
                        ? fact.sources.map((source) => source.title).join(" · ")
                        : undefined
                    }
                  />
                ))}
                {onManageDetails ? (
                  <SettingsRow
                    icon={ProfilePaneGlobeIcon}
                    iconTone="capability"
                    title="Edit or remove these details"
                    chevron
                    voiceControlId="pwm_manage_sourced"
                    onClick={onManageDetails}
                  />
                ) : null}
              </SettingsGroup>
            ) : null}
            {offered?.research.provider === "azure_openai_web_search" &&
            offered.grounded_answers.length > 0 ? (
              <SettingsGroup title="Bing web research" density="compact">
                <HelperText className="profile-account-note px-4 py-3">
                  These are the public search results used to prepare your review draft. Links open the cited pages.
                </HelperText>
                {offered.grounded_answers.map((answer, index) => (
                  <AzureGroundedAnswer key={index} answer={answer} index={index} />
                ))}
              </SettingsGroup>
            ) : null}
            {offered && offered.search_suggestions.length > 0 ? (
              <SettingsGroup title="Related Google searches" density="compact">
                <div aria-label="Google Search suggestions">
                  {offered.search_suggestions.map((html, index) => (
                    <SearchSuggestions key={index} html={html} index={index} />
                  ))}
                </div>
              </SettingsGroup>
            ) : null}
            <WorldModelOptions
              key={`options:${user!.uid}:${vaultOwnerToken}`}
              ownerId={user!.uid}
              vaultKey={vaultKey!}
              vaultOwnerToken={vaultOwnerToken!}
              name={user!.displayName ?? ""}
              usable={usable}
              failed={retry || spent}
              preferences={preferences}
              sourcesRequest={claims}
              findMoreRequest={model.findMoreRequest}
              publicSourceCandidates={model.publicSourceCandidates}
              canCheckForUpdates={model.canCheckForUpdates}
              pathname={pathname}
              embedded={embedded}
              present={present}
              backQuery={
                paneState.open
                  ? { profile_pane: "1", profile_panel: "world-model" }
                  : undefined
              }
              onSourcesSaved={() => setReadRevision((value) => value + 1)}
              onUpdatePreferences={updatePreferences}
              onCheckForUpdates={refresh}
              onResearchPublicProfiles={researchPublicProfiles}
              canResearchPublicProfiles={model.canResearchPublicProfiles}
            />
            {detail ? (
              <WorldModelFactSheet
                key={detail.kind === "draft" ? `draft:${detail.key}` : `saved:${detail.claim.key}`}
                fact={detail}
                title={detailTitle}
                pathname={pathname}
                present={present}
                backQuery={paneState.open ? { profile_pane: "1", profile_panel: "world-model" } : undefined}
                actions={actions}
                pending={detail.kind === "draft" && pending.has(detail.key)}
                onClose={closeDetail}
              />
            ) : null}
          </>
        ) : null}
      </SettingsPresentationProvider>
    </SurfaceStack>
  );

  if (embedded) return content;

  return (
    <AppPageShell
      width="profile"
      density="compact"
      nativeTest={{
        routeId: ROUTES.PROFILE_WORLD_MODEL,
        marker: "native-route-profile-world-model",
        authState: user ? "authenticated" : "anonymous",
        dataState: !ready ? "unavailable-valid" : memory ? "loaded" : "loading",
      }}
    >
      <AppPageHeaderRegion>
        <PageHeader
          title="Personal World Model"
          description="What public pages say about you. You confirm what’s saved."
        />
      </AppPageHeaderRegion>
      <AppPageContentRegion>{content}</AppPageContentRegion>
    </AppPageShell>
  );
}
