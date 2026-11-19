"use client";

import Link from "next/link";
import { FinanceShareMessage } from "@/components/kai/sharing/finance-share-message";
import { financeReference } from "@/lib/finance-sharing/contract";
import { AdvisorReviewMessage } from "@/components/kai/advisor/advisor-review-message";
import { advisorReviewReference } from "@/lib/advisor-review/contract";
import { WalletSharedCardMessage } from "@/components/wallet/wallet-shared-card-message";
import { WalletCardAccessMessage } from "@/components/wallet/wallet-card-access-message";
import { cardAccessReference } from "@/lib/services/wallet-card-access-service";
import { isWalletCardShare } from "@/lib/wallet/wallet-card-share";
import {
  cardRequestReference,
  walletCardRequestHref,
} from "@/lib/wallet/card-request";

/** Opaque share messages resolve through their own live authorization owner. */
export function DirectMessageSharedContent({
  content,
  senderIsViewer,
  peerPersonRef,
  textClassName,
}: {
  content: string;
  senderIsViewer: boolean;
  peerPersonRef?: string | null;
  textClassName?: string;
}) {
  const advisor = advisorReviewReference(content);
  if (advisor) return <AdvisorReviewMessage id={advisor} />;
  const finance = financeReference(content);
  if (finance) return <FinanceShareMessage grantId={finance} />;
  const request = cardRequestReference(content);
  if (request)
    return (
      <Link
        className="underline underline-offset-4"
        href={walletCardRequestHref(request)}
      >
        View card request
      </Link>
    );
  const card = cardAccessReference(content);
  if (card)
    return (
      <WalletCardAccessMessage grantId={card} senderIsViewer={senderIsViewer} />
    );
  if (isWalletCardShare(content))
    return (
      <WalletSharedCardMessage
        content={content}
        peerPersonRef={peerPersonRef ?? null}
        senderIsViewer={senderIsViewer}
      />
    );
  return content ? (
    <p className={`${textClassName ?? ""} whitespace-pre-wrap break-words`}>
      {content}
    </p>
  ) : null;
}
