import { ConsentCenterService, type ConsentCenterPageListResponse } from "./consent-center-service";
import { currentConsentInvalidationEpoch } from "@/lib/cache/consent-read-after-write";

/** Traverse the existing publisher's pages; never reinterpret request meaning.
 * A bounded remainder stays explicit through has_more and the publisher's
 * overflow task. Normal Feed still reads its original compact first page. */
export async function listConsentTaskPages(
  options: Parameters<typeof ConsentCenterService.listEntries>[0],
  isCurrent: () => boolean,
): Promise<ConsentCenterPageListResponse> {
  const entries = new Map<string, ConsentCenterPageListResponse["items"][number]>();
  const epoch = currentConsentInvalidationEpoch(options.userId);
  const current = () => isCurrent() && currentConsentInvalidationEpoch(options.userId) === epoch;
  let result: ConsentCenterPageListResponse | null = null;
  for (let page = 1; page <= 50; page += 1) {
    if (!current()) throw new DOMException("Session changed", "AbortError");
    const next = await ConsentCenterService.listEntries({ ...options, page, limit: 100 });
    if (!current()) throw new DOMException("Session changed", "AbortError");
    if (next.user_id !== options.userId || next.page !== page || (next.has_more && !next.items.length)) throw new Error("Pending request paging could not be verified.");
    for (const item of next.items) entries.set(item.id, item);
    result = next;
    if (!next.has_more) break;
  }
  if (!result) throw new Error("Pending requests could not load.");
  return { ...result, page: 1, items: [...entries.values()] };
}
