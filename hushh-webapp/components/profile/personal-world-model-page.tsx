"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { usePathname, useSearchParams } from "next/navigation";
import {
  AppPageShell,
  AppPageHeaderRegion,
  AppPageContentRegion,
} from "@/components/app-ui/app-page-shell";
import { PageHeader } from "@/components/app-ui/page-sections";
import { SurfaceStack } from "@/components/app-ui/surfaces";
import { HelperText, RowDescription, RowLabel } from "@/components/app-ui/typography";
import { useWorldModelResearch } from "@/components/profile/world-model-provider";
import { WorldModelClaimInvitation } from "@/components/profile/world-model-claim-invitation";
import { WorldModelFactRow } from "@/components/profile/world-model-fact-row";
import {
  WorldModelFactSheet,
  type WorldModelDraftFact,
  type WorldModelFactActions,
  type WorldModelFactDetail,
} from "@/components/profile/world-model-fact-sheet";
import { WorldModelOptions } from "@/components/profile/world-model-options";
import { SearchSuggestions } from "@/components/profile/world-model-search-suggestions";
import {
  SettingsGroup,
  SettingsPresentationProvider,
  SettingsRow,
} from "@/components/profile/settings-ui";
import { Button } from "@/lib/morphy-ux/button";
import { useAuth } from "@/lib/firebase/auth-context";
import { useVault } from "@/lib/vault/vault-context";
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
  type PwmResult,
} from "@/lib/services/world-model-research-service";
import {
  PersonalWorldModelService,
  type WorldModelFact,
} from "@/lib/services/personal-world-model-service";

type Offered = Extract<PwmResult, { status: "offered" }>;
type StatusCopy = { title: string; body?: string; action?: "turn_on" | "retry" };

function statusCopy(input: {
  result: PwmResult | null;
  failed: boolean;
  preferences: PwmPreferences | null;
  memoryReady: boolean;
  /** Statements in the offered report, decided or not. */
  found: number;
  undecided: number;
  saved: number;
}): StatusCopy {
  const { result, found, undecided, saved } = input;
  if (input.failed || result?.status === "unavailable")
    return { title: "Couldn’t finish preparing your model.", action: "retry" };
  if (
    result?.status === "consent_required" ||
    (!result && input.preferences?.enabled === false)
  )
    return { title: "Public research is off", action: "turn_on" };
  if (!result) return { title: "Checking your model…" };
  switch (result.status) {
    case "pending":
    case "paused":
      return {
        title: "Preparing your model",
        body: "Your private agent is looking up public information about you. This takes a few minutes; keep using the app and we’ll let you know in Feed.",
      };
    case "insufficient_identity":
      return {
        title:
          "Add your name and a verified email or phone so we can tell you apart from people with the same name.",
      };
    case "not_ready":
      return { title: "Finish setup to prepare your model." };
    case "disabled":
      return { title: "Personal World Model isn’t available right now." };
  }
  if (!input.memoryReady) return { title: "Checking your model…" };
  if (undecided > 0)
    return {
      title: "Ready to review",
      body: `${undecided} ${undecided === 1 ? "detail" : "details"} to confirm.`,
    };
  // Everything found is decided, even when every answer was No.
  if (saved > 0 || (result.status === "offered" && found > 0))
    return { title: "Up to date", body: "You’ve reviewed everything found so far." };
  // "saved" means no draft is active: the last one aged out or was cleared.
  if (result.status === "saved")
    return {
      title: "Nothing to review right now",
      body: "We’ll check public sources again in a few days.",
    };
  // Only an offered report with no statements at all.
  return {
    title: "Nothing to review yet",
    body: "We couldn’t find public details we could connect to you.",
  };
}

/** Yes buttons of statements still waiting for the owner, in page order. */
function yesButtons(inPage: HTMLElement | null) {
  return [
    ...(inPage
      ?.closest("[data-pwm-page]")
      ?.querySelectorAll<HTMLButtonElement>("button[data-pwm-fact-yes]") ?? []),
  ];
}

