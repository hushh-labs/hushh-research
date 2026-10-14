"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
  AppPageShell,
  AppPageHeaderRegion,
  AppPageContentRegion,
} from "@/components/app-ui/app-page-shell";
import { PageHeader } from "@/components/app-ui/page-sections";
import { SurfaceStack } from "@/components/app-ui/surfaces";
import { HelperText } from "@/components/app-ui/typography";
import {
  ProfileResearchCard,
  type ProfileResearchAvailability,
} from "@/components/agent/profile-research-card";
import { WorldModelInvitations } from "@/components/profile/world-model-invitations";
import { SettingsPresentationProvider } from "@/components/profile/settings-ui";
import { Card, CardContent, CardHeader, CardTitle } from "@/lib/morphy-ux/card";
import { Button } from "@/lib/morphy-ux/button";
import { useAuth } from "@/lib/firebase/auth-context";
import { useVault } from "@/lib/vault/vault-context";
import { ROUTES } from "@/lib/navigation/routes";
import { createAgentPkmCaptureGuard } from "@/lib/agent/agent-pkm-capture-runtime";
import { usePkmDomainChangeRevision } from "@/lib/pkm/use-pkm-domain-change-revision";
import {
  PersonalWorldModelService,
  type WorldModelFact,
} from "@/lib/services/personal-world-model-service";

export function PersonalWorldModelPage() {
  const router = useRouter();
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
  const [run, setRun] = useState(0);
  const [startedFor, setStartedFor] = useState<{ owner: string; key: string } | null>(null);
  const [availability, setAvailability] =
    useState<ProfileResearchAvailability>("hidden");
  const [saved, setSaved] = useState<{
    owner: string;
    key: string;
    facts: WorldModelFact[];
  } | null>(null);
  const [readFailed, setReadFailed] = useState(false);
  const [reload, setReload] = useState(0);
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
  const active = ready && startedFor?.owner === user?.uid && startedFor?.key === vaultKey;
  const facts =
    ready && saved && saved.owner === user?.uid && saved.key === vaultKey
      ? saved.facts
      : null;

  useEffect(() => {
    if (!ready || !user || !vaultKey || !vaultOwnerToken) {
      setStartedFor(null);
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

  const building = active && ["pending", "loading"].includes(availability);
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
          <SurfaceStack compact>
            {!ready ? (
              <Card preset="compact">
                <CardContent className="p-4">
                  <HelperText role="status">
                    {loading
                      ? "Opening your profile…"
                      : sessionVerificationRequired
                        ? "Reconnect your account to continue."
                        : "Unlock your vault to open your Personal World Model."}
                  </HelperText>
                </CardContent>
              </Card>
            ) : (
              <>
                <Card preset="compact">
                  <CardHeader className="p-4 pb-2">
                    <CardTitle className="text-sm">Build your model</CardTitle>
                    <HelperText>
                      Find public details about you, check the sources, and
                      choose what to keep. Your verified contact helps separate
                      you from people with the same name.
                    </HelperText>
                  </CardHeader>
                  <CardContent className="space-y-3 p-4 pt-0">
                    <HelperText>
                      Your name and verified contact are sent to the search
                      provider when you begin. Private accounts and breach
                      reports need a separate connection.
                    </HelperText>
                    <Button
                      size="compact"
                      disabled={active && availability !== "failed"}
                      data-voice-control-id="pwm_build"
                      onClick={() => {
                        setAvailability("pending");
                        setStartedFor({ owner: user!.uid, key: vaultKey! });
                        setRun((value) => value + 1);
                      }}
                    >
                      {building
                        ? "Building your model…"
                        : active
                          ? "Resume research"
                          : "Build my model"}
                    </Button>
                  </CardContent>
                </Card>
                {active && (
                  <ProfileResearchCard
                    key={run}
                    ownerId={user!.uid}
                    vaultKey={vaultKey}
                    vaultOwnerToken={vaultOwnerToken}
                    enabled={ready}
                    pathname={ROUTES.PROFILE_WORLD_MODEL}
                    worldModel
                    onAvailabilityChange={setAvailability}
                    onSaved={() => {
                      setReload((value) => value + 1);
                      setStartedFor(null);
                    }}
                    onDiscarded={() => setStartedFor(null)}
                  />
                )}
                <Card preset="compact">
                  <CardHeader className="p-4 pb-2">
                    <CardTitle className="text-sm">Your model</CardTitle>
                    <HelperText>
                      Details you approve are saved to memory.md. Earlier saves
                      keep their sources here.
                    </HelperText>
                  </CardHeader>
                  <CardContent className="space-y-3 p-4 pt-0">
                    {readFailed ? (
                      <>
                        <HelperText role="status">
                          Your saved model couldn’t be opened.
                        </HelperText>
                        <Button
                          size="compact"
                          variant="muted"
                          onClick={() => setReload((value) => value + 1)}
                        >
                          Try again
                        </Button>
                      </>
                    ) : facts === null ? (
                      <HelperText role="status">
                        Opening saved details…
                      </HelperText>
                    ) : facts.length === 0 ? (
                      <HelperText>
                        No earlier cited details. Build your model to add
                        details to memory.md.
                      </HelperText>
                    ) : (
                      <ul className="space-y-3">
                        {facts.map((fact) => (
                          <li
                            key={fact.id}
                            className="space-y-1 border-b border-border pb-3 text-[13px]"
                          >
                            <p>{fact.statement}</p>
                            <div className="flex flex-wrap gap-3">
                              {fact.sources.map((source) => (
                                <a
                                  key={source.url}
                                  className="text-xs text-muted-foreground underline underline-offset-4"
                                  href={source.url}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                >
                                  {source.title}
                                </a>
                              ))}
                            </div>
                          </li>
                        ))}
                      </ul>
                    )}
                    <Button
                      size="compact"
                      variant="none"
                      onClick={() => router.push(ROUTES.PROFILE_MY_DATA)}
                    >
                      Edit or remove saved details
                    </Button>
                  </CardContent>
                </Card>
                <WorldModelInvitations
                  key={`${user!.uid}:${vaultOwnerToken}`}
                  ownerId={user!.uid}
                  vaultKey={vaultKey!}
                  vaultOwnerToken={vaultOwnerToken!}
                />
              </>
            )}
          </SurfaceStack>
        </SettingsPresentationProvider>
      </AppPageContentRegion>
    </AppPageShell>
  );
}
