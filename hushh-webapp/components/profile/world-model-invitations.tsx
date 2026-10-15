"use client";

import { useEffect, useRef, useState } from "react";
import { SettingsGroup } from "@/components/profile/settings-ui";
import { Button } from "@/lib/morphy-ux/button";
import { HelperText } from "@/components/app-ui/typography";
import { Checkbox } from "@/components/ui/checkbox";
import { Textarea } from "@/components/ui/textarea";
import { WorldModelSourceService } from "@/lib/services/world-model-source-service";
import type { ProfileResearchResult } from "@/lib/services/profile-research-service";
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
  return { busy, message, setMessage, guard, run, active, current, lifetime };
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
  const [name, setName] = useState(""),
    [sourceUrl, setSourceUrl] = useState(""),
    [introduction, setIntroduction] = useState("");
  const [preview, setPreview] = useState<Extract<
    ProfileResearchResult,
    { status: "offered" }
  > | null>(null);
  const [selected, setSelected] = useState<string[]>([]),
    [permission, setPermission] = useState(false);
  const [contact, setContact] = useState("");
  const [link, setLink] = useState<string | null>(null);
  const [rows, setRows] = useState<WorldModelInvitation[]>([]);
  const [revision, setRevision] = useState(0);
  const { busy, message, setMessage, guard, run, active, current, lifetime } =
    useWorldModelOwnerAction({ ownerId, vaultKey, vaultOwnerToken });
  const session = { vaultKey, vaultOwnerToken };
  useEffect(() => {
    const controller = new AbortController();
    const capture = createAgentPkmCaptureGuard({
      userId: ownerId,
      signal: controller.signal,
      isEnabled: () =>
        active.current &&
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
  }, [ownerId, vaultKey, vaultOwnerToken, revision, active, current, setMessage]);
  return (
    <SettingsGroup>
      <div className="space-y-3 px-4 py-3">
        <HelperText>
          Prepare a short preview from one public professional page, then send
          an invitation to their email or phone. They control their own model.
        </HelperText>
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
          <span className="font-semibold">Public profile link</span>
          <Input
            aria-label="Public profile link"
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
          This page is public and I’m allowed to use it.
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
                { ...session, isCurrent: capture.isCurrent, signal: lifetime.current.signal },
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
                        { ...session, isCurrent: capture.isCurrent, signal: lifetime.current.signal },
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