export function PersonalWorldModelPage({
  embedded = false,
  onManageDetails,
}: {
  embedded?: boolean;
  /** Opens the owner's data, where details saved from added sources are managed. */
  onManageDetails?: () => void;
}) {
  const pathname = usePathname() || ROUTES.PROFILE_WORLD_MODEL;
  const searchParams = useSearchParams();
  const paneState = resolveProfilePaneUrlState(searchParams);
  const present =
    !embedded ||
    (paneState.open
      ? paneState.location.panel === "world-model"
      : resolveProfileRouteState(pathname, searchParams).panel === "world-model");
  // mounted is false only while no app-level reader is attached.
  const { mounted, result, preferences, failed, reload, refresh } =
    useWorldModelResearch();
  const { user, loading, sessionVerificationRequired } = useAuth();
  const { vaultKey, vaultOwnerToken, isVaultUnlocked, tokenExpiresAt } =
    useVault();
  const ready = Boolean(
    !loading &&
    user &&
    !sessionVerificationRequired &&
    isVaultUnlocked &&
    vaultKey &&
    vaultOwnerToken &&
    (tokenExpiresAt === null || Date.now() < tokenExpiresAt),
  );
  const [loaded, setLoaded] = useState<{
    owner: string;
    key: string;
    memory: PwmMemory;
  } | null>(null);
  const [readFailed, setReadFailed] = useState(false);
  // Details saved through "Add a public source" keep their own encrypted records.
  const [sourced, setSourced] = useState<{
    owner: string;
    key: string;
    facts: WorldModelFact[];
  } | null>(null);
  const [readRevision, setReadRevision] = useState(0);
  // Each claim moves the inviter's preview into this owner's sources.
  const [claims, setClaims] = useState(0);
  const [keyed, setKeyed] = useState<{
    draftId: string;
    facts: WorldModelDraftFact[];
  } | null>(null);
  const [pending, setPending] = useState<ReadonlySet<string>>(new Set());
  const [errors, setErrors] = useState<ReadonlySet<string>>(new Set());
  const inFlight = useRef(new Set<string>());
  const [detail, setDetail] = useState<WorldModelFactDetail | null>(null);
  const [preferenceBusy, setPreferenceBusy] = useState(false);
  const [preferenceFailed, setPreferenceFailed] = useState(false);
  const statusRegion = useRef<HTMLDivElement>(null);
  // Set when a decision commits: statements after it, in page order.
  const [focusAfter, setFocusAfter] = useState<{
    later: readonly string[];
  } | null>(null);
  // Committed write results always win over a read that started earlier.
  const memoryGeneration = useRef(0);
  const revision = usePkmDomainChangeRevision(user?.uid, MARKDOWN_MEMORY_DOMAIN);
  const authority = useRef({
    ready,
    owner: user?.uid,
    key: vaultKey,
    token: vaultOwnerToken,
  });
  authority.current = {
    ready,
    owner: user?.uid,
    key: vaultKey,
    token: vaultOwnerToken,
  };
  const memory =
    ready && loaded && loaded.owner === user?.uid && loaded.key === vaultKey
      ? loaded.memory
      : null;
  const sourcedFacts =
    ready && sourced && sourced.owner === user?.uid && sourced.key === vaultKey
      ? sourced.facts
      : [];

  const ownerAuthority = useCallback(() => {
    const { ready: isReady, owner, key, token } = authority.current;
    if (!isReady || !owner || !key || !token) return null;
    const guard = createAgentPkmCaptureGuard({
      userId: owner,
      signal: new AbortController().signal,
      isEnabled: () =>
        authority.current.ready &&
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
  }, []);

  const ownerId = user?.uid;
  useEffect(() => {
    if (!ready || !ownerId || !vaultKey || !vaultOwnerToken || !mounted) {
      setSourced(null);
      return;
    }
    const owner = ownerId;
    const controller = new AbortController();
    const guard = createAgentPkmCaptureGuard({
      userId: owner,
      signal: controller.signal,
      isEnabled: () =>
        authority.current.ready &&
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
  }, [ready, ownerId, vaultKey, vaultOwnerToken, mounted, readRevision]);

  useEffect(() => {
    if (!ready || !ownerId || !vaultKey || !vaultOwnerToken || !mounted) {
      setLoaded(null);
      return;
    }
    const owner = ownerId;
    const controller = new AbortController();
    const guard = createAgentPkmCaptureGuard({
      userId: owner,
      signal: controller.signal,
      isEnabled: () =>
        authority.current.ready &&
        authority.current.owner === owner &&
        authority.current.key === vaultKey &&
        authority.current.token === vaultOwnerToken,
    });
    const generation = memoryGeneration.current;
    setReadFailed(false);
    void WorldModelDecisionService.load({
      userId: owner,
      vaultKey,
      vaultOwnerToken,
      assertCurrent: guard.assertCurrent,
    })
      .then((next) => {
        if (guard.isCurrent() && generation === memoryGeneration.current)
          setLoaded({ owner, key: vaultKey, memory: next });
      })
      .catch(() => {
        if (guard.isCurrent() && generation === memoryGeneration.current)
          setReadFailed(true);
      });
    return () => controller.abort();
  }, [ready, ownerId, vaultKey, vaultOwnerToken, mounted, revision, readRevision]);

  const offered: Offered | null = result?.status === "offered" ? result : null;
  useEffect(() => {
    if (!offered) {
      setKeyed(null);
      return;
    }
    let active = true;
    const flat = offered.report.sections.flatMap((section) =>
      section.facts.map((fact) => ({ ...fact, topic: section.kind })),
    );
    void Promise.all(flat.map((fact) => pwmClaimKey(fact.statement))).then(
      (keys) => {
        if (!active) return;
        const seen = new Set<string>();
        const facts: WorldModelDraftFact[] = [];
        flat.forEach((fact, index) => {
          const key = keys[index]!;
          if (seen.has(key)) return;
          seen.add(key);
          facts.push({
            kind: "draft",
            key,
            statement: fact.statement,
            topic: fact.topic,
            confidence: fact.confidence,
            matchStatus: offered.report.match_status,
            sources: fact.sources,
            reason: offered.research.identity.reason,
          });
        });
        setKeyed({ draftId: offered.draft_id, facts });
      },
    );
    return () => {
      active = false;
    };
  }, [offered]);

  /** Shows a decision only after the service resolves with committed memory. */
  const commit = useCallback(
    async (write: (input: PwmMemoryAuthority) => Promise<PwmMemory>) => {
      const owner = ownerAuthority();
      if (!owner) throw new Error("Vault is locked");
      const next = await write(owner.authority);
      memoryGeneration.current += 1;
      if (owner.isCurrent())
        setLoaded({
          owner: owner.authority.userId,
          key: owner.authority.vaultKey,
          memory: next,
        });
    },
    [ownerAuthority],
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

  /**
   * One decision per statement at a time, shared by its row and its detail
   * sheet. Resolves only after the encrypted memory write commits.
   */
  async function decide(fact: WorldModelDraftFact, save: () => Promise<void>) {
    if (inFlight.current.has(fact.key))
      throw new Error("This detail is already saving.");
    inFlight.current.add(fact.key);
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
      setErrors((set) => new Set(set).add(fact.key));
      throw error;
    } finally {
      inFlight.current.delete(fact.key);
      setPending(without);
    }
    // Decided: an open detail for it is stale, and focus moves to what's next.
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
    // The confirmed switches stay on screen while research restarts.
    reload(await WorldModelResearchService.updatePreferences(owner.authority, value));
  }

  async function turnOn() {
    if (preferenceBusy) return;
    setPreferenceBusy(true);
    setPreferenceFailed(false);
    try {
      await updatePreferences({
        enabled: true,
        email_enabled: preferences?.email_enabled ?? true,
      });
    } catch {
      setPreferenceFailed(true);
    } finally {
      setPreferenceBusy(false);
    }
  }

  const draftsReady = !offered || keyed?.draftId === offered.draft_id;
  // Exact-key suppression only: a decided statement never comes back as a draft.
  const drafts =
    memory && offered && draftsReady && keyed
      ? keyed.facts.filter((fact) => !memory.decidedKeys.has(fact.key))
      : [];
  const saved = memory?.saved ?? [];
  const matchStatus = offered?.report.match_status;
  const usable =
    saved.length > 0 || sourcedFacts.length > 0 || matchStatus === "matched";
  const status = statusCopy({
    result,
    failed,
    preferences,
    memoryReady: memory !== null && draftsReady,
    found: offered && draftsReady && keyed ? keyed.facts.length : 0,
    undecided: drafts.length,
    saved: saved.length + sourcedFacts.length,
  });
  const sections = PWM_SECTIONS.map((section) => ({
    ...section,
    drafts: drafts.filter((fact) => pwmSectionForTopic(fact.topic) === section.id),
    saved: saved.filter((claim) => pwmSectionForTopic(claim.topic) === section.id),
  })).filter((section) => section.drafts.length + section.saved.length > 0);
  const detailTopic = detail?.kind === "draft" ? detail.topic : detail?.claim.topic;
  const detailTitle = detailTopic
    ? (PWM_SECTIONS.find((section) => section.id === pwmSectionForTopic(detailTopic))
        ?.label ?? "Detail")
    : "Detail";
  const closeDetail = useCallback(() => setDetail(null), []);
  const retry = status.action === "retry";

  const content = (
    <SurfaceStack compact data-pwm-page>
      {!ready ? (
        <SettingsGroup>
          <div className="px-4 py-3">
            <HelperText role="status">
              {loading
                ? "Opening your profile…"
                : sessionVerificationRequired
                  ? "Reconnect your account to continue."
                  : "Unlock your vault to open your Personal World Model."}
            </HelperText>
          </div>
        </SettingsGroup>
      ) : !mounted ? (
        // Only before the app-level reader attaches. Never a link to the
        // route: proxy.ts presents that route as this same pane.
        <SettingsGroup>
          <div className="px-4 py-3">
            <HelperText role="status">Checking your model…</HelperText>
          </div>
        </SettingsGroup>
      ) : (
        <>
          <WorldModelClaimInvitation
            key={`claim:${user!.uid}:${vaultOwnerToken}`}
            ownerId={user!.uid}
            vaultKey={vaultKey!}
            vaultOwnerToken={vaultOwnerToken!}
            onClaimed={() => setClaims((value) => value + 1)}
          />
          <SettingsGroup>
            <div
              ref={statusRegion}
              tabIndex={-1}
              className="min-w-0 space-y-1 px-4 py-3"
              role="status"
            >
              <RowLabel as="p" className="break-words">
                {status.title}
              </RowLabel>
              {status.body ? (
                <RowDescription className="break-words">{status.body}</RowDescription>
              ) : null}
              {matchStatus === "uncertain" ? (
                <RowDescription className="break-words">
                  Some details may be about someone else with your name. Only
                  confirm what’s yours.
                </RowDescription>
              ) : null}
              {readFailed ? (
                <RowDescription>Your saved details couldn’t be opened.</RowDescription>
              ) : null}
              {preferenceFailed ? (
                <RowDescription>Couldn’t save. Try again.</RowDescription>
              ) : null}
            </div>
            {status.action === "turn_on" ? (
              <div className="px-4 pb-3">
                <Button
                  size="compact"
                  disabled={preferenceBusy}
                  data-voice-control-id="pwm_turn_on"
                  onClick={() => void turnOn()}
                >
                  Turn on
                </Button>
              </div>
            ) : retry || readFailed ? (
              <div className="px-4 pb-3">
                <Button
                  size="compact"
                  variant="muted"
                  data-voice-control-id="pwm_retry"
                  onClick={() => {
                    if (readFailed) setReadRevision((value) => value + 1);
                    if (retry) reload();
                  }}
                >
                  Try again
                </Button>
              </div>
            ) : null}
          </SettingsGroup>
          {sections.map((section) => (
            <SettingsGroup key={section.id} title={section.label}>
              {section.drafts.map((fact) => (
                <WorldModelFactRow
                  key={`draft:${fact.key}`}
                  factKey={fact.key}
                  statement={fact.statement}
                  meta={fact.sources[0]?.title ?? ""}
                  unsure={fact.confidence !== "supported" || fact.matchStatus !== "matched"}
                  undecided
                  saving={pending.has(fact.key)}
                  failed={errors.has(fact.key)}
                  onYes={() => void actions.confirm(fact).catch(() => undefined)}
                  onNo={() => void actions.reject(fact).catch(() => undefined)}
                  onOpen={() => setDetail(fact)}
                />
              ))}
              {section.saved.map((claim) => (
                <WorldModelFactRow
                  key={`saved:${claim.key}`}
                  statement={claim.text}
                  meta="Confirmed by you"
                  unsure={false}
                  undecided={false}
                  saving={false}
                  failed={false}
                  onYes={() => {}}
                  onNo={() => {}}
                  onOpen={() => setDetail({ kind: "saved", claim })}
                />
              ))}
            </SettingsGroup>
          ))}
          {sourcedFacts.length > 0 ? (
            <SettingsGroup title="From your sources">
              <ul className="divide-y divide-border">
                {sourcedFacts.map((fact) => (
                  <li key={fact.id} className="min-w-0 space-y-1 px-4 py-3">
                    <RowLabel as="p" className="break-words">
                      {fact.statement}
                    </RowLabel>
                    {fact.sources.length > 0 ? (
                      <div className="flex min-w-0 flex-wrap gap-x-3">
                        {fact.sources.map((source) => (
                          <a
                            key={source.url}
                            href={source.url}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="inline-flex min-h-11 max-w-full items-center break-all text-xs text-muted-foreground underline underline-offset-4"
                          >
                            {source.title}
                          </a>
                        ))}
                      </div>
                    ) : null}
                  </li>
                ))}
              </ul>
              {onManageDetails ? (
                <SettingsRow
                  title="Edit or remove these details"
                  chevron
                  voiceControlId="pwm_manage_sourced"
                  onClick={onManageDetails}
                />
              ) : null}
            </SettingsGroup>
          ) : null}
          {offered && offered.search_suggestions.length > 0 ? (
            <SettingsGroup title="Related Google searches">
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
            failed={retry}
            preferences={preferences}
            sourcesRequest={claims}
            canCheckForUpdates={
              result?.status !== "pending" && result?.status !== "paused"
            }
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
          />
          {detail ? (
            <WorldModelFactSheet
              key={detail.kind === "draft" ? `draft:${detail.key}` : `saved:${detail.claim.key}`}
              fact={detail}
              title={detailTitle}
              pathname={pathname}
              actions={actions}
              pending={detail.kind === "draft" && pending.has(detail.key)}
              onClose={closeDetail}
            />
          ) : null}
        </>
      )}
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
          description="A clearer picture of you, with evidence you can review."
        />
      </AppPageHeaderRegion>
      <AppPageContentRegion>
        <SettingsPresentationProvider density="compact">
          {content}
        </SettingsPresentationProvider>
      </AppPageContentRegion>
    </AppPageShell>
  );
}
