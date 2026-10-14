"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Card, CardContent, CardHeader, CardTitle } from "@/lib/morphy-ux/card";
import { Button } from "@/lib/morphy-ux/button";
import { HelperText } from "@/components/app-ui/typography";
import { Checkbox } from "@/components/ui/checkbox";
import { Textarea } from "@/components/ui/textarea";
import { WorldModelSourceService } from "@/lib/services/world-model-source-service";
import { useWorldModelResearch } from "./world-model-provider";
import type {
  ProfileResearchResult,
  ProfileReport,
} from "@/lib/services/profile-research-service";
import { Input } from "@/components/ui/input";
import { createAgentPkmCaptureGuard } from "@/lib/agent/agent-pkm-capture-runtime";
import {
  WorldModelInvitationsService,
  type WorldModelInvitation,
} from "@/lib/services/world-model-invitations-service";
import { shareLink, isShareCancellationError } from "@/lib/share/share-link";
import { ROUTES } from "@/lib/navigation/routes";
import {
  clearWorldModelInvitationHandoffsForToken,
  needsWorldModelInvitationAccountSwitch,
  readWorldModelInvitationHandoff,
  worldModelInvitationHandoffRoute,
} from "@/lib/world-model/invitation-handoff";

export function WorldModelInvitations({
  ownerId,
  vaultKey,
  vaultOwnerToken,
  onClaimed,
}: {
  ownerId: string;
  vaultKey: string;
  vaultOwnerToken: string;
  onClaimed?: () => void;
}) {
  const router = useRouter();
  const query = useSearchParams();
  const [claimToken, setClaimToken] = useState<string | null>(null);
  const [accountSwitchHandoff, setAccountSwitchHandoff] = useState<string | null>(null);
  const [name, setName] = useState(""),
    [sourceUrl, setSourceUrl] = useState(""),
    [introduction, setIntroduction] = useState("");
  const [preview, setPreview] = useState<Extract<
    ProfileResearchResult,
    { status: "offered" }
  > | null>(null);
  const [receivedPreview, setReceivedPreview] = useState<{
    report: ProfileReport;
    introduction: string;
  } | null>(null);
  const [selected, setSelected] = useState<string[]>([]),
    [permission, setPermission] = useState(false),
    [researchConsent, setResearchConsent] = useState(false);
  const { reload: reloadResearch } = useWorldModelResearch();
  useEffect(() => {
    const syncToken = () => {
      const handoff = query.get("handoff");
      const recovered = handoff
        ? readWorldModelInvitationHandoff(handoff, ownerId)
        : null;
      setAccountSwitchHandoff(
        handoff && !recovered && needsWorldModelInvitationAccountSwitch(handoff, ownerId)
          ? handoff
          : null,
      );
      setClaimToken(
        recovered ||
          new URLSearchParams(window.location.hash.slice(1)).get("claim"),
      );
    };
    syncToken();
    window.addEventListener("hashchange", syncToken);
    return () => window.removeEventListener("hashchange", syncToken);
  }, [ownerId, query]);
  useEffect(() => {
    let active = true;
    setReceivedPreview(null);
    if (claimToken)
      void WorldModelInvitationsService.preview(claimToken)
        .then((row) => {
          if (active && "report" in row) setReceivedPreview(row);
        })
        .catch(() => {});
    return () => {
      active = false;
    };
  }, [claimToken]);
  const [contact, setContact] = useState("");
  const [link, setLink] = useState<string | null>(null);
  const [rows, setRows] = useState<WorldModelInvitation[]>([]);
  const [busy, setBusy] = useState(false);
  const pendingAction = useRef(false);
  const [message, setMessage] = useState("");
  const [revision, setRevision] = useState(0);
  const current = useRef({ ownerId, vaultKey, vaultOwnerToken });
  current.current = { ownerId, vaultKey, vaultOwnerToken };
  const active = useRef(true);
  const lifetime = useRef(new AbortController());
  const session = { vaultKey, vaultOwnerToken };
  const guard = () =>
    createAgentPkmCaptureGuard({
      userId: ownerId,
      signal: lifetime.current.signal,
      isEnabled: () =>
        active.current &&
        current.current.ownerId === ownerId &&
        current.current.vaultKey === vaultKey &&
        current.current.vaultOwnerToken === vaultOwnerToken,
    });
  useEffect(() => {
    active.current = true;
    lifetime.current = new AbortController();
    return () => {
      active.current = false;
      lifetime.current.abort();
    };
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    const capture = createAgentPkmCaptureGuard({
      userId: ownerId,
      signal: controller.signal,
      isEnabled: () =>
        active.current &&
        current.current.ownerId === ownerId &&
        current.current.vaultOwnerToken === vaultOwnerToken,
    });
    void WorldModelInvitationsService.list({ vaultKey, vaultOwnerToken })
      .then((value) => {
        if (capture.isCurrent()) setRows(value);
      })
      .catch(() => {
        if (capture.isCurrent())
          setMessage("Invitations couldn’t be opened. Try again.");
      });
    return () => controller.abort();
  }, [ownerId, vaultKey, vaultOwnerToken, revision]);
  async function run(action: () => Promise<void>) {
    if (pendingAction.current) return;
    pendingAction.current = true;
    const capture = guard();
    setBusy(true);
    setMessage("");
    try {
      await capture.assertCurrent();
      await action();
    } catch {
      if (capture.isCurrent())
        setMessage(
          "Couldn’t finish. Check your verified contact or try again.",
        );
    } finally {
      pendingAction.current = false;
      if (capture.isCurrent()) setBusy(false);
    }
  }
  return (
    <Card preset="compact">
      <CardHeader className="p-4 pb-2">
        <CardTitle className="text-sm">Build for someone else</CardTitle>
        <HelperText>
          Prepare a short public professional preview, review it, then share a
          contact-bound invitation. Their full model stays under their control.
        </HelperText>
      </CardHeader>
      <CardContent className="space-y-3 p-4 pt-0">
        {accountSwitchHandoff && (
          <div className="space-y-2 rounded-lg border border-border p-3 text-[13px]">
            <p>This invitation was opened with another account.</p>
            <Button
              size="compact"
              onClick={() =>
                router.replace(worldModelInvitationHandoffRoute(accountSwitchHandoff))
              }
            >
              Review invitation with this account
            </Button>
          </div>
        )}
        {claimToken && (
          <div className="space-y-2 rounded-lg border border-border p-3">
            <p className="text-[13px]">
              You’ve been invited to claim a Personal World Model. Verify the
              invited contact, then choose whether to claim or reject the
              invitation. Claiming shares nothing back.
            </p>
            {receivedPreview && (
              <div className="space-y-2 text-xs">
                <p>{receivedPreview.introduction}</p>
                <p>Prepared by the inviter</p>
                {receivedPreview.report.sections.map((section) => (
                  <ul key={section.kind} className="space-y-2">
                    {section.facts.map((fact, index) => (
                      <li key={index}>
                        {fact.statement}
                        <div>
                          {fact.sources.map((source) => (
                            <a
                              key={source.url}
                              href={source.url}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="inline-flex min-h-11 items-center underline"
                            >
                              {source.title}
                            </a>
                          ))}
                        </div>
                      </li>
                    ))}
                  </ul>
                ))}
              </div>
            )}
            <label className="flex min-h-11 items-center gap-3 text-xs">
              <Checkbox
                checked={researchConsent}
                onCheckedChange={(v) => setResearchConsent(v === true)}
              />
              After claiming, let Gemini research my name and verified contact
              to prepare my full model.
            </label>
            <Button
              data-voice-control-id="pwm_claim"
              size="compact"
              disabled={busy}
              onClick={() =>
                void run(async () => {
                  const capture = guard();
                  await WorldModelInvitationsService.claim(
                    session,
                    claimToken,
                    researchConsent,
                  );
                  await capture.assertCurrent();
                  clearWorldModelInvitationHandoffsForToken(claimToken);
                  setMessage(
                    "Claimed. You can now review and build your model. Nothing has been shared back.",
                  );
                  setClaimToken(null);
                  reloadResearch();
                  onClaimed?.();
                  router.replace(ROUTES.PROFILE_WORLD_MODEL);
                  router.refresh();
                })
              }
            >
              Claim my model
            </Button>
            <Button
              size="compact"
              variant="none"
              disabled={busy}
              data-voice-control-id="pwm_reject"
              onClick={() =>
                void run(async () => {
                  const capture = guard();
                  await WorldModelInvitationsService.reject(
                    session,
                    claimToken,
                  );
                  await capture.assertCurrent();
                  clearWorldModelInvitationHandoffsForToken(claimToken);
                  setClaimToken(null);
                  setReceivedPreview(null);
                  router.replace(ROUTES.PROFILE_WORLD_MODEL);
                  setMessage("Invitation rejected.");
                })
              }
            >
              Reject invitation
            </Button>
          </div>
        )}
        <label className="block space-y-1 text-xs">
          <span className="font-semibold">Their name</span>
          <Input
            aria-label="Their name"
            disabled={busy}
            value={name}
            onChange={(e) => {
              setName(e.target.value);
              setPreview(null);
            }}
            maxLength={160}
          />
        </label>
        <label className="block space-y-1 text-xs">
          <span className="font-semibold">Public professional profile URL</span>
          <Input
            aria-label="Public professional profile URL"
            disabled={busy}
            value={sourceUrl}
            onChange={(e) => {
              setSourceUrl(e.target.value);
              setPreview(null);
            }}
            maxLength={2048}
          />
        </label>
        <label className="block space-y-1 text-xs">
          <span className="font-semibold">Introduction (optional)</span>
          <Textarea
            aria-label="Introduction (optional)"
            value={introduction}
            onChange={(e) => setIntroduction(e.target.value)}
            maxLength={500}
          />
        </label>
        <label className="flex min-h-11 items-center gap-3 text-xs">
          <Checkbox
            checked={permission}
            onCheckedChange={(v) => setPermission(v === true)}
          />
          I can use this public professional source for their invitation.
        </label>
        <Button
          size="compact"
          variant="muted"
          data-voice-control-id="pwm_preview"
          disabled={busy || !permission || !name.trim() || !sourceUrl.trim()}
          onClick={() =>
            void run(async () => {
              const capture = guard();
              const result = await WorldModelSourceService.prepare(
                { ...session, ...capture },
                {
                  name,
                  urls: [sourceUrl],
                  purpose: "invitation",
                  permitted_public_sources: true,
                },
              );
              await capture.assertCurrent();
              if (result.status === "offered") {
                setPreview(result);
                setSelected([]);
              }
            })
          }
        >
          {busy ? "Preparing…" : "Prepare preview"}
        </Button>
        {preview && (
          <div className="space-y-3 text-xs">
            <p>Select the details to include. Sources remain attached.</p>
            {preview.report.sections.flatMap((section) =>
              section.facts.map((fact, index) => {
                const id = `${section.kind}:${index}`;
                return (
                  <div key={id}>
                    <label className="flex min-h-11 items-center gap-3">
                      <Checkbox
                        checked={selected.includes(id)}
                        onCheckedChange={(v) =>
                          setSelected((rows) =>
                            v === true
                              ? [...rows, id]
                              : rows.filter((x) => x !== id),
                          )
                        }
                      />
                      {fact.statement}
                    </label>
                    {fact.sources.map((source) => (
                      <a
                        key={source.url}
                        href={source.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-flex min-h-11 items-center underline"
                      >
                        {source.title}
                      </a>
                    ))}
                  </div>
                );
              }),
            )}
          </div>
        )}
        <label className="block space-y-1 text-xs">
          <span className="font-semibold">Recipient’s email or phone with country code</span>
          <Input
            aria-label="Recipient’s email or phone with country code"
            value={contact}
            maxLength={320}
            onChange={(event) => setContact(event.target.value)}
            autoComplete="off"
          />
        </label>
        <Button
          data-voice-control-id="pwm_invite"
          size="compact"
          variant="muted"
          disabled={
            busy || !contact.trim() || !preview?.draft_id || !selected.length
          }
          onClick={() =>
            void run(async () => {
              const capture = guard();
              const result = await WorldModelInvitationsService.create(
                session,
                contact,
                {
                  preview_draft_id: preview!.draft_id!,
                  selected_fact_ids: selected,
                  introduction,
                },
              );
              await capture.assertCurrent();
              setLink(result.url);
              setContact("");
              setRevision((value) => value + 1);
            })
          }
        >
          Create invitation
        </Button>
        {link && (
          <Button
            size="compact"
            disabled={busy}
            onClick={() =>
              void run(async () => {
                const capture = guard();
                await capture.assertCurrent();
                try {
                  const delivery = await shareLink({
                    title: "Your Personal World Model",
                    text: "Claim your Personal World Model on One. You control the research and sharing.",
                    dialogTitle: "Share invitation",
                    url: link,
                  });
                  if (capture.isCurrent())
                    setMessage(
                      delivery === "copied"
                        ? "Invitation copied."
                        : "Invitation opened in your share sheet.",
                    );
                } catch (error) {
                  if (!isShareCancellationError(error)) throw error;
                }
              })
            }
          >
            Share invitation
          </Button>
        )}
        {message && <HelperText role="status">{message}</HelperText>}
        {rows.length > 0 && (
          <ul className="space-y-2">
            {rows.map((row, index) => (
              <li
                key={row.id}
                className="flex items-center justify-between gap-3 text-xs"
              >
                <span>
                  Invitation {index + 1} ·{" "}
                  {row.state === "claimed" ? "Claimed" : "Awaiting claim"}
                </span>
                <Button
                  size="compact"
                  variant="none"
                  disabled={busy}
                  onClick={() =>
                    void run(async () => {
                      const capture = guard();
                      await WorldModelInvitationsService.revoke(
                        session,
                        row.id,
                      );
                      await capture.assertCurrent();
                      setLink(null);
                      setRevision((value) => value + 1);
                    })
                  }
                >
                  Revoke
                </Button>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
