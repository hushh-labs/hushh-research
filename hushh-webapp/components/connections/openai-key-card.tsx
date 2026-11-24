"use client";

import {
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";

import { SettingsGroup, SettingsRow } from "@/components/app-ui/settings-ui";
import { OwnerKeyContent, type KeyNotice } from "./owner-key-content";
import { RuntimeProviderMark } from "@/components/brand/runtime-provider-mark";
import { CaretDownIcon } from "@/components/icons";
import { Badge } from "@/components/ui/badge";
import {
  isValidatedAuthSessionOwnerCurrent,
  snapshotValidatedAuthSessionOwner,
} from "@/lib/auth/session-owner";
import {
  notifyGeminiRuntimeConfigurationChanged,
  onGeminiRuntimeConfigurationChanged,
} from "@/lib/connections/gemini-runtime-configuration";
import { RUNTIME_PROVIDER_CATALOG } from "@/lib/connections/runtime-provider-catalog";
import { dispatchFeedStateChanged } from "@/lib/feed/feed-events";
import { morphyToast as toast } from "@/lib/morphy-ux/morphy";
import {
  agentUpdateApprovalToast,
  approveAgentUpdate,
  openAzureUpdateSignInPopup,
} from "@/lib/one/agent-update-approval";
import {
  aiSelectionRefusalMessage,
  clearAgentAiSelectionFor,
  loadAgentAiState,
  sendAiSelectionToAgent,
  type AgentAiReadiness,
  type AgentAiSelection,
} from "@/lib/one/ai-selection-agent";
import {
  hasSavedOpenAiKey,
  recordOpenAiSelection,
  removeOpenAiSelection,
} from "@/lib/one/ai-selection-vault";

const OPENAI_MARK = RUNTIME_PROVIDER_CATALOG.find(
  (entry) => entry.id === "openai",
)!;

export type OpenAiKeyCardProps = {
  userId?: string | null;
  vaultKey?: string | null;
  vaultOwnerToken?: string | null;
  needsVaultCreation: boolean;
  needsUnlock: boolean;
  onRequestVaultUnlock: () => void;
  onRequestVaultCreation: () => void;
  defaultModel: string | null;
  onChanged?: () => void | Promise<void>;
  onAccepted?: () => void;
  onPendingChange?: (
    pending: boolean,
    provider: "openai",
  ) => void;
  provider?: "openai";
  /** Reuse the connection rows inside the single AI selection section. */
  ungrouped?: boolean;
};

type Notice = KeyNotice;

export function OpenAiKeyCard(props: OpenAiKeyCardProps) {
  // A typed key and owner-specific results must not survive an account switch.
  const owner = snapshotValidatedAuthSessionOwner();
  return (
    <OwnerOpenAiKeyCard
      key={`${props.userId ?? "signed-out"}:${owner?.generation ?? "unresolved"}:openai`}
      {...props}
    />
  );
}

function OwnerOpenAiKeyCard({
  userId,
  vaultKey,
  vaultOwnerToken,
  needsVaultCreation,
  onRequestVaultUnlock,
  onRequestVaultCreation,
  defaultModel,
  onChanged,
  onAccepted,
  onPendingChange,
  ungrouped = false,
}: OpenAiKeyCardProps) {
  const provider = "openai" as const;
  const providerName = "OpenAI";
  const statusId = "openai-key-status";
  const [expanded, setExpanded] = useState(false);
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);
  const captureOwnerGuard = useCallback(() => {
    const owner = snapshotValidatedAuthSessionOwner();
    return () =>
      Boolean(
        mountedRef.current &&
        owner &&
        owner.userId === userId &&
        isValidatedAuthSessionOwnerCurrent(owner),
      );
  }, [userId]);
  const [readiness, setReadiness] = useState<AgentAiReadiness | null>(null);
  const [selection, setSelection] = useState<AgentAiSelection | null>(null);
  const [hasSavedKey, setHasSavedKey] = useState(false);
  const [draftKey, setDraftKey] = useState("");
  const [busy, setBusy] = useState<"checking" | "removing" | "updating" | null>(
    null,
  );
  useEffect(() => {
    onPendingChange?.(busy !== null, provider);
    return () => onPendingChange?.(false, provider);
  }, [busy, onPendingChange, provider]);
  const [notice, setNotice] = useState<Notice>(null);
  const vault =
    userId && vaultKey && vaultOwnerToken
      ? { userId, vaultKey, vaultOwnerToken }
      : null;
  const inUse = Boolean(
    selection?.configured && selection.provider === provider,
  );

  const load = useCallback(async () => {
    const ownerIsCurrent = captureOwnerGuard();
    if (!ownerIsCurrent()) return;
    const [state, saved] = await Promise.all([
      loadAgentAiState(provider),
      userId && vaultKey && vaultOwnerToken
        ? hasSavedOpenAiKey({
            userId,
            vaultKey,
            vaultOwnerToken,
          })
        : Promise.resolve(false),
    ]);
    if (!ownerIsCurrent()) return;
    setReadiness(state.readiness);
    setSelection(state.selection);
    setHasSavedKey(saved);
  }, [captureOwnerGuard, userId, vaultKey, vaultOwnerToken, provider]);

  useEffect(() => {
    void load();
  }, [load]);
  useEffect(
    () => onGeminiRuntimeConfigurationChanged(() => void load()),
    [load],
  );

  const requestVault = () =>
    needsVaultCreation ? onRequestVaultCreation() : onRequestVaultUnlock();

  const announceChange = async (message: string) => {
    notifyGeminiRuntimeConfigurationChanged();
    await onChanged?.();
    toast.success(message);
  };

  const checkAndUse = async () => {
    const ownerIsCurrent = captureOwnerGuard();
    if (!ownerIsCurrent() || busy) return;
    if (!vault) return requestVault();
    const apiKey = draftKey.trim();
    if (!apiKey)
      return setNotice({
        tone: "error",
        text: `Enter your ${providerName} API key.`,
      });
    setBusy("checking");
    setNotice(null);
    try {
      // The agent's live check with OpenAI is the validation; the Vault records
      // only a selection the agent has accepted.
      const outcome = await sendAiSelectionToAgent({
        provider,
        model: null,
        apiKey,
        transport: null,
        vertexProject: null,
        vertexLocation: null,
      });
      if (!ownerIsCurrent()) return;
      if (!outcome.ok) {
        setNotice({
          tone: "error",
          text:
            aiSelectionRefusalMessage(outcome.code, providerName) ??
            `${providerName} could not be set up. Try again.`,
        });
        return;
      }
      onAccepted?.();
      setSelection({
        configured: true,
        provider,
        model: outcome.model,
        checkedAtMs: outcome.checkedAtMs,
        lastFailure: null,
      });
      try {
        await recordOpenAiSelection({ ...vault, apiKey, model: null });
      } catch {
        // The pod already durably owns the accepted choice. A vault backup failure
        // must not silently switch a working private agent onto another provider.
        if (ownerIsCurrent())
          setNotice({
            tone: "error",
            text: "Your agent accepted the key, but its vault backup could not be saved. Retry saving before changing devices.",
          });
        return;
      }
      if (!ownerIsCurrent()) return;
      setDraftKey("");
      setHasSavedKey(true);
      setSelection({
        configured: true,
        provider,
        model: outcome.model,
        checkedAtMs: outcome.checkedAtMs,
        lastFailure: null,
      });
      await announceChange(`Using ${providerName} on your agent.`);
    } finally {
      if (mountedRef.current) setBusy(null);
    }
  };

  const remove = async () => {
    const ownerIsCurrent = captureOwnerGuard();
    if (!ownerIsCurrent() || busy) return;
    if (!vault) return requestVault();
    setBusy("removing");
    setNotice(null);
    try {
      // Stop the agent first; a key it may still be using is never reported removed.
      if ((await clearAgentAiSelectionFor(provider)) === "failed") {
        if (ownerIsCurrent())
          setNotice({
            tone: "error",
            text: "Agent One could not be reached, so it may still use this key. Try again.",
          });
        return;
      }
      await removeOpenAiSelection(vault);
      if (!ownerIsCurrent()) return;
      setHasSavedKey(false);
      setSelection((current) =>
        current?.provider === provider ? null : current,
      );
      await announceChange(`Your ${providerName} key was removed.`);
    } catch {
      if (ownerIsCurrent())
        setNotice({
          tone: "error",
          text: `Your ${providerName} key could not be removed from your vault. Try again.`,
        });
    } finally {
      if (mountedRef.current) setBusy(null);
    }
  };

  // The owner-approved update path Settings uses. An Azure agent's Microsoft
  // sign-in opens in a popup this click opens before any await (popup blockers
  // need the gesture), so the person stays on this card; only a blocked popup
  // falls back to sending this tab to Microsoft.
  const approveUpdate = async () => {
    const ownerIsCurrent = captureOwnerGuard();
    if (
      !ownerIsCurrent() ||
      busy ||
      readiness?.kind !== "needs_update" ||
      !readiness.update.releaseId
    )
      return;
    const { releaseId, deploymentTarget } = readiness.update;
    const popup = openAzureUpdateSignInPopup(deploymentTarget);
    setBusy("updating");
    const request = approveAgentUpdate({
      deploymentTarget,
      releaseId,
      idempotencyKey: crypto.randomUUID(),
      popup,
    });
    toast.promise(request, agentUpdateApprovalToast(deploymentTarget));
    try {
      await request;
      dispatchFeedStateChanged();
      if (ownerIsCurrent()) void load();
    } catch {
      // The promise toast owns the error.
    } finally {
      if (mountedRef.current) setBusy(null);
    }
  };

  const lastFailure =
    inUse && selection?.lastFailure
      ? aiSelectionRefusalMessage(selection.lastFailure, providerName)
      : null;

  const content = (
    <>
      <SettingsRow
        asChild={ungrouped}
        leading={<RuntimeProviderMark provider={OPENAI_MARK} className="!h-8 !w-8" />}
        title={ungrouped ? providerName : "Use your own key"}
        description={
          inUse
            ? `Using ${providerName} on your agent${selection?.model ? ` (${selection.model})` : ""}.`
            : ungrouped ? "Use your own key." : "Your key stays locked to you and runs on Agent One."
        }
        trailing={inUse ? <Badge variant="secondary">In use</Badge> : ungrouped ? <CaretDownIcon aria-hidden className="h-4 w-4" /> : null}
        testId={`profile-${provider}-key-row`}
      >
        {ungrouped ? <button type="button" aria-expanded={expanded} disabled={busy !== null}
          onClick={() => setExpanded((value) => !value)} /> : null}
      </SettingsRow>
      {!ungrouped || expanded ? <div className="space-y-2 px-[var(--settings-row-px)] py-[var(--settings-row-py)]">
        <OwnerKeyContent readiness={readiness} providerName={providerName} busy={busy} vault={Boolean(vault)} needsVaultCreation={needsVaultCreation} lastFailure={lastFailure} provider={provider} draftKey={draftKey} notice={notice} defaultModel={defaultModel} statusId={statusId} hasSavedKey={hasSavedKey} inUse={inUse} load={load} approveUpdate={approveUpdate} requestVault={requestVault} setDraftKey={setDraftKey} setNotice={setNotice} checkAndUse={checkAndUse} remove={remove} />
      </div> : null}
    </>
  );
  return ungrouped ? content : (
    <SettingsGroup title={providerName} description="Available now"
      testId={`profile-${provider}-runtime`} separatorInset>{content}</SettingsGroup>
  );
}
