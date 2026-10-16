"use client";

import { useEffect, useRef, useState } from "react";
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

/** Owner-bound action runner shared by the inviter and recipient flows. */
export function useWorldModelOwnerAction({
  ownerId,
  vaultKey,
  vaultOwnerToken,
}: {
  ownerId: string;
  vaultKey: string;
  vaultOwnerToken: string;
}) {
  const [busy, setBusy] = useState(false);
  const pendingAction = useRef(false);
  const [message, setMessage] = useState("");
  const current = useRef({ ownerId, vaultKey, vaultOwnerToken });
  current.current = { ownerId, vaultKey, vaultOwnerToken };
  const active = useRef(true);
  const lifetime = useRef(new AbortController());
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
  return { busy, message, setMessage, guard, run, active, current };
}

export function WorldModelInvitations({
  ownerId,
  vaultKey,
  vaultOwnerToken,
}: {
  ownerId: string;
  vaultKey: string;
  vaultOwnerToken: string;
}) {
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [link, setLink] = useState<string | null>(null);
  const [rows, setRows] = useState<WorldModelInvitation[]>([]);
  const [revision, setRevision] = useState(0);
  const { busy, message, setMessage, guard, run, active, current } =
    useWorldModelOwnerAction({ ownerId, vaultKey, vaultOwnerToken });
  const session = { vaultKey, vaultOwnerToken };
  const emailValid = !email.trim() || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim());
  const phoneValid = !phone.trim() || /^\+[1-9]\d{7,14}$/.test(phone.trim());
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
  }, [ownerId, vaultKey, vaultOwnerToken, revision, active, current, setMessage]);
  return (
    <SettingsGroup>
      <div className="space-y-3 px-4 py-3">
        <HelperText>
          Invite someone by name and contact. They can claim the link using a
          verified email or phone, then their own model prepares for their review.
        </HelperText>
        <label className="block space-y-1 text-xs">
          <span className="font-semibold">Their name</span>
          <Input
            aria-label="Their name"
            disabled={busy}
            value={name}
            onChange={(e) => setName(e.target.value)}
            maxLength={160}
          />
        </label>
        <label className="block space-y-1 text-xs">
          <span className="font-semibold">Their email</span>
          <Input
            aria-label="Their email"
            type="email"
            disabled={busy}
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            maxLength={320}
          />
        </label>
        <label className="block space-y-1 text-xs">
          <span className="font-semibold">Their phone with country code</span>
          <Input
            aria-label="Their phone with country code"
            type="tel"
            disabled={busy}
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
            maxLength={16}
          />
        </label>
        <HelperText>Enter at least one contact. If you enter both, either one can be used to claim.</HelperText>
        <Button
          data-voice-control-id="pwm_invite"
          size="compact"
          variant="muted"
          disabled={
            busy || !name.trim() || (!email.trim() && !phone.trim()) || !emailValid || !phoneValid
          }
          onClick={() =>
            void run(async () => {
              const capture = guard();
              const result = await WorldModelInvitationsService.create(
                session,
                email.trim() || phone.trim(),
                {
                  subject_name: name.trim(),
                  ...(email.trim() && phone.trim()
                    ? { secondary_contact: phone.trim() }
                    : {}),
                },
              );
              await capture.assertCurrent();
              setLink(result.url);
              setEmail("");
              setPhone("");
              setName("");
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
                  {row.state === "claimed" ? "Claimed" : "Not claimed yet"}
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
