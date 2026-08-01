"use client";

import { useCallback, useRef, useState } from "react";

import { publicInviteUrlLabel } from "@/lib/one-location/public-invite-url";
import { OneLocationService } from "@/lib/one-location/service";
import {
  RECIPIENT_KEY_UNAVAILABLE_MESSAGE,
  decryptLocationEnvelope,
  encryptLocationForRecipient,
  ensureVaultSyncedRecipientKey,
} from "@/lib/one-location/encryption";
import { bootstrapCurrentUserLocationRecipientKey } from "@/lib/one-location/key-bootstrap";
import {
  prepareLocationPointForSharing,
  validateLocationPointForGrant,
} from "@/lib/one-location/location-precision";
import { executePrivateLocationAction } from "@/lib/one-location/client-action-executor";
import { readOneLocationControlState } from "@/lib/one-location/location-control-state";
import type {
  ActionResult,
  ClientAction,
  ClientPrompt,
  PlainLocationPoint,
  SelectionResult,
} from "@/lib/one-location/types";
import { describeSelection } from "@/lib/agent/describe-selection";
import {
  isSosShareReadyRecipient,
  runSosPanic,
  selectSmsRecipients,
  selectSosConnectedRecipients,
} from "@/lib/one-location/sos-trigger";
import { runCheckIn } from "@/lib/one-location/check-in-trigger";

export interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  text: string;
  stateChanged?: boolean;
  errored?: boolean;
  kind?: "selection";
}

export interface UseLocationChat {
  messages: ChatMessage[];
  busy: boolean;
  send: (message: string) => Promise<void>;
  retry: () => Promise<void>;
  clear: () => void;
  pendingAction: ClientAction | null;
  confirmAction: () => Promise<void>;
  cancelAction: () => Promise<void>;
  viewedPoint: PlainLocationPoint | null;
  pendingPrompt: ClientPrompt | null;
  answerPrompt: (refs: Record<string, unknown>[]) => Promise<void>;
  confirmPrompt: (yes: boolean) => Promise<void>;
  cancelPrompt: () => Promise<void>;
}

export const LOCATION_CHAT_ERROR_TEXT =
  "Sorry — that couldn't be processed. Try rephrasing.";

