"use client";

import { Info } from "@/components/icons";
import { ConsentAgentIcon } from "@/components/icons/agents";
import type { OwnerConsentRequest } from "@/lib/consent/owner-consent-request";
import type { FeedActionable, FeedActionButton } from "./use-feed-actionables";

export function ownerConsentRequestActionable(
  request: OwnerConsentRequest,
  handlers: {
    allow: (request: OwnerConsentRequest) => Promise<boolean>;
    deny: (request: OwnerConsentRequest) => Promise<boolean>;
    openDetails: () => void;
    onDecided: (key: string) => void;
    sortAt: number;
  },
): FeedActionable {
  // Preserve the authored reason as supporting copy.
  const reason = String(request.reason || "").trim();
  const decisionActions: FeedActionButton[] = request.complete
    ? [
        {
          // One tap: the decline waits behind a five-second Undo toast
          // (lib/consent/deferred-consent-decline.ts), which replaces the old
          // armed second tap, the same as the Consent Center's ✗.
          key: "deny",
          label: "Don't allow",
          tone: "ghost",
          run: async () => {
            if (await handlers.deny(request)) handlers.onDecided(request.key);
          },
        },
        {
          key: "allow",
          label: "Allow",
          tone: "primary",
          run: async () => {
            if (await handlers.allow(request)) handlers.onDecided(request.key);
          },
        },
      ]
    : [];
  return {
    id: `consent:${request.key}`,
    operationKey: `consent:${request.bundleId || request.members[0]?.request_id || request.members[0]?.id}`,
    todo: { source: "consent", title: `Review ${request.headline}`, href: request.detailsHref },
    scopeId: "consent", icon: ConsentAgentIcon,
    iconTone: "capability",
    person: request.isPerson
      ? {
          displayName: request.requesterLabel,
          userId: request.members[0]?.counterpart_id,
          photoUrl: request.requesterPhotoUrl,
        }
      : null,
    title: request.headline,
    description: request.complete
      ? reason || "Waiting for your answer"
      : "Still arriving. Open Details to review it.",
    onSelect: handlers.openDetails,
    phoneActions: [{ key: "review", label: "Review", tone: "primary", run: handlers.openDetails }],
    actions: [
      {
        key: "details",
        label: "Details",
        tone: "ghost",
        phoneIcon: Info,
        run: handlers.openDetails,
      },
      ...decisionActions,
    ],
    sortAt: handlers.sortAt,
    displayTimestamp: request.requestedAt,
  };
}
