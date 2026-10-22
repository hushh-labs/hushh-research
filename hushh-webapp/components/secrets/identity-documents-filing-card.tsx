"use client";

import { KycAgentIcon } from "@/components/icons";
import { Button } from "@/components/ui/button";
import type { SecretsListModel } from "./use-secrets-list-model";

/** Both renderers use the same guarded, explicit KYC filing operation. */
export function IdentityDocumentsFilingCard({ model }: { model: SecretsListModel }) {
  const filing = model.filing;
  if (!filing) return null;
  const { item, state } = filing;
  const noun = item.offerNoun ?? "ID number";
  return <section aria-label="Identity documents" data-testid="identity-documents-filing"
    className="motion-step-enter flex flex-col gap-3 rounded-[var(--app-card-radius-compact)] border border-[color:var(--app-card-border-standard)] bg-[color:var(--app-card-surface-default-solid)] p-4 text-foreground">
    <header className="flex h-6 items-center gap-2"><KycAgentIcon size={20} aria-hidden="true" className="shrink-0" />
      <p className="text-sm font-semibold leading-6" role="status">{state === "filed" ? "Filed in Identity documents" : `Add ${noun} to Identity documents`}</p></header>
    <p className="text-xs leading-4 text-foreground/70">{state === "filed"
      ? `${item.label} is now with your identity documents. Nothing is shared until you approve a request.`
      : `${item.label} is kept in Secrets. Filing it lets you answer KYC requests with it. Nothing is shared until you approve a request.`}</p>
    {state === "failed" ? <p className="text-xs leading-4 text-destructive" role="alert">Filing wasn’t confirmed. Check your identity documents before trying again.</p> : null}
    {state !== "filed" ? <div className="flex flex-col gap-2 sm:flex-row">
      <Button size="standard" onClick={() => void model.file()} isLoading={state === "filing"} disabled={model.pending || state === "failed"} data-testid="identity-documents-file">File {noun}</Button>
      <Button variant="secondary" size="standard" disabled={model.pending} onClick={model.dismissFiling}>Not now</Button>
    </div> : null}
  </section>;
}
