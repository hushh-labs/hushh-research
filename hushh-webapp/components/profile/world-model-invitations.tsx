"use client";

import { useEffect, useLayoutEffect, useMemo, useRef } from "react";
import { useWorldModelOwnerState } from "./world-model-owner-state";
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
  enabled = true,
}: {
  ownerId: string;
  vaultKey: string;
  vaultOwnerToken: string;
  enabled?: boolean;
}) {
  const ownerSession = useMemo(() => ({ live: false, pending: false, ownerId, vaultKey, vaultOwnerToken, controller: new AbortController() }), [ownerId, vaultKey, vaultOwnerToken]);
  const [busy, setBusy] = useWorldModelOwnerState(ownerSession, false);
  const [message, setMessage] = useWorldModelOwnerState(ownerSession, "");
  const current = useRef({ ownerId, vaultKey, vaultOwnerToken, enabled });
  current.current = { ownerId, vaultKey, vaultOwnerToken, enabled };
  const active = useRef(true);
  const guard = () =>
    createAgentPkmCaptureGuard({
      userId: ownerId,
      signal: ownerSession.controller.signal,
      isEnabled: () =>
        ownerSession.live && active.current && enabled && current.current.enabled &&
        current.current.ownerId === ownerId &&
        current.current.vaultKey === vaultKey &&
        current.current.vaultOwnerToken === vaultOwnerToken,
    });
  useLayoutEffect(() => {
    active.current = true;
    ownerSession.live = !!ownerId && !!vaultKey && !!vaultOwnerToken;
    ownerSession.controller = new AbortController();
    return () => {
      active.current = false;
      ownerSession.live = false; ownerSession.controller.abort();
    };
  }, [ownerSession, ownerId, vaultKey, vaultOwnerToken]);
  async function run(action: () => Promise<void>) {
    if (ownerSession.pending || !enabled || !ownerSession.live) return false;
    ownerSession.pending = true;
    const capture = guard();
    setBusy(true);
    setMessage("");
    try {
      await capture.assertCurrent();
      await action();
      return capture.isCurrent();
    } catch {
      if (capture.isCurrent())
        setMessage(
          "Couldn’t finish. Check your verified contact or try again.",
        );
      return false;
    } finally {
      ownerSession.pending = false;
      setBusy(false);
    }
  }
  return { busy, message, setMessage, guard, run, active, current, ownerSession };
}

type InvitationProps = { ownerId: string; vaultKey: string; vaultOwnerToken: string; enabled?: boolean };
const EMPTY_INVITATIONS: WorldModelInvitation[] = [];
export function useWorldModelInvitations({
  ownerId,
  vaultKey,
  vaultOwnerToken,
  enabled = true,
}: InvitationProps) {
  const { busy, message, setMessage, guard, run, active, current, ownerSession } =
    useWorldModelOwnerAction({ ownerId, vaultKey, vaultOwnerToken, enabled });
  const [name, setName] = useWorldModelOwnerState(ownerSession, "");
  const [email, setEmail] = useWorldModelOwnerState(ownerSession, "");
  const [phone, setPhone] = useWorldModelOwnerState(ownerSession, "");
  const [link, setLink] = useWorldModelOwnerState<string | null>(ownerSession, null);
  const [rows, setRows] = useWorldModelOwnerState(ownerSession, EMPTY_INVITATIONS);
  const [revision, setRevision] = useWorldModelOwnerState(ownerSession, 0);
  const session = { vaultKey, vaultOwnerToken };
  const emailValid = !email.trim() || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim());
  const phoneValid = !phone.trim() || /^\+[1-9]\d{7,14}$/.test(phone.trim());
  useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController();
    const capture = createAgentPkmCaptureGuard({
      userId: ownerId,
      signal: controller.signal,
      isEnabled: () =>
        ownerSession.live && active.current && current.current.enabled &&
        current.current.ownerId === ownerId &&
        current.current.vaultKey === vaultKey &&
        current.current.vaultOwnerToken === vaultOwnerToken,
    });
    void WorldModelInvitationsService.list({ vaultKey, vaultOwnerToken, isCurrent: capture.isCurrent, signal: controller.signal })
      .then((value) => {
        if (capture.isCurrent()) setRows(value);
      })
      .catch(() => {
        if (capture.isCurrent())
          setMessage("Invitations couldn’t be opened. Try again.");
      });
    return () => controller.abort();
  }, [ownerId, vaultKey, vaultOwnerToken, revision, active, current, setMessage, setRows, enabled, ownerSession]);
  const create = (snapshot = { name, email, phone }) => run(async () => {
    const capture = guard();
    const clean = { name: snapshot.name.trim(), email: snapshot.email.trim(), phone: snapshot.phone.trim() };
    if (!clean.name || (!clean.email && !clean.phone) || clean.name.length > 160 || clean.email.length > 320 || clean.phone.length > 16 ||
        clean.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(clean.email) || clean.phone && !/^\+[1-9]\d{7,14}$/.test(clean.phone)) throw new Error("Invalid invitation contact.");
    await capture.assertCurrent();
    const result = await WorldModelInvitationsService.create({ ...session, isCurrent: capture.isCurrent, signal: ownerSession.controller.signal }, clean.email || clean.phone,
      { subject_name: clean.name, ...(clean.email && clean.phone ? { secondary_contact: clean.phone } : {}) });
    await capture.assertCurrent();
    setLink(result.url); setEmail(""); setPhone(""); setName(""); setRevision(value => value + 1);
  });
  const share = () => run(async () => {
    if (!link) return;
    const capture = guard(); await capture.assertCurrent();
    try {
      const delivery = await shareLink({ title: "Your Personal World Model", text: "Claim your Personal World Model on One. You control the research and sharing.", dialogTitle: "Share invitation", url: link });
      if (capture.isCurrent()) setMessage(delivery === "copied" ? "Invitation copied." : "Invitation opened in your share sheet.");
    } catch (error) { if (!isShareCancellationError(error)) throw error; }
  });
  const revoke = (id: string) => run(async () => {
    const capture = guard(); await capture.assertCurrent(); await WorldModelInvitationsService.revoke({ ...session, isCurrent: capture.isCurrent, signal: ownerSession.controller.signal }, id);
    await capture.assertCurrent(); setLink(null); setRevision(value => value + 1);
  });
  return { name, setName, email, setEmail, phone, setPhone, link, rows, busy, message, emailValid, phoneValid, create, share, revoke };
}

export function WorldModelInvitations(props: InvitationProps) {
  const { name, setName, email, setEmail, phone, setPhone, link, rows, busy, message, emailValid, phoneValid, create, share, revoke } = useWorldModelInvitations(props);
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
          onClick={() => void create()}
        >
          Create invitation
        </Button>
        {link && (
          <Button
            size="compact"
            disabled={busy}
            onClick={() => void share()}
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
                  onClick={() => void revoke(row.id)}
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
