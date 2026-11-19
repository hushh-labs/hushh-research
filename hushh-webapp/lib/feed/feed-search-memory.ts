import { getAuthSessionGeneration, subscribeAuthSessionGeneration } from "@/lib/auth/session-owner";
import { snapshotVaultSessionEpoch, subscribeVaultSessionEpoch } from "@/lib/vault/session-epoch";
import { currentFeedInvalidationEpoch, currentFeedPresentationRevision, subscribeFeedPresentationRevision } from "@/lib/cache/feed-invalidation-epoch";
import type { FeedItem, FeedService } from "@/lib/services/feed-service";
import { getAppScrollRoot } from "@/lib/navigation/use-scroll-reset";
export type ActivityCriteria = {
    query: string;
    person: string;
    agent: string;
    fromAt: string | null;
    beforeAt: string | null;
    revision: number;
};
export type FeedSearchSnapshot = {
    financeItems?: import("./finance-records").FinanceFeedRecord[];
    open?: boolean;
    scrollTop?: number;
    topHit?: Awaited<ReturnType<typeof FeedService.searchActivity>>["top_hit"];
    query: string;
    person: string;
    agent: string;
    from: string;
    through: string;
    filtersOpen: boolean;
    pending?: boolean;
    submitted: ActivityCriteria | null;
    items: FeedItem[];
    cursor: string | null;
};
let retained: {
    epoch: string;
    owner: string;
    auth: number | null;
    vault: number;
    revision: number;
    value: FeedSearchSnapshot;
} | null = null;
let subscribed = false;
let returning = false;
let resultPath: string | null = null;
function observeSession() {
    if (subscribed || typeof window === "undefined")
        return;
    subscribed = true;
    // Private criteria and transient previews never survive a security episode.
    subscribeAuthSessionGeneration(() => { retained = null; });
    subscribeVaultSessionEpoch(() => { retained = null; });
    subscribeFeedPresentationRevision(owner => {
        if (!owner || retained?.owner === owner)
            retained = null;
    });
}
export function recallFeedSearch(owner: string): FeedSearchSnapshot | null {
    observeSession();
    return retained?.owner === owner && retained.auth === getAuthSessionGeneration()
        && retained.vault === snapshotVaultSessionEpoch() && retained.revision === currentFeedPresentationRevision(owner) ? (retained.epoch === currentFeedInvalidationEpoch(owner) ? retained.value : { ...retained.value, items: [], cursor: null, topHit: null, financeItems: undefined, pending: true }) : null;
}
export function retainFeedSearch(owner: string, value: FeedSearchSnapshot): void {
    observeSession();
    const sanitize = (item: FeedItem): FeedItem => {
        const { message_preview: _preview, ...metadata } = item.metadata;
        return { ...item, metadata };
    };
    const safeItems = value.items.map(sanitize);
    const topHit = value.topHit?.kind === "activity" ? { ...value.topHit, item: sanitize(value.topHit.item) } : value.topHit;
    retained = { owner, auth: getAuthSessionGeneration(), vault: snapshotVaultSessionEpoch(), epoch: currentFeedInvalidationEpoch(owner), revision: currentFeedPresentationRevision(owner), value: { ...value, items: safeItems, topHit } };
}
export function armFeedSearchReturn(href?: string): void {
    returning = Boolean(retained?.value.open);
    resultPath = href ? new URL(href, "https://one.invalid").pathname : null;
    if (retained)
        retained.value.scrollTop = getAppScrollRoot()?.scrollTop || window.scrollY;
}
export function visitFeedSearchRoute(path: string): void {
    if (path !== "/one/feed" && (!resultPath || (!path.startsWith(resultPath + "/") && path !== resultPath)))
        returning = false;
}
export function consumeFeedSearchReturn(owner: string): FeedSearchSnapshot | null {
    const value = returning ? recallFeedSearch(owner) : null;
    returning = false;
    if (!value)
        retained = null;
    return value;
}
export function clearFeedSearch(): void { retained = null; returning = false; }
