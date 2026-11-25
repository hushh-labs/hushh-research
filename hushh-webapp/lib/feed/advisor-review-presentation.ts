import { RiaAgentIcon } from "@/components/icons/agents";
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
    !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(id) ||
    !["owner", "advisor"].includes(String(item.metadata.viewerRole))
  )
    return null;
  return {
    icon: RiaAgentIcon,
    domainLabel: "Finance",
    label: item.event_type === "advisor_review_accepted"
      ? "Advisor request accepted"
      : item.event_type === "advisor_review_declined"
        ? "Advisor request declined"
        : item.event_type === "advisor_review_requested"
          ? "Portfolio review requested"
          : "Advisor request updated",
    description: "",
    exactDestination: "request",
    href: advisorWorkspaceHref(id, item.metadata.viewerRole === "advisor"),
  };
}
