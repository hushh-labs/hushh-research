import { ConsentCenterService, type ConsentCenterEntry } from "@/lib/services/consent-center-service";

/** These are the two requestable scopes authored by the Wallet domain contract. */
export function walletSharingKind(entry: ConsentCenterEntry): "summary" | "details" | null {
  const scope = entry.scope || entry.normalized_scope;
  if (scope === "attr.wallet.summary.*") return "summary";
  if (scope === "attr.wallet.secrets.*") return "details";
  return null;
}

export function walletSharingEntries(entries: ConsentCenterEntry[]): ConsentCenterEntry[] {
  const unique = new Map<string, ConsentCenterEntry>();
  for (const entry of entries) {
    const members = [entry, ...(entry.bundle_items ?? []).flatMap((item) => item.entry ? [item.entry] : [])];
    for (const member of members) {
      if (walletSharingKind(member)) unique.set(member.request_id || member.id,
        member.bundle_id || !entry.bundle_id ? member : { ...member, bundle_id: entry.bundle_id });
    }
  }
  return [...unique.values()];
}

/** Read-only projection: approval and revocation remain owned by Consent Center. */
export async function loadWalletSharing(options: {
  userId: string; idToken: string; cancelled: () => boolean;
}): Promise<{ requests: ConsentCenterEntry[]; grants: ConsentCenterEntry[]; incompleteRequests?: boolean }> {
  let incompleteRequests = false;
  const load = async (surface: "pending" | "active") => {
    const entries: ConsentCenterEntry[] = [];
    for (let page = 1; ; page += 1) {
      if (options.cancelled()) return [];
      const result = await ConsentCenterService.listEntries({
        userId: options.userId, idToken: options.idToken, surface,
        mode: "consents", requestView: "received", page, limit: 50, force: true,
      });
      if (result.user_id !== options.userId) throw new Error("Consent owner changed");
      if (surface === "pending" && result.items.some((entry) => entry.bundle_complete === false)) incompleteRequests = true;
      entries.push(...result.items);
      if (!result.has_more) return walletSharingEntries(entries);
      if (result.page !== page || !result.items.length) throw new Error("Incomplete consent list");
    }
  };
  const [requests, grants] = await Promise.all([load("pending"), load("active")]);
  return { requests, grants, incompleteRequests };
}
