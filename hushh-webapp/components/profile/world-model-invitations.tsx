"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { SettingsGroup } from "@/components/profile/settings-ui";
import { Button } from "@/lib/morphy-ux/button";
import { HelperText } from "@/components/app-ui/typography";
import { Input } from "@/components/ui/input";
import { createAgentPkmCaptureGuard } from "@/lib/agent/agent-pkm-capture-runtime";
import {
  WorldModelInvitationsService,
  type WorldModelInvitation,
} from "@/lib/services/world-model-invitations-service";
import { shareLink, isShareCancellationError } from "@/lib/share/share-link";
import { ROUTES } from "@/lib/navigation/routes";

export function WorldModelInvitations({
  ownerId,
  vaultKey,
  vaultOwnerToken,
}: {
  ownerId: string;
  vaultKey: string;
  vaultOwnerToken: string;
}) {
  const router = useRouter();
  const query = useSearchParams();
  const claimToken = query.get("claim");
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
    <SettingsGroup title="Invite someone">
      <div className="space-y-3 px-4 py-3">
        <HelperText>
          They verify their contact and choose when to start; findings stay
          private until shared.
        </HelperText>
        {claimToken && (
          <div className="space-y-2 rounded-lg border border-border p-3">
            <p className="text-[13px]">
              Verify your contact to claim your model; you choose when research
              starts.
            </p>
            <Button
              data-voice-control-id="pwm_claim"
              size="compact"
              disabled={busy}
              onClick={() =>
                void run(async () => {
                  const capture = guard();
                  await WorldModelInvitationsService.claim(session, claimToken);
                  await capture.assertCurrent();
                  setMessage("Model claimed. Nothing has been shared.");
                  router.replace(ROUTES.PROFILE_WORLD_MODEL);
                })
              }
            >
              Claim my model
            </Button>
          </div>
        )}
        <label className="block space-y-1 text-xs">
          <span>Email or phone with country code</span>
          <Input
            aria-label="Email or phone with country code"
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
          disabled={busy || !contact.trim()}
          onClick={() =>
            void run(async () => {
              const capture = guard();
              const result = await WorldModelInvitationsService.create(
                session,
                contact,
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
                        : "Ready to share.",
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
      </div>
    </SettingsGroup>
  );
}
