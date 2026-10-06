"use client";

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";

import { SettingsGroup, SettingsRow } from "@/components/app-ui/settings-ui";
import { HelperText } from "@/components/app-ui/typography";
import { RuntimeProviderMark } from "@/components/brand/runtime-provider-mark";
import { SpinnerGapIcon as Loader2, TrashIcon as Trash2 } from "@/components/icons";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
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
import { Button } from "@/lib/morphy-ux/button";
import { morphyToast as toast } from "@/lib/morphy-ux/morphy";
import { ROUTES } from "@/lib/navigation/routes";
import {
  agentUpdateApprovalToast,
  approveAgentUpdate,
  openAzureUpdateSignInPopup,
} from "@/lib/one/agent-update-approval";
import {
  aiSelectionRefusalMessage,
  clearAgentAiSelection,
  clearAgentAiSelectionFor,
  loadAgentAiState,
  sendAiSelectionToAgent,
  type AgentAiReadiness,
  type AgentAiSelection,
} from "@/lib/one/ai-selection-agent";
import { hasSavedOpenAiKey, recordOpenAiSelection, removeOpenAiSelection } from "@/lib/one/ai-selection-vault";

const OPENAI_MARK = RUNTIME_PROVIDER_CATALOG.find((entry) => entry.id === "openai")!;
const STATUS_ID = "openai-key-status";

export type OpenAiKeyCardProps = {
  userId?: string | null;
  vaultKey?: string | null;
  vaultOwnerToken?: string | null;
  needsVaultCreation: boolean;
  needsUnlock: boolean;
  onRequestVaultUnlock: () => void;
  onRequestVaultCreation: () => void;
  defaultModel: string | null;
  onChanged?: () => void;
};

type Notice = { tone: "error" | "status"; text: string } | null;