export function useLocationChat(params: {
  vaultOwnerToken: string;
  userId?: string;
  vaultKey?: string | null;
  onStateChanged?: () => void;
}): UseLocationChat {
  const {
    vaultOwnerToken,
    userId = "",
    vaultKey = null,
    onStateChanged,
  } = params;
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [busy, setBusy] = useState(false);
  const [pendingAction, setPendingAction] = useState<ClientAction | null>(null);
  const [pendingPrompt, setPendingPrompt] = useState<ClientPrompt | null>(null);
  const [viewedPoint, setViewedPoint] = useState<PlainLocationPoint | null>(
    null,
  );
  const conversationIdRef = useRef<string | null>(null);
  const lastSentRef = useRef<string | null>(null);
  const seqRef = useRef(0);

  const nextId = useCallback(() => `m-${seqRef.current++}`, []);

  const applyResult = useCallback(
    (result: Awaited<ReturnType<typeof OneLocationService.chat>>) => {
      conversationIdRef.current = result.conversationId;
      setMessages((prev) => [
        ...prev,
        {
          id: nextId(),
          role: "assistant",
          text: result.response,
          stateChanged: result.stateChanged,
        },
      ]);
      setPendingAction(result.clientAction ?? null);
      setPendingPrompt(result.clientPrompt ?? null);
      if (result.stateChanged) onStateChanged?.();
    },
    [nextId, onStateChanged],
  );

  const run = useCallback(
    async (message: string) => {
      setBusy(true);
      // Retry case: drop a trailing errored assistant bubble before re-asking.
      setMessages((prev) =>
        prev.length && prev[prev.length - 1]?.errored
          ? prev.slice(0, -1)
          : prev,
      );
      try {
        const result = await OneLocationService.chat({
          vaultOwnerToken,
          message,
          conversationId: conversationIdRef.current,
        });
        applyResult(result);
      } catch {
        setMessages((prev) => [
          ...prev,
          {
            id: nextId(),
            role: "assistant",
            text: LOCATION_CHAT_ERROR_TEXT,
            errored: true,
          },
        ]);
      } finally {
        setBusy(false);
      }
    },
    [vaultOwnerToken, applyResult, nextId],
  );

  const retry = useCallback(async () => {
    if (busy || !lastSentRef.current) return;
    await run(lastSentRef.current);
  }, [busy, run]);

  const clear = useCallback(() => {
    setMessages([]);
    conversationIdRef.current = null;
    lastSentRef.current = null;
    setPendingAction(null);
    setPendingPrompt(null);
    setViewedPoint(null);
  }, []);

  const report = useCallback(
    async (actionResult: ActionResult) => {
      setBusy(true);
      try {
        const result = await OneLocationService.chat({
          vaultOwnerToken,
          conversationId: conversationIdRef.current,
          actionResult,
        });
        applyResult(result);
      } catch {
        setMessages((prev) => [
          ...prev,
          {
            id: nextId(),
            role: "assistant",
            text: LOCATION_CHAT_ERROR_TEXT,
            errored: true,
          },
        ]);
      } finally {
        setBusy(false);
      }
    },
    [vaultOwnerToken, applyResult, nextId],
  );

  const reportSelection = useCallback(
    async (selectionResult: SelectionResult) => {
      setBusy(true);
      setPendingPrompt(null);
      try {
        const result = await OneLocationService.chat({
          vaultOwnerToken,
          conversationId: conversationIdRef.current,
          selectionResult,
        });
        applyResult(result);
      } catch {
        setMessages((prev) => [
          ...prev,
          {
            id: nextId(),
            role: "assistant",
            text: LOCATION_CHAT_ERROR_TEXT,
            errored: true,
          },
        ]);
      } finally {
        setBusy(false);
      }
    },
    [vaultOwnerToken, applyResult, nextId],
  );

  const send = useCallback(
    async (raw: string) => {
      const message = raw.trim();
      if (!message || busy) return;
      setMessages((prev) => [
        ...prev,
        { id: nextId(), role: "user", text: message },
      ]);
      const prompt = pendingPrompt;
      if (prompt) {
        await reportSelection({
          id: prompt.id,
          kind: prompt.kind,
          freeText: message,
          status: "answered",
        });
        return;
      }
      lastSentRef.current = message;
      await run(message);
    },
    [busy, run, nextId, pendingPrompt, reportSelection],
  );

  const answerPrompt = useCallback(
    async (refs: Record<string, unknown>[]) => {
      const prompt = pendingPrompt;
      if (!prompt || busy) return;
      const display = describeSelection(prompt, { selected: refs });
      setMessages((prev) => [
        ...prev,
        { id: nextId(), role: "user", text: display, kind: "selection" },
      ]);
      await reportSelection({
        id: prompt.id,
        kind: prompt.kind,
        selected: refs,
        status: "answered",
        display,
      });
    },
    [pendingPrompt, busy, reportSelection, nextId],
  );

  const confirmPrompt = useCallback(
    async (yes: boolean) => {
      const prompt = pendingPrompt;
      if (!prompt || busy) return;
      const display = describeSelection(prompt, { confirmed: yes });
      setMessages((prev) => [
        ...prev,
        { id: nextId(), role: "user", text: display, kind: "selection" },
      ]);
      await reportSelection({
        id: prompt.id,
        kind: prompt.kind,
        confirmed: yes,
        status: "answered",
        display,
      });
    },
    [pendingPrompt, busy, reportSelection, nextId],
  );

  const cancelPrompt = useCallback(async () => {
    const prompt = pendingPrompt;
    if (!prompt || busy) return;
    const display = describeSelection(prompt, { status: "cancelled" });
    setMessages((prev) => [
      ...prev,
      { id: nextId(), role: "user", text: display, kind: "selection" },
    ]);
    await reportSelection({
      id: prompt.id,
      kind: prompt.kind,
      status: "cancelled",
      display,
    });
  }, [pendingPrompt, busy, reportSelection, nextId]);

  const confirmAction = useCallback(async () => {
    const action = pendingAction;
    if (!action || busy) return;
    setPendingAction(null);
    try {
      if (action.type === "publish_share") {
        const outcome = await executePrivateLocationAction({
          action,
          vaultOwnerToken,
          userId,
        });
        await report({
          id: action.id,
          type: action.type,
          status: "completed",
          detail:
            outcome.successfulCount < outcome.totalCount
              ? `${outcome.successfulCount} of ${outcome.totalCount} private shares started. ${outcome.failureDetails?.join(" ") ?? ""}`.trim()
              : undefined,
          durationHours: action.shares?.[0]?.durationHours,
          locationMode: action.shares?.[0]?.locationMode,
        });
      } else if (action.type === "view_envelope") {
        if (!userId) {
          await report({
            id: action.id,
            type: action.type,
            status: "failed",
            detail: "userId not configured",
          });
          return;
        }
        const grantId = action.grantId;
        if (!grantId) throw new Error("view_envelope action missing grantId");
        const { envelope } = await OneLocationService.viewEnvelope({
          vaultOwnerToken,
          grantId,
        });
        const state = await OneLocationService.getState(vaultOwnerToken);
        const grant = (state.receivedGrants ?? []).find(
          (candidate) =>
            candidate.id === grantId && candidate.status === "active",
        );
        if (!grant) {
          throw new Error("This location permission is no longer active");
        }
        const decryptAndValidate = async () =>
          validateLocationPointForGrant({
            point: await decryptLocationEnvelope({ userId, envelope }),
            grant,
          });
        try {
          const point = await decryptAndValidate();
          setViewedPoint(point);
          await report({
            id: action.id,
            type: action.type,
            status: "completed",
          });
        } catch (decryptError) {
          if (
            decryptError instanceof Error &&
            decryptError.message === RECIPIENT_KEY_UNAVAILABLE_MESSAGE
          ) {
            // Brand-new device: try to recover the vault-synced key shared across
            // the user's devices and retry once before giving up.
            if (vaultKey) {
              try {
                if (state.myRecipientKey?.encryptedPrivateKeyJwk) {
                  await ensureVaultSyncedRecipientKey({
                    userId,
                    vaultKey,
                    remoteBackup: state.myRecipientKey,
                  });
                  const point = await decryptAndValidate();
                  setViewedPoint(point);
                  await report({
                    id: action.id,
                    type: action.type,
                    status: "completed",
                  });
                  return;
                }
              } catch {
                // Fall through to re-register + actionable message.
              }
            }
            // Key rotated / not recoverable: re-register our current key so future
            // shares work, and report an actionable message (not a raw crypto error).
            void bootstrapCurrentUserLocationRecipientKey({
              userId,
              vaultOwnerToken,
              vaultKey,
            }).catch(() => {});
            await report({
              id: action.id,
              type: action.type,
              status: "failed",
              detail:
                "Couldn't open this live location — the secure key changed. Ask them to share again.",
            });
            return;
          }
          throw decryptError;
        }
      } else if (action.type === "create_public_link") {
        if (readOneLocationControlState(userId).paused) {
          throw new Error(
            "Location is paused on this device. Resume it before capturing a snapshot.",
          );
        }
        const locationMode = action.locationMode ?? "approximate";
        const point = await OneLocationService.captureCurrentPosition();
        const permission = await OneLocationService.getPermissionState();
        if (readOneLocationControlState(userId).paused) {
          throw new Error(
            "Location was paused before the snapshot could be created.",
          );
        }
        if (locationMode === "precise" && permission.precise === false) {
          throw new Error(
            "Turn on Precise Location in device settings to capture a precise point.",
          );
        }
        const locationSnapshot = prepareLocationPointForSharing(
          point,
          locationMode,
        );
        const response = await OneLocationService.createPublicInvite({
          vaultOwnerToken,
          durationHours: action.durationHours ?? 1,
          locationSnapshot,
        });
        if (readOneLocationControlState(userId).paused) {
          await OneLocationService.revokePublicInvite({
            vaultOwnerToken,
            inviteId: response.invite.id,
          }).catch(() => undefined);
          throw new Error(
            "Location was paused before the one-time link completed.",
          );
        }
        await report({
          id: action.id,
          type: action.type,
          status: "completed",
          publicUrl: publicInviteUrlLabel(response.publicUrl),
          durationHours: action.durationHours ?? 1,
          locationMode,
        });
      } else if (action.type === "request_device_location_permission") {
        const permission = await OneLocationService.requestLocationPermission();
        await report({
          id: action.id,
          type: action.type,
          status: permission.state === "granted" ? "completed" : "cancelled",
          detail: permission.state,
        });
      } else if (action.type === "sos_panic") {
        if (!userId) throw new Error("Sign in again before sharing location.");
        const state = await OneLocationService.getState(vaultOwnerToken);
        const connected = selectSosConnectedRecipients(
          state.recipients ?? [],
          state.networkConnections,
          userId || null,
        );
        const ready = selectSmsRecipients(
          connected,
          state.smsContactUserIds,
        ).filter(isSosShareReadyRecipient);
        if (!ready.length) {
          await report({
            id: action.id,
            type: action.type,
            status: "cancelled",
          });
          return;
        }
        const point = await OneLocationService.captureCurrentPosition();
        const incident = await runSosPanic({
          userId,
          vaultOwnerToken,
          recipients: ready,
          point,
          operationId: action.id,
          prepareEnvelope: async (recipient, capturedPoint) =>
            encryptLocationForRecipient({
              point: prepareLocationPointForSharing(capturedPoint, "precise"),
              recipientPublicKeyJwk: recipient.publicKeyJwk,
              recipientKeyId: recipient.keyId,
            }),
        });
        await report({
          id: action.id,
          type: action.type,
          status: "completed",
          detail:
            incident.grantIds.length < ready.length
              ? `SOS location reached ${incident.grantIds.length} of ${ready.length} contacts.`
              : undefined,
        });
      } else if (action.type === "check_in") {
        if (!userId) throw new Error("Sign in again before sharing location.");
        const state = await OneLocationService.getState(vaultOwnerToken);
        const connected = selectSosConnectedRecipients(
          state.recipients ?? [],
          state.networkConnections,
          userId || null,
        );
        const ready = connected.filter(isSosShareReadyRecipient);
        if (!ready.length) {
          await report({
            id: action.id,
            type: action.type,
            status: "cancelled",
          });
          return;
        }
        const point = await OneLocationService.captureCurrentPosition();
        const grantIds = await runCheckIn({
          userId,
          vaultOwnerToken,
          recipients: ready,
          point,
          durationHours: Number(action.durationHours) || 1,
          note: action.note ?? null,
          operationId: action.id,
          prepareEnvelope: async (recipient, capturedPoint) =>
            encryptLocationForRecipient({
              point: prepareLocationPointForSharing(capturedPoint, "precise"),
              recipientPublicKeyJwk: recipient.publicKeyJwk,
              recipientKeyId: recipient.keyId,
            }),
        });
        await report({
          id: action.id,
          type: action.type,
          status: "completed",
          detail:
            grantIds.length < ready.length
              ? `Checked in with ${grantIds.length} of ${ready.length} contacts.`
              : undefined,
        });
      }
    } catch (error) {
      const detail = error instanceof Error ? error.message : undefined;
      await report({
        id: action.id,
        type: action.type,
        status: "failed",
        detail,
      });
    }
  }, [pendingAction, busy, vaultOwnerToken, userId, vaultKey, report]);

  const cancelAction = useCallback(async () => {
    const action = pendingAction;
    if (!action) return;
    setPendingAction(null);
    if (action.type === "publish_share") {
      for (const share of action.shares ?? []) {
        if (!share.grantId) continue;
        try {
          await OneLocationService.revokeGrant({
            vaultOwnerToken,
            grantId: share.grantId,
          });
        } catch {
          // best-effort cleanup; ignore
        }
      }
    }
    await report({ id: action.id, type: action.type, status: "cancelled" });
  }, [pendingAction, vaultOwnerToken, report]);

  return {
    messages,
    busy,
    send,
    retry,
    clear,
    pendingAction,
    confirmAction,
    cancelAction,
    viewedPoint,
    pendingPrompt,
    answerPrompt,
    confirmPrompt,
    cancelPrompt,
  };
}
