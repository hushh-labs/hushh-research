"use client";

import type { ReactNode } from "react";
import { useRouter } from "next/navigation";
import { HelperText } from "@/components/app-ui/typography";
import {
  SpinnerGapIcon as Loader2,
  TrashIcon as Trash2,
} from "@/components/icons";
import { Input } from "@/components/ui/input";
import { Button } from "@/lib/morphy-ux/button";
import { ROUTES } from "@/lib/navigation/routes";
import type { AgentAiReadiness } from "@/lib/one/ai-selection-agent";

export type KeyNotice = { tone: "error" | "status"; text: string } | null;

/** Presentation only. Owner authority and configuration effects stay in the card. */
export function OwnerKeyContent({
  readiness,
  providerName,
  busy,
  vault,
  needsVaultCreation,
  lastFailure,
  provider,
  endpoint,
  deployment,
  draftKey,
  notice,
  defaultModel,
  statusId,
  hasSavedKey,
  inUse,
  load,
  approveUpdate,
  requestVault,
  setEndpoint,
  setDeployment,
  setDraftKey,
  setNotice,
  checkAndUse,
  remove,
}: {
  readiness: AgentAiReadiness | null;
  providerName: string;
  busy: "checking" | "removing" | "updating" | null;
  vault: boolean;
  needsVaultCreation: boolean;
  lastFailure: string | null;
  provider: "openai" | "azure_openai";
  endpoint: string;
  deployment: string;
  draftKey: string;
  notice: KeyNotice;
  defaultModel: string | null;
  statusId: string;
  hasSavedKey: boolean;
  inUse: boolean;
  load: () => Promise<void>;
  approveUpdate: () => Promise<void>;
  requestVault: () => void;
  setEndpoint: (value: string) => void;
  setDeployment: (value: string) => void;
  setDraftKey: (value: string) => void;
  setNotice: (value: KeyNotice) => void;
  checkAndUse: () => Promise<void>;
  remove: () => Promise<void>;
}) {
  const router = useRouter();
  let body: ReactNode;
  if (!readiness) {
    body = (
      <HelperText role="status" className="inline-flex items-center gap-1.5">
        <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
        Checking Agent One…
      </HelperText>
    );
  } else if (readiness.kind === "unknown") {
    body = (
      <>
        <HelperText role="status">
          We couldn’t check Agent One.
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
          Your own key runs on Agent One, so Hussh never holds it.
        </HelperText>
        <Button
          type="button"
          variant="link"
          onClick={() => router.push(ROUTES.ONE_SETUP_CLOUD)}
        >
          Set up Agent One
        </Button>
      </>
    );
  } else if (readiness.kind === "agent_pending") {
    body = (
      <HelperText>
        Agent One isn’t ready yet. Your own key works once it is.
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

  return body;
}
