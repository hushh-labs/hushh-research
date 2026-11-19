import policy from "./activity-policy.generated.json";
import type { FeedItem } from "@/lib/services/feed-service";
type EventRule = {
    scope: string;
    kind: string;
    search_terms?: string[];
};
const events: Record<string, EventRule> = policy.events;
export const feedScopes: Record<string, {
    label: string;
    workspace?: string;
}> = policy.scopes;
export const availableFeedScopes = Object.entries(feedScopes).filter(([scope]) => Object.values(events).some(rule => rule.kind !== "routine" && rule.scope === scope));
export function feedItemScope(item: Pick<FeedItem, "event_type" | "metadata"> & Partial<FeedItem>): string {
    if (item.scope_id && feedScopes[item.scope_id])
        return item.scope_id;
    const classified = policy.classified_scopes[item.subagent_id as keyof typeof policy.classified_scopes];
    if (classified)
        return classified;
    if (item.event_type === "connector_reconnect_required") {
        const connector = policy.connector_scopes[item.metadata.connector_key as keyof typeof policy.connector_scopes];
        if (connector)
            return connector;
    }
    if (item.subagent_id === "agent_kyc" || (typeof item.metadata.workflow_id === "string" && ["mail_message_sent", "mail_information_request_detected"].includes(item.event_type)))
        return "kyc";
    return events[item.event_type]?.scope || "one";
}
export function feedScopeLabel(scope: string): string { return feedScopes[scope]?.label || "One"; }
export function normalizedFeedQuery(value: string): string[] {
    return value.normalize("NFKC").toLocaleLowerCase().match(/[\p{L}\p{N}]+/gu) || [];
}
export function matchesCurrentFeedAction(item: {
    title: string;
    description: string;
    person?: {
        displayName: string;
    } | null;
}, query: string): boolean {
    const text = normalizedFeedQuery([item.title, item.description, item.person?.displayName].join(" ")).join(" ");
    return normalizedFeedQuery(query).every(term => text.includes(term));
}
