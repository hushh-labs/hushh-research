"use client";

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useRouter } from "next/navigation";

import { SettingsGroup, SettingsRow } from "@/components/app-ui/settings-ui";
import { HelperText } from "@/components/app-ui/typography";
import { RuntimeProviderMark } from "@/components/brand/runtime-provider-mark";
import {
  SpinnerGapIcon as Loader2,
  TrashIcon as Trash2,
} from "@/components/icons";
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
import { normalizeAiSelection } from "@/lib/one/ai-selection-seal";
import { ROUTES } from "@/lib/navigation/routes";
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
  hasSavedAzureKey,
  recordAzureSelection,
  removeAzureSelection,
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
    provider: "openai" | "azure_openai",
  ) => void;
  provider?: "openai" | "azure_openai";
};

type Notice = { tone: "error" | "status"; text: string } | null;

export function OpenAiKeyCard(props: OpenAiKeyCardProps) {
  // A typed key and owner-specific results must not survive an account switch.
  const owner = snapshotValidatedAuthSessionOwner();
  return (
    <OwnerOpenAiKeyCard
      key={`${props.userId ?? "signed-out"}:${owner?.generation ?? "unresolved"}:${props.provider ?? "openai"}`}
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
  provider = "openai",
}: OpenAiKeyCardProps) {
  const providerName = provider === "azure_openai" ? "Azure AI" : "OpenAI";
  const statusId = `${provider}-key-status`;
  const [endpoint, setEndpoint] = useState("");
  const [deployment, setDeployment] = useState("");
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
        ? (provider === "azure_openai" ? hasSavedAzureKey : hasSavedOpenAiKey)({
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
    if (provider === "azure_openai" && (!endpoint.trim() || !deployment.trim()))
      return setNotice({
        tone: "error",
        text: "Enter your Azure endpoint and deployment.",
      });
    if (provider === "azure_openai") {
      try {
        normalizeAiSelection({
          provider,
          model: deployment.trim(),
          apiKey,
          azureEndpoint: endpoint.trim(),
          transport: null,
          vertexProject: null,
          vertexLocation: null,
        });
      } catch {
        return setNotice({
          tone: "error",
          text: "Use your Azure HTTPS endpoint and a valid deployment name.",
        });
      }
    }
    setBusy("checking");
    setNotice(null);
    try {
      // The agent's live check with OpenAI is the validation; the Vault records
      // only a selection the agent has accepted.
      const outcome = await sendAiSelectionToAgent({
        provider,
        model: provider === "azure_openai" ? deployment.trim() : null,
        apiKey,
        transport: null,
        vertexProject: null,
        vertexLocation: null,
        ...(provider === "azure_openai"
          ? { azureEndpoint: endpoint.trim() }
          : {}),
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
        if (provider === "azure_openai")
          await recordAzureSelection({
            ...vault,
            apiKey,
            endpoint: endpoint.trim(),
            model: deployment.trim(),
          });
        else await recordOpenAiSelection({ ...vault, apiKey, model: null });
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
            text: "Your private agent could not be reached, so it may still use this key. Try again.",
          });
        return;
      }
      await (
        provider === "azure_openai"
          ? removeAzureSelection
          : removeOpenAiSelection
      )(vault);
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
        <HelperText role="status">
          We couldn’t check your private agent.
        </HelperText>
        <Button type="button" variant="link" onClick={() => void load()}>
          Try again
        </Button>
      </>
    );
  } else if (readiness.kind === "no_agent") {
    body = (
      <>
        <HelperText>
          Your own key runs on your private agent, so Hussh never holds it.
        </HelperText>
        <Button
          type="button"
          variant="link"
          onClick={() => router.push(ROUTES.ONE_SETUP_CLOUD)}
        >
          Set up your private agent
        </Button>
      </>
    );
  } else if (readiness.kind === "agent_pending") {
    body = (
      <HelperText>
        Your private agent isn’t ready yet. Your own key works once it is.
      </HelperText>
    );
  } else if (readiness.kind === "needs_update") {
    const { installable, working } = readiness.update;
    body = (
      <>
        <HelperText role="status">{`Your agent needs an update to use ${providerName}.`}</HelperText>
        {working ? (
          <HelperText>
            Your agent is updating now. Come back when it finishes.
          </HelperText>
        ) : installable ? (
          <Button
            type="button"
            variant="none"
            effect="fade"
            onClick={() => void approveUpdate()}
            disabled={busy !== null}
          >
            {busy === "updating" ? (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden />
            ) : null}
            Update your agent
          </Button>
        ) : (
          <Button
            type="button"
            variant="link"
            onClick={() => router.push(ROUTES.PROFILE_SOFTWARE_UPDATES)}
          >
            Check for updates
          </Button>
        )}
      </>
    );
  } else if (!vault) {
    body = (
      <>
        <HelperText>{`Unlock your vault to use your own ${providerName} key.`}</HelperText>
        <Button type="button" variant="link" onClick={requestVault}>
          {needsVaultCreation ? "Create your vault" : "Unlock your vault"}
        </Button>
      </>
    );
  } else {
    body = (
      <>
        {lastFailure ? (
          <HelperText
            role="alert"
            className="text-destructive"
          >{`Your agent’s last check failed. ${lastFailure}`}</HelperText>
        ) : null}
        {provider === "azure_openai" ? (
          <>
            <Input
              aria-label="Azure AI endpoint"
              placeholder="https://your-resource.openai.azure.com/"
              value={endpoint}
              onChange={(event) => setEndpoint(event.target.value)}
              disabled={busy !== null}
            />
            <Input
              aria-label="Azure AI deployment"
              placeholder="Deployment name"
              value={deployment}
              onChange={(event) => setDeployment(event.target.value)}
              disabled={busy !== null}
            />
          </>
        ) : null}
        <Input
          type="password"
          autoComplete="off"
          value={draftKey}
          onChange={(event) => {
            setDraftKey(event.target.value);
            setNotice(null);
          }}
          placeholder={
            inUse
              ? `Paste a new ${providerName} API key`
              : `Paste a ${providerName} API key`
          }
          disabled={busy !== null}
          aria-label={`${providerName} API key`}
          aria-invalid={notice?.tone === "error"}
          aria-describedby={statusId}
        />
        <HelperText
          as="div"
          className="min-h-5"
          id={statusId}
          role={notice?.tone === "error" ? "alert" : "status"}
          aria-live="polite"
        >
          {busy === "checking" ? (
            <span className="inline-flex items-center gap-1.5">
              <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
              {`Your agent is checking this key with ${providerName}…`}
            </span>
          ) : notice ? (
            <span
              className={
                notice.tone === "error" ? "text-destructive" : undefined
              }
            >
              {notice.text}
            </span>
          ) : defaultModel ? (
            `Your agent checks the key with ${providerName}, then uses ${defaultModel}.`
          ) : (
            `Your agent checks the key with ${providerName} before using it.`
          )}
        </HelperText>
        <div className="flex flex-wrap gap-2">
          <Button
            type="button"
            variant="blue-gradient"
            onClick={() => void checkAndUse()}
            disabled={busy !== null}
          >
            {busy === "checking" ? (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden />
            ) : null}
            Check and use
          </Button>
          {hasSavedKey || inUse ? (
            <Button
              type="button"
              variant="none"
              effect="fade"
              onClick={() => void remove()}
              disabled={busy !== null}
            >
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
    <SettingsGroup
      title={providerName}
      description="Available now"
      testId={`profile-${provider}-runtime`}
      separatorInset
    >
      <SettingsRow
        leading={
          provider === "openai" ? (
            <RuntimeProviderMark provider={OPENAI_MARK} className="!h-8 !w-8" />
          ) : undefined
        }
        title="Use your own key"
        description={
          inUse
            ? `Using ${providerName} on your agent${selection?.model ? ` (${selection.model})` : ""}.`
            : "Your key stays locked to you and runs on your private agent."
        }
        trailing={inUse ? <Badge variant="secondary">In use</Badge> : null}
        testId={`profile-${provider}-key-row`}
      />
      <div className="space-y-2 px-[var(--settings-row-px)] py-[var(--settings-row-py)]">
        {body}
      </div>
    </SettingsGroup>
  );
}
