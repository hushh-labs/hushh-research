import { armFeedSearchReturn } from "./feed-search-memory";
/** Public origin only; typed names and queries never enter navigation URLs. */
export function feedResultHref(href: string): string {
    if (!href.startsWith("/") || href.startsWith("//"))
        throw new Error("Internal result required");
    const url = new URL(href, "https://one.invalid");
    url.searchParams.set("from", "/one/feed");
    return url.pathname + url.search + url.hash;
}
/** Keeps the producer's exact destination and prerequisite callback intact. */
export function openFeedResult(router: {
    push: (href: string) => void;
}, href: string): void {
    const target = feedResultHref(href);
    armFeedSearchReturn(target);
    router.push(target);
}
