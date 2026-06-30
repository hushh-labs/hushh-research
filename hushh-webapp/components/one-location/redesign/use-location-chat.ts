"use client";

import { useCallback, useRef, useState } from "react";

import { OneLocationService } from "@/lib/one-location/service";
import {
  decryptLocationEnvelope,
  encryptLocationForRecipient,
} from "@/lib/one-location/encryption";
import type {
  ActionResult,
  ClientAction,
  PlainLocationPoint,
} from "@/lib/one-location/types";

export interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  text: string;
  stateChanged?: boolean;
  errored?: boolean;
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
}

export const LOCATION_CHAT_ERROR_TEXT =
  "Sorry — that couldn't be processed. Try rephrasing.";

export function useLocationChat(params: {
  vaultOwnerToken: string;
  userId?: string;
  onStateChanged?: () => void;
}): UseLocationChat {
  const { vaultOwnerToken, userId = "", onStateChanged } = params;
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [busy, setBusy] = useState(false);
  const [pendingAction, setPendingAction] = useState<ClientAction | null>(null);
  const [viewedPoint, setViewedPoint] = useState<PlainLocationPoint | null>(null);
  const conversationIdRef = useRef<string | null>(null);
  const lastSentRef = useRef<string | null>(null);
  const seqRef = useRef(0);

  const nextId = useCallback(() => `m-${seqRef.current++}`, []);

  const run = useCallback(
    async (message: string) => {
      setBusy(true);
      // Retry case: drop a trailing errored assistant bubble before re-asking.
      setMessages((prev) =>
        prev.length && prev[prev.length - 1]?.errored ? prev.slice(0, -1) : prev,
      );
      try {
        const result = await OneLocationService.chat({
          vaultOwnerToken,
          message,
          conversationId: conversationIdRef.current,
        });
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
        if (result.clientAction) setPendingAction(result.clientAction);
        if (result.stateChanged) onStateChanged?.();
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
    [vaultOwnerToken, onStateChanged, nextId],
  );

  const send = useCallback(
    async (raw: string) => {
      const message = raw.trim();
      if (!message || busy) return;
      lastSentRef.current = message;
      setMessages((prev) => [
        ...prev,
        { id: nextId(), role: "user", text: message },
      ]);
      await run(message);
    },
    [busy, run, nextId],
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
        if (result.stateChanged) onStateChanged?.();
      } catch {
        setMessages((prev) => [
          ...prev,
          { id: nextId(), role: "assistant", text: LOCATION_CHAT_ERROR_TEXT, errored: true },
        ]);
      } finally {
        setBusy(false);
      }
    },
    [vaultOwnerToken, onStateChanged, nextId],
  );

  const confirmAction = useCallback(async () => {
    const action = pendingAction;
    if (!action || busy) return;
    setPendingAction(null);
    try {
      if (action.type === "publish_share") {
        const point = await OneLocationService.captureCurrentPosition();
        const state = await OneLocationService.getState(vaultOwnerToken);
        for (const share of action.shares ?? []) {
          const recipient = (state.recipients ?? []).find(
            (r) => r.keyId === share.recipientKeyId,
          );
          if (!recipient?.publicKeyJwk) {
            throw new Error(`${share.label} hasn't set up location sharing yet`);
          }
          const envelope = await encryptLocationForRecipient({
            point,
            recipientPublicKeyJwk: recipient.publicKeyJwk,
            recipientKeyId: share.recipientKeyId,
          });
          await OneLocationService.storeEnvelope({
            vaultOwnerToken,
            grantId: share.grantId,
            envelope,
          });
        }
        await report({ id: action.id, type: action.type, status: "completed" });
      } else if (action.type === "view_envelope") {
        const { envelope } = await OneLocationService.viewEnvelope({
          vaultOwnerToken,
          grantId: action.grantId as string,
        });
        const point = await decryptLocationEnvelope({ userId, envelope });
        setViewedPoint(point);
        await report({ id: action.id, type: action.type, status: "completed" });
      } else if (action.type === "create_public_link") {
        const locationSnapshot = await OneLocationService.captureCurrentPosition();
        const { publicUrl } = await OneLocationService.createPublicInvite({
          vaultOwnerToken,
          durationHours: action.durationHours ?? 1,
          locationSnapshot,
        });
        await report({ id: action.id, type: action.type, status: "completed", publicUrl });
      }
    } catch (error) {
      const detail = error instanceof Error ? error.message : undefined;
      await report({ id: action.id, type: action.type, status: "failed", detail });
    }
  }, [pendingAction, busy, vaultOwnerToken, userId, report]);

  const cancelAction = useCallback(async () => {
    const action = pendingAction;
    if (!action) return;
    setPendingAction(null);
    if (action.type === "publish_share") {
      for (const share of action.shares ?? []) {
        try {
          await OneLocationService.revokeGrant({ vaultOwnerToken, grantId: share.grantId });
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
  };
}
