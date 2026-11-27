import { getAuthSessionGeneration, subscribeAuthSessionGeneration } from "@/lib/auth/session-owner";
import { snapshotVaultSessionEpoch, subscribeVaultSessionEpoch } from "@/lib/vault/session-epoch";
import { currentFeedInvalidationEpoch, currentFeedPresentationRevision, subscribeFeedPresentationRevision } from "@/lib/cache/feed-invalidation-epoch";
import { FeedService } from "@/lib/services/feed-service";
import type { FeedActivityQuery } from "./activity-query";
type Result = Awaited<ReturnType<typeof FeedService.searchActivity>>;
const entries = new Map<string, {
    at: number;
    value: Promise<Result>;
}>();
let episode = "";
let observing = false;
export function clearFeedSearchCache(): void { entries.clear(); episode = ""; }
function observe() { if (observing)
    return; observing = true; subscribeAuthSessionGeneration(clearFeedSearchCache); subscribeVaultSessionEpoch(clearFeedSearchCache); subscribeFeedPresentationRevision(clearFeedSearchCache); }
/** Query/scope/page caches stay in this owner/security episode's memory only. */
export function searchFeed(owner: string, query: FeedActivityQuery, idToken: string, current: () => boolean): Promise<Result> {
    observe();
    if (!current())
        return Promise.reject(new Error("Search session ended"));
    const currentEpisode = () => JSON.stringify([owner, getAuthSessionGeneration(), snapshotVaultSessionEpoch(), currentFeedPresentationRevision(owner), currentFeedInvalidationEpoch(owner)]);
    const next = currentEpisode();
    if (episode !== next) {
        entries.clear();
        episode = next;
    }
    const key = JSON.stringify(query), cached = entries.get(key);
    if (cached && Date.now() - cached.at < 15000)
        return cached.value;
    const value = FeedService.searchActivity({ idToken, query, isEffectCurrent: () => episode === next && currentEpisode() === next }).catch(error => { if (episode === next)
        entries.delete(key); throw error; });
    if (entries.size >= 24)
        entries.delete(entries.keys().next().value!);
    entries.set(key, { at: Date.now(), value });
    return value;
}
