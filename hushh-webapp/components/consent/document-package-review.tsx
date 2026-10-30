"use client";

import type { ReactNode } from "react";
import { BodyText, HelperText, MediumRowLabel } from "@/components/app-ui/typography";
import { FlowActionGroup } from "@/components/app-ui/flow-actions";
import { Button } from "@/lib/morphy-ux/button";
import { formatDocumentRequestPrice } from "@/lib/consent/document-request-price";
import type { AgentDocumentPackage, SharingReview } from "@/lib/services/drive-sharing-service";
import type { ArmedAction } from "@/lib/ui/use-armed-action";

export function PackageFact({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="flex min-h-11 items-start justify-between gap-4 py-2.5">
      <HelperText as="dt" className="shrink-0">
        {label}
      </HelperText>
      <BodyText as="dd" className="min-w-0 text-right [overflow-wrap:anywhere]">
        {value}
      </BodyText>
    </div>
  );
}

const Fact = PackageFact;
type PackageReview = Pick<SharingReview, "purpose" | "recipientEmail" | "priceCents" | "paymentRequired">;

export function DocumentPackageDetails({ review, agentPackage, hairlines: HAIRLINES }: {
  review: PackageReview;
  agentPackage: AgentDocumentPackage;
  hairlines: string;
}) {
  return <>
        <BodyText className="whitespace-pre-wrap [overflow-wrap:anywhere]">“{review.purpose.purpose}”</BodyText>
        <dl className={HAIRLINES}>
          <Fact label="Share with" value={review.recipientEmail} />
          {review.purpose.periodStart ? <Fact label={agentPackage.confidenceBasis === "provider_search" ? "Search period" : "Period"} value={`${review.purpose.periodStart} – ${review.purpose.periodEnd}`} /> : null}
          <Fact label="Access" value="Viewer, until removed" />
          <Fact label="Package" value={`${agentPackage.selectedCount.toLocaleString()} ${agentPackage.selectedCount === 1 ? "file" : "files"}`} />
          {agentPackage.confidenceBasis !== "provider_search" ? <Fact label="Coverage" value={{ complete: "Complete", partial: "Partial", unknown: "Not established" }[agentPackage.coverageStatus]} /> : null}
          {agentPackage.suggestedPriceCents !== null ? <Fact label="Suggested price" value={formatDocumentRequestPrice(agentPackage.suggestedPriceCents)} /> : null}
          {agentPackage.status === "allowed" && review.priceCents != null ? <Fact label="Agreed price" value={formatDocumentRequestPrice(review.priceCents)} /> : null}
        </dl>
        <details className="text-sm"><summary data-consent-role="utility" className="min-h-11 cursor-pointer py-3">View details</summary>
          <dl className={HAIRLINES}>
          {agentPackage.confidenceBasis !== "provider_search" ? <Fact label="Evaluated" value={`${agentPackage.evaluatedCount.toLocaleString()} of ${agentPackage.candidateCount.toLocaleString()} candidates`} /> : null}
          {agentPackage.confidenceScore !== null ? <Fact label="Agent assessment" value={`${agentPackage.confidenceScore}/100`} /> : null}
          {agentPackage.importanceScore !== null ? <Fact label="Importance" value={`${agentPackage.importanceScore}/500`} /> : null}
          </dl>
        {agentPackage.confidenceScore !== null ? <HelperText>Agent One&apos;s assessment is not a measured probability of correctness.</HelperText> : null}
        {agentPackage.priceReason ? <HelperText className="[overflow-wrap:anywhere]">{agentPackage.priceReason}</HelperText> : null}
        {agentPackage.selectedFiles?.length ? <div className="mt-3">
          <MediumRowLabel as="span">Included files</MediumRowLabel>
          <ul className="divide-y divide-border/60" aria-label="Included files">
            {agentPackage.selectedFiles.map(file => <li key={file.position} className="py-2">
              <HelperText className="[overflow-wrap:anywhere]">{file.name}</HelperText>
              {agentPackage.confidenceBasis !== "provider_search" ? <HelperText>Weightage {file.weightageOutOf10}/10 · Model assessment {file.confidenceScore}/100</HelperText> : null}
            </li>)}
          </ul>
          {agentPackage.selectedCount > agentPackage.selectedFiles.length ? <HelperText>
            Showing {agentPackage.selectedFiles.length} of {agentPackage.selectedCount} files.
          </HelperText> : null}
        </div> : null}
        </details>
        {agentPackage.summary ? <BodyText className="whitespace-pre-wrap [overflow-wrap:anywhere]">{agentPackage.summary}</BodyText> : null}
        {agentPackage.gaps.length ? <ul aria-label="Package coverage gaps" className="divide-y divide-border/60">
          {agentPackage.gaps.map((gap, index) => <li key={index} className="py-2"><HelperText className="[overflow-wrap:anywhere]">{gap}</HelperText></li>)}
        </ul> : null}
  </>;
}

export function DocumentPackageActions({ review, agentPackage, undecided, locked, ownerDecision,
  denyConfirm, allowClass: ALLOW_CLASS, onAllow, onDecline, onEditPrice }: {
  review: PackageReview;
  agentPackage: AgentDocumentPackage;
  undecided: boolean;
  locked: boolean;
  ownerDecision: boolean;
  denyConfirm: ArmedAction;
  allowClass: string;
  onAllow: (amountCents: number | null) => void;
  onDecline: () => void;
  onEditPrice: () => void;
}) {
  return <>
        {undecided && agentPackage.status !== "allowed" ? <FlowActionGroup
          primary={<Button data-consent-role="primary-action" size="prominent" variant="none" className={ALLOW_CLASS} disabled={locked || !ownerDecision} onClick={() => onAllow(review.paymentRequired ? agentPackage.suggestedPriceCents ?? review.priceCents ?? null : null)}>Allow</Button>}
          secondary={<Button data-consent-role="primary-action" size="prominent" variant={denyConfirm.armed ? "destructive" : "none"}
            className={denyConfirm.armed ? undefined : "text-destructive hover:text-destructive"}
            disabled={locked} aria-label={denyConfirm.ariaLabel("Deny")}
            onClick={() => denyConfirm.activate(onDecline)}>{denyConfirm.label("Deny")}</Button>}
        /> : null}
        {ownerDecision && review.paymentRequired && agentPackage.confidenceBasis !== "provider_search" ? <Button data-consent-quiet-action="true" data-consent-role="compact-action" size="standard" variant="none" disabled={locked} onClick={onEditPrice}>Edit price</Button> : null}
  </>;
}
