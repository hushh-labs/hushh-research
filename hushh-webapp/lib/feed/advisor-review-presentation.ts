import { TrendingUp } from "@/components/icons";
import { advisorWorkspaceHref } from "@/lib/advisor-review/contract";
import type { FeedItem } from "@/lib/services/feed-service";
import type { FeedItemPresentation } from "./feed-item-renderers";

export function advisorReviewPresentation(
  item: FeedItem,
): FeedItemPresentation | null {
  const id = item.metadata?.advisorReviewId;
  if (
    !item.event_type.startsWith("advisor_review_") ||
    typeof id !== "string" ||
    !/^[a-f0-9-]{36}$/i.test(id)
  )
    return null;
  return {
    icon: TrendingUp,
    domainLabel: "Finance",
    label: "Advisor review",
    description:
      item.event_type === "advisor_review_requested"
        ? "A Finance review and connection request is waiting. The snapshot is locked until acceptance."
        : item.event_type === "advisor_review_accepted"
          ? "Your advisor accepted. You’re connected and can arrange an introduction."
          : "Your advisor review workspace has an update.",
    href: advisorWorkspaceHref(id, item.metadata.viewerRole === "advisor"),
  };
}
