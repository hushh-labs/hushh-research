/**
 * Google Contacts as a source for contact sync, read in the browser.
 *
 * WHY THIS EXISTS: the W3C Contact Picker (`navigator.contacts.select`) ships
 * enabled by default only in Chrome on Android. iOS Safari has it behind a
 * flag; no desktop browser has it at all. So on most of the web, contact sync
 * has nothing to read. A Google account is not a device capability — it works
 * in every browser — which is what makes it the right second source.
 *
 * THE INVARIANT THIS MODULE EXISTS TO PRESERVE, AND MUST NOT BREAK:
 *
 *   The People API is called ONLY from browser JavaScript, with a token our
 *   servers never see. A raw phone number belonging to somebody who is not a
 *   Hushh user must never reach a Hushh server. There is no server-side People
 *   API client and there must never be one. No response from this module is
 *   cached or persisted anywhere.
 *
 * A backend implementation is about twenty lines and would reuse the working
 * OAuth refresh path — it will look like a simplification in review. It also
 * puts the phone number of every non-user in somebody's address book onto our
 * infrastructure, which is the one thing this whole design is arranged to
 * prevent. `consent-protocol/tests/test_contacts_never_reach_the_server.py`
 * fails the build if anyone tries.
 *
 * Everything read here is handed straight to `buildMarketplaceContactLookups`,
 * which normalizes, dedupes and hashes on-device exactly as it does for the
 * device address book. There is one copy of that pipeline on purpose.
 */

import type { HushhContactsReadResult } from "@/lib/capacitor";
import { isNative } from "@/lib/capacitor/platform";
import type { MarketplaceContactSource } from "@/lib/marketplace/contact-matching";

const PEOPLE_CONNECTIONS_URL =
  "https://people.googleapis.com/v1/people/me/connections";

/**
 * Exactly the two fields the pipeline consumes.
 *
 * `contact-matching.ts` reads `displayName` and `phoneNumbers` and nothing
 * else — `HushhContactRecord.emailAddresses` is declared and never used. Asking
 * for photos, addresses or organisations would be collecting data we have no
 * use for, from people who are not our users.
 */
const PERSON_FIELDS = "names,phoneNumbers";

/**
 * Contacts the person actually saved, not merged "other contacts" profiles
 * Google infers from mail traffic. Someone emailed once is not someone you
 * meant to share.
 */
const READ_SOURCE = "READ_SOURCE_TYPE_CONTACT";

/** Google's maximum for this endpoint. */
const PAGE_SIZE = 1000;

/**
 * Pages are bounded rather than followed to exhaustion. Five pages match the
 * contact-sync read budget; a larger account is reported as truncated and its
 * unreturned rows stay explicitly unchecked rather than being called unmatched.
 */
const MAX_PAGES = 5;

export type GoogleContactsAvailability = "connectable" | "unconfigured";

type PeoplePhone = { value?: string | null; canonicalForm?: string | null };
type PeopleName = { displayName?: string | null };
type PeoplePerson = {
  resourceName?: string | null;
  names?: PeopleName[];
  phoneNumbers?: PeoplePhone[];
};
type PeopleConnectionsResponse = {
  connections?: PeoplePerson[];
  nextPageToken?: string | null;
  totalPeople?: number | null;
};

/**
 * Whether this build can offer a Google connection at all.
 *
 * Synchronous and deliberately NOT a `HushhContactsPermissionState`. That state
 * is a device fact answered by a plugin, and the onboarding gate treats any
 * failure to answer it as "hide the contacts step"
 * (`app/one/location/page.tsx`). Google availability is an ACCOUNT fact and
 * needs a network round trip to establish, so folding it in would let a slow
 * response hide the contacts step on a phone whose picker works perfectly.
 *
 * Native returns `unconfigured` on purpose. `capacitor.config.ts` sets
 * `iosScheme: "App"`, so inside the iOS shell the page origin is
 * `App://localhost` — Google will not accept a non-https custom scheme as an
 * Authorized JavaScript Origin, and Google Identity Services will not
 * initialise there. Native already has the real address book through the
 * first-party plugin, so there is nothing to fall back to.
 */
export function googleContactsAvailability(): GoogleContactsAvailability {
  if (typeof window === "undefined") return "unconfigured";
  if (isNative()) return "unconfigured";
  const clientId = String(
    process.env.NEXT_PUBLIC_GOOGLE_OAUTH_CLIENT_ID || "",
  ).trim();
  return clientId ? "connectable" : "unconfigured";
}

