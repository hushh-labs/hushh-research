"use client";

import { useEffect, useRef, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import {
  AppPageShell,
  AppPageHeaderRegion,
  AppPageContentRegion,
} from "@/components/app-ui/app-page-shell";
import { PageHeader } from "@/components/app-ui/page-sections";
import { SurfaceStack } from "@/components/app-ui/surfaces";
import { HelperText } from "@/components/app-ui/typography";
import { WorldModelSources } from "@/components/profile/world-model-sources";
import { WorldModelResearchPanel } from "@/components/profile/world-model-research-panel";
import { WorldModelInvitations } from "@/components/profile/world-model-invitations";
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
import {
  PersonalWorldModelService,
  type WorldModelFact,
} from "@/lib/services/personal-world-model-service";

export function PersonalWorldModelPage({
  embedded = false,
  onManageDetails,
}: {
  embedded?: boolean;
  onManageDetails?: () => void;
}) {
  const router = useRouter();
  const pathname = usePathname() || ROUTES.PROFILE_WORLD_MODEL;
  const searchParams = useSearchParams();
  const paneState = resolveProfilePaneUrlState(searchParams);
  const present =
    !embedded ||
    (paneState.open
      ? paneState.location.panel === "world-model"
      : resolveProfileRouteState(pathname, searchParams).panel === "world-model");
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
  const [saved, setSaved] = useState<{
    owner: string;
    key: string;
    facts: WorldModelFact[];
  } | null>(null);
  const [readFailed, setReadFailed] = useState(false);
  const [reload, setReload] = useState(0);
  const [sourceRevision, setSourceRevision] = useState(0);
  const revision = usePkmDomainChangeRevision(user?.uid);
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
  const facts =
    ready && saved && saved.owner === user?.uid && saved.key === vaultKey
      ? saved.facts
      : null;

  useEffect(() => {
    if (!ready || !user || !vaultKey || !vaultOwnerToken) {
      setSaved(null);
      return;
    }
    const owner = user.uid;
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
    setReadFailed(false);
    void PersonalWorldModelService.load({
      userId: owner,
      vaultKey,
      vaultOwnerToken,
      assertCurrent: guard.assertCurrent,
    })
      .then((rows) => {
        if (guard.isCurrent()) setSaved({ owner, key: vaultKey, facts: rows });
      })
      .catch(() => {
        if (guard.isCurrent()) {
          setSaved(null);
          setReadFailed(true);
        }
      });
    return () => controller.abort();
  }, [ready, user, vaultKey, vaultOwnerToken, revision, reload]);

  const content = (
    <SurfaceStack compact>
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
      ) : (
        <>
          <WorldModelResearchPanel />
          <WorldModelSources
            key={`${user!.uid}:${vaultOwnerToken}:${sourceRevision}`}
            ownerId={user!.uid}
            vaultKey={vaultKey!}
            vaultOwnerToken={vaultOwnerToken!}
            name={user!.displayName ?? ""}
            embedded={embedded}
            present={present}
            backQuery={
              paneState.open
                ? { profile_pane: "1", profile_panel: "world-model" }
                : undefined
            }
            onSaved={() => setReload((value) => value + 1)}
          />
          <SettingsGroup title="Saved details">
            <div className="space-y-3 px-4 py-3">
              {readFailed ? (
                <>
                  <HelperText role="status">Your saved model couldn’t be opened.</HelperText>
                  <Button size="compact" variant="muted" onClick={() => setReload((value) => value + 1)}>
                    Try again
                  </Button>
                </>
              ) : facts === null ? (
                <HelperText role="status">Opening saved details…</HelperText>
              ) : facts.length === 0 ? (
                <HelperText>No approved details yet. Add information you want to keep from your own sources.</HelperText>
              ) : (
                <ul className="space-y-3">
                  {facts.map((fact) => (
                    <li key={fact.id} className="space-y-1 border-b border-border pb-3 text-[13px]">
                      <p>{fact.statement}</p>
                      <div className="flex flex-wrap gap-3">
                        {fact.sources.map((source) => (
                          <a key={source.url} className="text-xs text-muted-foreground underline underline-offset-4" href={source.url} target="_blank" rel="noopener noreferrer">
                            {source.title}
                          </a>
                        ))}
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </div>
            <SettingsRow
              title="Edit or remove saved details"
              chevron
              onClick={onManageDetails ?? (() => router.push(ROUTES.PROFILE_MY_DATA))}
            />
          </SettingsGroup>
          <WorldModelInvitations
            onClaimed={() => setSourceRevision((value) => value + 1)}
            key={`${user!.uid}:${vaultOwnerToken}`}
            ownerId={user!.uid}
            vaultKey={vaultKey!}
            vaultOwnerToken={vaultOwnerToken!}
          />
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
        dataState: !ready ? "unavailable-valid" : facts ? "loaded" : "loading",
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