export function OpenAiKeyCard(props: OpenAiKeyCardProps) {
  // A typed key and owner-specific results must not survive an account switch.
  const owner = snapshotValidatedAuthSessionOwner();
  return <OwnerOpenAiKeyCard key={`${props.userId ?? "signed-out"}:${owner?.generation ?? "unresolved"}`} {...props} />;
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
}: OpenAiKeyCardProps) {
  const router = useRouter();
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);
  const captureOwnerGuard = useCallback(() => {
    const owner = snapshotValidatedAuthSessionOwner();
    return () => Boolean(mountedRef.current && owner && owner.userId === userId && isValidatedAuthSessionOwnerCurrent(owner));
  }, [userId]);
  const [readiness, setReadiness] = useState<AgentAiReadiness | null>(null);
  const [selection, setSelection] = useState<AgentAiSelection | null>(null);
  const [hasSavedKey, setHasSavedKey] = useState(false);
  const [draftKey, setDraftKey] = useState("");
  const [busy, setBusy] = useState<"checking" | "removing" | "updating" | null>(null);
  const [notice, setNotice] = useState<Notice>(null);
  const vault = userId && vaultKey && vaultOwnerToken ? { userId, vaultKey, vaultOwnerToken } : null;
  const inUse = Boolean(selection?.configured && selection.provider === "openai");

  const load = useCallback(async () => {
    const ownerIsCurrent = captureOwnerGuard();
    if (!ownerIsCurrent()) return;
    const [state, saved] = await Promise.all([
      loadAgentAiState("openai"),
      userId && vaultKey && vaultOwnerToken
        ? hasSavedOpenAiKey({ userId, vaultKey, vaultOwnerToken })
        : Promise.resolve(false),
    ]);
    if (!ownerIsCurrent()) return;
    setReadiness(state.readiness);
    setSelection(state.selection);
    setHasSavedKey(saved);
  }, [captureOwnerGuard, userId, vaultKey, vaultOwnerToken]);

  useEffect(() => {
    void load();
  }, [load]);
  useEffect(() => onGeminiRuntimeConfigurationChanged(() => void load()), [load]);

  const requestVault = () => (needsVaultCreation ? onRequestVaultCreation() : onRequestVaultUnlock());

  const announceChange = (message: string) => {
    notifyGeminiRuntimeConfigurationChanged();
    onChanged?.();
    toast.success(message);
  };

  const checkAndUse = async () => {
    const ownerIsCurrent = captureOwnerGuard();
    if (!ownerIsCurrent() || busy) return;
    if (!vault) return requestVault();
    const apiKey = draftKey.trim();
    if (!apiKey) return setNotice({ tone: "error", text: "Enter your OpenAI API key." });
    setBusy("checking");
    setNotice(null);
    try {
      // The agent's live check with OpenAI is the validation; the Vault records
      // only a selection the agent has accepted.
      const outcome = await sendAiSelectionToAgent({
        provider: "openai", model: null, apiKey, transport: null, vertexProject: null, vertexLocation: null,
      });
      if (!ownerIsCurrent()) return;
      if (!outcome.ok) {
        setNotice({ tone: "error", text: aiSelectionRefusalMessage(outcome.code, "OpenAI") ?? "OpenAI could not be set up. Try again." });
        return;
      }
      try {
        await recordOpenAiSelection({ ...vault, apiKey, model: null });
      } catch {
        // A selection the Vault cannot record is withdrawn from the agent.
        await clearAgentAiSelection();
        if (ownerIsCurrent()) setNotice({ tone: "error", text: "Your key could not be saved in your vault, so your agent will not use it. Try again." });
        return;
      }
      if (!ownerIsCurrent()) return;
      setDraftKey("");
      setHasSavedKey(true);
      setSelection({ configured: true, provider: "openai", model: outcome.model, checkedAtMs: outcome.checkedAtMs, lastFailure: null });
      announceChange("Using OpenAI on your agent.");
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
      if ((await clearAgentAiSelectionFor("openai")) === "failed") {
        if (ownerIsCurrent()) setNotice({ tone: "error", text: "Your private agent could not be reached, so it may still use this key. Try again." });
        return;
      }
      await removeOpenAiSelection(vault);
      if (!ownerIsCurrent()) return;
      setHasSavedKey(false);
      setSelection((current) => (current?.provider === "openai" ? null : current));
      announceChange("Your OpenAI key was removed.");
    } catch {
      if (ownerIsCurrent()) setNotice({ tone: "error", text: "Your OpenAI key could not be removed from your vault. Try again." });
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
    if (!ownerIsCurrent() || busy || readiness?.kind !== "needs_update" || !readiness.update.releaseId) return;
    const { releaseId, deploymentTarget } = readiness.update;
    const popup = openAzureUpdateSignInPopup(deploymentTarget);
    setBusy("updating");
    const request = approveAgentUpdate({ deploymentTarget, releaseId, idempotencyKey: crypto.randomUUID(), popup });
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

  const lastFailure = inUse && selection?.lastFailure ? aiSelectionRefusalMessage(selection.lastFailure, "OpenAI") : null;
  let body: ReactNode;
  if (!readiness) {
    body = (
      <HelperText role="status" className="inline-flex items-center gap-1.5">
        <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
        Checking your private agent…
      </HelperText>
    );
  } else if (readiness.kind === "unknown") {
    body = (
      <>
        <HelperText role="status">We couldn’t check your private agent.</HelperText>
        <Button type="button" variant="link" onClick={() => void load()}>Try again</Button>
      </>
    );
  } else if (readiness.kind === "no_agent") {
    body = (
      <>
        <HelperText>Your own key runs on your private agent, so Hussh never holds it.</HelperText>
        <Button type="button" variant="link" onClick={() => router.push(ROUTES.ONE_SETUP_CLOUD)}>
          Set up your private agent
        </Button>
      </>
    );
  } else if (readiness.kind === "agent_pending") {
    body = <HelperText>Your private agent isn’t ready yet. Your own key works once it is.</HelperText>;
  } else if (readiness.kind === "needs_update") {
    const { installable, working } = readiness.update;
    body = (
      <>
        <HelperText role="status">Your agent needs an update to use OpenAI.</HelperText>
        {working ? (
          <HelperText>Your agent is updating now. Come back when it finishes.</HelperText>
        ) : installable ? (
          <Button type="button" variant="none" effect="fade" onClick={() => void approveUpdate()} disabled={busy !== null}>
            {busy === "updating" ? <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden /> : null}
            Update your agent
          </Button>
        ) : (
          <Button type="button" variant="link" onClick={() => router.push(ROUTES.PROFILE_SOFTWARE_UPDATES)}>
            Check for updates
          </Button>
        )}
      </>
    );
  } else if (!vault) {
    body = (
      <>
        <HelperText>Unlock your vault to use your own OpenAI key.</HelperText>
        <Button type="button" variant="link" onClick={requestVault}>
          {needsVaultCreation ? "Create your vault" : "Unlock your vault"}
        </Button>
      </>
    );
  } else {
    body = (
      <>
        {lastFailure ? <HelperText role="alert" className="text-destructive">{`Your agent’s last check failed. ${lastFailure}`}</HelperText> : null}
        <Input
          type="password"
          autoComplete="off"
          value={draftKey}
          onChange={(event) => {
            setDraftKey(event.target.value);
            setNotice(null);
          }}
          placeholder={inUse ? "Paste a new OpenAI API key" : "Paste an OpenAI API key"}
          disabled={busy !== null}
          aria-label="OpenAI API key"
          aria-invalid={notice?.tone === "error"}
          aria-describedby={STATUS_ID}
        />
        <HelperText as="div" className="min-h-5" id={STATUS_ID} role={notice?.tone === "error" ? "alert" : "status"} aria-live="polite">
          {busy === "checking" ? (
            <span className="inline-flex items-center gap-1.5">
              <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
              Your agent is checking this key with OpenAI…
            </span>
          ) : notice ? (
            <span className={notice.tone === "error" ? "text-destructive" : undefined}>{notice.text}</span>
          ) : defaultModel ? (
            `Your agent checks the key with OpenAI, then uses ${defaultModel}.`
          ) : (
            "Your agent checks the key with OpenAI before using it."
          )}
        </HelperText>
        <div className="flex flex-wrap gap-2">
          <Button type="button" variant="blue-gradient" onClick={() => void checkAndUse()} disabled={busy !== null}>
            {busy === "checking" ? <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden /> : null}
            Check and use
          </Button>
          {hasSavedKey || inUse ? (
            <Button type="button" variant="none" effect="fade" onClick={() => void remove()} disabled={busy !== null}>
              {busy === "removing" ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden />
              ) : (
                <Trash2 className="mr-2 h-4 w-4" aria-hidden />
              )}
              Remove key
            </Button>
          ) : null}
        </div>
      </>
    );
  }

  return (
    <SettingsGroup title="OpenAI" description="Available now" testId="profile-openai-runtime" separatorInset>
      <SettingsRow
        leading={<RuntimeProviderMark provider={OPENAI_MARK} className="!h-8 !w-8" />}
        title="Use your own key"
        description={inUse
          ? `Using OpenAI on your agent${selection?.model ? ` (${selection.model})` : ""}.`
          : "Your key stays locked to you and runs on your private agent."}
        trailing={inUse ? <Badge variant="secondary">In use</Badge> : null}
        testId="profile-openai-key-row"
      />
      <div className="space-y-2 px-[var(--settings-row-px)] py-[var(--settings-row-py)]">{body}</div>
    </SettingsGroup>
  );
}