function displayNameOf(person: PeoplePerson): string | null {
  const named = (person.names ?? []).find((name) =>
    String(name?.displayName || "").trim(),
  );
  return named?.displayName?.trim() || null;
}

/**
 * The number string to normalize, chosen deliberately.
 *
 * Google defines `canonicalForm` as its output-only ITU-T E.164 form. That is
 * stronger country evidence than `value`, which can be a national number from
 * any country in a globally mixed address book. Prefer a syntactically valid
 * canonical form and still send it THROUGH our normalizer downstream. Falling
 * back to `value` is safe only when Google omitted or malformed the canonical
 * field; emitting both could hash a wrong regional interpretation as well.
 */
function phoneStringsOf(person: PeoplePerson): string[] {
  return (person.phoneNumbers ?? [])
    .map((phone) => {
      const canonical = String(phone?.canonicalForm || "").trim();
      if (/^\+[1-9]\d{6,14}$/.test(canonical)) return canonical;
      const typed = String(phone?.value || "").trim();
      if (typed) return typed;
      return "";
    })
    .filter(Boolean);
}

/**
 * A source that reads the signed-in Google account's saved contacts.
 *
 * The token is passed in rather than fetched here: acquiring it is a UI concern
 * (it needs a user gesture and can show a consent sheet), and keeping the two
 * apart means this module can be tested with a plain string.
 */
export function googlePeopleContactSource(
  token: string,
): MarketplaceContactSource {
  return async ({ limit }) => {
    const contacts: HushhContactsReadResult["contacts"] = [];
    let pageToken: string | null = null;
    let pages = 0;
    let totalPeople = 0;
    let hasMore = false;

    do {
      const url = new URL(PEOPLE_CONNECTIONS_URL);
      url.searchParams.set("personFields", PERSON_FIELDS);
      url.searchParams.set("pageSize", String(PAGE_SIZE));
      url.searchParams.set("sources", READ_SOURCE);
      if (pageToken) url.searchParams.set("pageToken", pageToken);
      // Deliberately no `requestSyncToken`. A sync token is a durable handle to
      // somebody's address book, and there is nowhere in this design to keep
      // one — nothing here is persisted.

      const response = await fetch(url.toString(), {
        cache: "no-store",
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!response.ok) {
        throw new Error(
          response.status === 401
            ? "Google contact access expired. Connect again to keep going."
            : response.status === 403
              ? "Google Contacts access is unavailable for this app or account. Try again later."
              : "Could not read your Google contacts. Try again in a moment.",
        );
      }

      const payload = (await response.json()) as PeopleConnectionsResponse;
      totalPeople = Number(payload.totalPeople || 0) || totalPeople;

      for (const person of payload.connections ?? []) {
        const phoneNumbers = phoneStringsOf(person);
        // Keep every person row. A row with no usable phone cannot produce a
        // lookup, but it still belongs to the full-read classification as
        // `uncheckable`; dropping it makes `totalPeople - contacts.length`
        // falsely look unchecked even though Google did return the person.
        contacts.push({
          id: String(person.resourceName || "") || null,
          displayName: displayNameOf(person),
          phoneNumbers,
        });
      }

      pageToken = String(payload.nextPageToken || "") || null;
      pages += 1;
      hasMore = Boolean(pageToken);
    } while (pageToken && pages < MAX_PAGES && contacts.length < limit);

    return {
      contacts: contacts.slice(0, limit),
      sourcePlatform: "google",
      // Null, not the browser locale. A People read has no device behind it,
      // so there is no region to report and inventing one from the browser's
      // language would be a guess dressed as a signal.
      //
      // This used to be load-bearing for a different reason: the resolver took
      // ANY device region ahead of the account's own number, so a US-locale
      // browser overrode an Indian account and every bare national number
      // hashed wrong. Passing null was how this path sidestepped it. The
      // resolver now ranks by provenance — only a SIM-derived region outranks
      // the account's number — so the sidestep is no longer what saves us, and
      // null is simply the honest value.
      defaultRegion: null,
      // A People read is the whole address book, not a hand-picked subset. This
      // flag is the sole gate on the partial-read copy and its "Check more"
      // remedy, which would re-run the read and return the identical set.
      limited: false,
      truncated: hasMore || contacts.length > limit,
      totalAvailable: totalPeople || contacts.length,
    };
  };
}
